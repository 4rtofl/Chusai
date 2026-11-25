// Brings the default branch into one pull request's branch: merges it, has Claude resolve the conflicts (or, after a
// push to the default branch, the verify failures a clean merge brings), verifies the result itself and pushes the
// merge commit. When it cannot vouch for the result, it pushes nothing and asks in a comment instead.
import type { ClaudeRun } from "./claude.ts";
import { runAll, untrustedEnv, type Env } from "./commands.ts";
import type { Config } from "./config.ts";
import type { Git } from "./git.ts";
import type { CheckRun, GitHubApi, IssueComment } from "./github.ts";
import { checkLines } from "./lines.ts";
import { buildPrompt, type Task } from "./prompt.ts";
import { commentBody, parseMarker, type CommentState, type Report } from "./render.ts";
import { exclusion, type Trigger } from "./select.ts";

export interface ResolveParams {
  github: GitHubApi;
  git: Git;
  config: Config;
  env: Env;
  defaultBranch: string;
  number: number;
  trigger: Trigger;
  dryRun: boolean;
  runUrl: string | null;
  author: { name: string; email: string };
  claude: (prompt: string, commands: string[]) => Promise<ClaudeRun>;
  echo?: boolean;
}

export interface ResolveResult {
  report: Report | null;
  // The comment Chusai wrote, or in a dry run would have written.
  comment: string | null;
  skipped: string | null;
}

// Green means every check run of the head finished and none failed. No check runs at all is not green: then nothing
// says the branch passes on its own.
export function ciIsGreen(runs: CheckRun[]): boolean {
  if (runs.length === 0) return false;
  return runs.every((run) => run.status === "completed" && ["success", "neutral", "skipped"].includes(run.conclusion ?? ""));
}

export function lastChusaiComment(comments: IssueComment[]): { comment: IssueComment; state: CommentState; head: string } | null {
  for (const comment of [...comments].reverse()) {
    if (comment.user?.type !== "Bot") continue;
    const found = parseMarker(comment.body);
    if (found) return { comment, state: found.state, head: found.head };
  }
  return null;
}

