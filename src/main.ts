// Chusai's entry point. In GitHub Actions (see action.yml) everything comes from the environment:
//   node src/main.ts select             lists the pull requests to look at (the `targets` output)
//   node src/main.ts resolve --pr <n>   brings the default branch into one of them
//
// To try a resolution locally without writing to GitHub, in a clone of its own (Chusai checks out and merges there):
//   CHUSAI_GITHUB_TOKEN=$(gh auth token) node src/main.ts resolve --repo 4rtofl/Gasho --pr 261 --workspace /tmp/gasho --dry-run
// Locally, Claude Code is the `claude` on PATH with its own login, unless --claude names another executable.
import { appendFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { CLAUDE_CODE_VERSION, installClaudeCode, runClaude, startIdentityTokenFile } from "./claude.ts";
import type { Env } from "./commands.ts";
import { configFromText, type Config } from "./config.ts";
import { Git } from "./git.ts";
import { GitHub, type GitHubApi } from "./github.ts";
import { summaryMarkdown } from "./render.ts";
import { resolvePull } from "./resolve.ts";
import { selectTargets, type Trigger } from "./select.ts";

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

interface Event {
  name: string | undefined;
  number: number | undefined;
  defaultBranch: string | undefined;
}

async function readEvent(env: Env): Promise<Event> {
  const name = env.GITHUB_EVENT_NAME;
  if (!env.GITHUB_EVENT_PATH) return { name, number: undefined, defaultBranch: undefined };
  const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, "utf8")) as {
    pull_request?: { number?: number };
    repository?: { default_branch?: string };
  };
  return { name, number: event.pull_request?.number, defaultBranch: event.repository?.default_branch };
}

function triggerOf(value: string | undefined): Trigger {
  if (value === "push") return "push";
  if (value === "pull_request" || value === "pull_request_target") return "pull_request";
  throw new Error(`Chusai runs on push and pull_request events, not on "${value}"`);
}

async function loadConfig(github: GitHubApi, file: string, defaultBranch: string): Promise<Config> {
  return configFromText(await github.fileAt(file, defaultBranch), `${github.repository}:${defaultBranch}:${file}`);
}

async function writeOutput(env: Env, name: string, value: string): Promise<void> {
  if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `${name}=${value}\n`);
  else console.log(`${name}=${value}`);
}

async function writeSummary(env: Env, markdown: string): Promise<void> {
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  else console.log(markdown);
}

async function select(values: Record<string, string | boolean | undefined>, env: Env): Promise<void> {
  const event = await readEvent(env);
  const repository = required("--repo or GITHUB_REPOSITORY", (values.repo as string | undefined) ?? env.GITHUB_REPOSITORY);
  const github = new GitHub(repository, required("CHUSAI_GITHUB_TOKEN", env.CHUSAI_GITHUB_TOKEN));
  const trigger = triggerOf((values.event as string | undefined) ?? event.name);
  const defaultBranch = event.defaultBranch ?? (await github.defaultBranch());
  const config = await loadConfig(github, (values.config as string | undefined) ?? env.CHUSAI_CONFIG ?? ".github/chusai.json", defaultBranch);
  const number = values.pr ? Number(values.pr) : event.number;
  const selection = await selectTargets({ github, config, defaultBranch, trigger, ...(number ? { number } : {}) });
  await writeOutput(env, "targets", JSON.stringify(selection.targets.map((target) => target.number)));
  const lines = [
    `## Chusai: 調べる PR`,
    "",
    selection.targets.length ? selection.targets.map((target) => `- #${target.number}`).join("\n") : "なし",
  ];
  if (selection.skipped.length) {
    lines.push("", "外した PR:", "", ...selection.skipped.map((skip) => `- #${skip.number}: ${skip.reason}`));
  }
  await writeSummary(env, lines.join("\n"));
}