export async function resolvePull(params: ResolveParams): Promise<ResolveResult> {
  const { github, git, config, defaultBranch, number, trigger, dryRun } = params;
  const pull = await github.pull(number);
  const excluded = exclusion(pull, github.repository, defaultBranch, config);
  if (excluded) return { report: null, comment: null, skipped: excluded };
  if (!(await git.isClean())) throw new Error(`${git.cwd} has uncommitted changes; Chusai needs a checkout of its own`);

  const branch = pull.head.ref;
  await git.fetch(defaultBranch, branch);
  const headSha = await git.checkoutDetached(`refs/remotes/origin/${branch}`);
  const mainSha = await git.rev(`refs/remotes/origin/${defaultBranch}`);
  const commands = [...config.install, ...config.verify, ...(config.lockfile ? [config.lockfile] : [])];
  const env = untrustedEnv(params.env);
  const timeoutMs = config.commandTimeoutMinutes * 60_000;
  const echo = params.echo ?? false;

  const report: Report = {
    repository: github.repository,
    number,
    title: pull.title,
    url: pull.html_url,
    branch,
    trigger,
    defaultBranch,
    headSha,
    mainSha,
    outcome: "clean",
    reason: null,
    conflicted: [],
    drift: null,
    mergeCheck: [],
    claude: null,
    verify: [],
    commit: null,
    pushed: false,
    dryRun,
    diff: null,
    lines: null,
    runUrl: params.runUrl,
  };

  const previous = lastChusaiComment(await github.issueComments(number));
  const finish = async (): Promise<ResolveResult> => {
    await git.abortMerge();
    const body = commentBody(report, previous?.state ?? null);
    if (body && !dryRun) {
      if (previous) await github.updateComment(previous.comment.id, body);
      else await github.createComment(number, body);
    }
    return { report, comment: body, skipped: null };
  };

  if (await git.isAncestor(mainSha, headSha)) {
    report.outcome = "up-to-date";
    return finish();
  }
  if (previous?.state === "needs-human" && previous.head === headSha) {
    report.outcome = "waiting-human";
    return finish();
  }

  try {
    const { conflicted } = await git.merge(`refs/remotes/origin/${defaultBranch}`);
    report.conflicted = conflicted;
    let task: Task;
    if (conflicted.length > 0) {
      task = { kind: "conflict", files: conflicted };
    } else {
      // A pull request event runs the repository's own CI on the merge with the default branch, which catches what a
      // clean merge breaks. Only a push to the default branch leaves open pull requests unchecked.
      if (trigger === "pull_request") return await finish();
      const results = await runAll([...config.install, ...config.verify], { cwd: git.cwd, env, timeoutMs, echo });
      report.mergeCheck = results;
      const failure = results.find((result) => !result.ok);
      if (!failure) return await finish();
      report.drift = failure;
      if (!ciIsGreen(await github.checkRuns(headSha))) {
        report.outcome = "pr-ci-not-green";
        return await finish();
      }
      task = { kind: "drift", failure };
    }

    const prompt = await buildPrompt({
      repository: github.repository,
      number,
      title: pull.title,
      branch,
      headSha,
      defaultBranch,
      mainSha,
      task,
      config,
    });
    report.claude = await params.claude(prompt, commands);
    const verdict = report.claude.verdict;
    if (!verdict && report.claude.stoppedBy === "failure") {
      report.outcome = "failed";
      report.reason = report.claude.error;
      return await finish();
    }
    if (!verdict || verdict.outcome === "needs_human") {
      report.outcome = "needs-human";
      report.reason = report.claude.error ?? "Claude が、どちらの変更を残すかをコードとコミットから決められませんでした。";
      return await finish();
    }

    const problem = await checkResolution(git, headSha, mainSha, conflicted);
    if (problem) {
      report.outcome = "needs-human";
      report.reason = problem;
      return await finish();
    }
    if (conflicted.length) report.lines = await checkLines(git, conflicted);
    const message = `Merge branch '${defaultBranch}' into ${branch}\n\n${verdict.summary}`;
    report.commit = await git.commit(message, params.author);
    report.diff = (await git.raw(["show", "--cc", "--no-color", "--format=", "HEAD"])).stdout.trim() || null;
    report.verify = await runAll([...config.install, ...config.verify], { cwd: git.cwd, env, timeoutMs, echo });
    if (report.verify.some((result) => !result.ok)) {
      report.outcome = "needs-human";
      report.reason = "Claude は解消したと判定しましたが、解消した結果で検証が通りませんでした。";
      return await finish();
    }
    report.outcome = "resolved";
    if (!dryRun) {
      const push = await git.push(branch);
      if (!push.pushed) {
        console.log(push.message);
        // A race with someone's push is expected and settles itself; any other refusal (permissions, a protected
        // branch) needs someone to look at the run.
        const race = /non-fast-forward|fetch first|stale info/.test(push.message);
        report.outcome = race ? "push-rejected" : "failed";
        if (!race) report.reason = `push できませんでした: ${push.message.split("\n").slice(-3).join(" / ")}`;
        return await finish();
      }
      report.pushed = true;
    }
    return await finish();
  } finally {
    await git.abortMerge();
  }
}

// What is wrong with the merge Claude left, or null when it can be committed.
async function checkResolution(git: Git, headSha: string, mainSha: string, conflicted: string[]): Promise<string | null> {
  if ((await git.rev("HEAD")) !== headSha || (await git.mergeHead()) !== mainSha) {
    return "Claude がマージの途中の状態を変えました（commit・abort など）。";
  }
  await git.stageTracked();
  const unmerged = await git.unmerged();
  if (unmerged.length) return `未解消のファイルが残っています: ${unmerged.join(", ")}`;
  const marked = await git.withMarkers(conflicted);
  if (marked.length) return `衝突の印（<<<<<<< / >>>>>>>）が残っています: ${marked.join(", ")}`;
  return null;
}