async function resolve(values: Record<string, string | boolean | undefined>, env: Env): Promise<void> {
  const event = await readEvent(env);
  const repository = required("--repo or GITHUB_REPOSITORY", (values.repo as string | undefined) ?? env.GITHUB_REPOSITORY);
  const token = required("CHUSAI_GITHUB_TOKEN", env.CHUSAI_GITHUB_TOKEN);
  const github = new GitHub(repository, token);
  const number = Number(required("--pr", values.pr as string | undefined));
  const inActions = env.GITHUB_ACTIONS === "true";
  const trigger = triggerOf((values.event as string | undefined) ?? event.name ?? "pull_request");
  const dryRun = values["dry-run"] === true || env.CHUSAI_DRY_RUN === "true";
  const defaultBranch = event.defaultBranch ?? (await github.defaultBranch());
  const config = await loadConfig(github, (values.config as string | undefined) ?? env.CHUSAI_CONFIG ?? ".github/chusai.json", defaultBranch);
  const workspace = path.resolve((values.workspace as string | undefined) ?? env.GITHUB_WORKSPACE ?? ".");
  const model = (values.model as string | undefined) ?? env.CHUSAI_MODEL ?? "claude-opus-5-5";
  const runUrl =
    env.GITHUB_RUN_ID && env.GITHUB_SERVER_URL ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : null;

  // The commits are the App's: `<slug>[bot]` with the bot account's noreply address, as GitHub shows App commits.
  const slug = env.CHUSAI_APP_SLUG || "chusai";
  const login = `${slug}[bot]`;
  const botId = inActions ? await github.botUserId(login) : null;
  const author = { name: login, email: botId ? `${botId}+${login}@users.noreply.github.com` : `${login}@users.noreply.github.com` };

  let executable = (values.claude as string | undefined) ?? env.CHUSAI_CLAUDE;
  const claude = async (prompt: string, commands: string[]) => {
    executable ??= inActions ? await installClaudeCode(env.CHUSAI_CLAUDE_CODE_VERSION || CLAUDE_CODE_VERSION, env) : "claude";
    let extraEnv: Env = {};
    let stop = async () => {};
    if (env.ANTHROPIC_FEDERATION_RULE_ID) {
      required("ANTHROPIC_ORGANIZATION_ID", env.ANTHROPIC_ORGANIZATION_ID);
      const identity = await startIdentityTokenFile(env, path.join(env.RUNNER_TEMP ?? os.tmpdir(), "chusai-workload-identity"));
      extraEnv = identity.env;
      stop = identity.stop;
    }
    try {
      return await runClaude({
        executable,
        cwd: workspace,
        prompt,
        model,
        maxBudgetUsd: config.maxBudgetUsd,
        timeoutMs: config.claudeTimeoutMinutes * 60_000,
        commands,
        // With federation configured, a leftover API key would take precedence over it in Claude Code.
        env: env.ANTHROPIC_FEDERATION_RULE_ID ? { ...env, ANTHROPIC_API_KEY: undefined } : env,
        extraEnv,
      });
    } finally {
      await stop();
    }
  };

  const result = await resolvePull({
    github,
    git: new Git(workspace, token),
    config,
    env,
    defaultBranch,
    number,
    trigger,
    dryRun,
    runUrl,
    author,
    claude,
    echo: inActions,
  });
  if (result.skipped) {
    await writeSummary(env, `## #${number}\n\n外した: ${result.skipped}`);
    return;
  }
  if (!result.report) return;
  let summary = summaryMarkdown(result.report);
  if (dryRun && result.comment) {
    summary += `\n<details>\n<summary>PR に書くはずだったコメント（dry-run なので書いていません）</summary>\n\n${result.comment}\n\n</details>\n`;
  }
  await writeSummary(env, summary);
  await writeOutput(env, "outcome", result.report.outcome);
  if (result.report.outcome === "failed") {
    console.error(`Chusai failed on #${number}: ${result.report.reason ?? ""}`);
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      repo: { type: "string" },
      pr: { type: "string" },
      event: { type: "string" },
      workspace: { type: "string" },
      config: { type: "string" },
      model: { type: "string" },
      claude: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });
  const env = process.env as Env;
  const command = positionals[0];
  if (command === "select") return select(values, env);
  if (command === "resolve") return resolve(values, env);
  throw new Error(`usage: node src/main.ts select|resolve [--pr <n>] ...（got "${command ?? ""}"）`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
