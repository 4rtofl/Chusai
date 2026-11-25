// What Chusai writes: one comment per pull request (rewritten on later runs) and the job summary.
import type { ClaudeRun } from "./claude.ts";
import type { CommandResult } from "./commands.ts";
import { describeFindings, type FileFindings } from "./lines.ts";
import { fenced } from "./prompt.ts";
import type { Trigger } from "./select.ts";

export type Outcome =
  // The branch already has every commit of the default branch.
  | "up-to-date"
  // It merges without conflicts (and, after a push to the default branch, the merge passes the verify commands).
  | "clean"
  // The merge fails the verify commands, but so may the branch alone: its own CI is not green, so it is not Chusai's.
  | "pr-ci-not-green"
  // The last comment already asks a person about this same head; Claude is not asked again until the branch changes.
  | "waiting-human"
  | "resolved"
  | "needs-human"
  // Someone pushed to the branch meanwhile; that push starts another run.
  | "push-rejected"
  // Chusai's own run broke (Claude Code failed, the push was refused for another reason). Nothing is written to the
  // pull request, the job fails, and the next run tries again.
  | "failed";

export interface Report {
  repository: string;
  number: number;
  title: string;
  url: string;
  branch: string;
  trigger: Trigger;
  defaultBranch: string;
  headSha: string;
  mainSha: string;
  outcome: Outcome;
  // Why a person has to decide (needs-human), or why nothing was done.
  reason: string | null;
  conflicted: string[];
  // The verify command that failed on the clean merge (a push to the default branch only).
  drift: CommandResult | null;
  claude: ClaudeRun | null;
  // The verify commands run on the commit that would be pushed.
  verify: CommandResult[];
  commit: string | null;
  pushed: boolean;
  dryRun: boolean;
  // The resolution as `git show --cc` prints it: the lines that differ from both parents.
  diff: string | null;
  // The line check of the resolved conflicts (null when there was no conflict, or it did not get that far).
  lines: FileFindings[] | null;
  runUrl: string | null;
}

export type CommentState = "resolved" | "needs-human" | "settled";

const MARKER_PATTERN = /<!-- chusai state=([\w-]+) head=([0-9a-f]+) main=([0-9a-f]+) -->/;

export function marker(state: CommentState, head: string, main: string): string {
  return `<!-- chusai state=${state} head=${head} main=${main} -->`;
}

export function parseMarker(body: string | undefined): { state: CommentState; head: string; main: string } | null {
  const match = body?.match(MARKER_PATTERN);
  if (!match) return null;
  const [, state, head, main] = match;
  if (state !== "resolved" && state !== "needs-human" && state !== "settled") return null;
  return { state, head: head!, main: main! };
}

const short = (sha: string) => sha.slice(0, 7);
const code = (text: string) => `\`${text.replaceAll("`", "'")}\``;

function verifyLine(results: CommandResult[]): string {
  return results
    .map((result) => `${code(result.command)} ${result.ok ? (result.flaky ? "通った（1 回目は落ち、流し直して通った）" : "通った") : "落ちた"}`)
    .join("、");
}

function cost(claude: ClaudeRun | null): string | null {
  if (!claude) return null;
  const parts = [
    claude.costUsd !== null ? `$${claude.costUsd.toFixed(2)}` : null,
    claude.turns !== null ? `${claude.turns} ターン` : null,
    `${Math.round(claude.durationMs / 60_000)} 分`,
  ].filter(Boolean);
  return `Claude: ${parts.join("・")}`;
}

function footer(report: Report): string {
  const parts = [cost(report.claude), report.runUrl ? `[実行のログ](${report.runUrl})` : null].filter(Boolean);
  return parts.length ? `<sub>${parts.join(" ・ ")}</sub>` : "";
}

function fileTable(report: Report): string[] {
  const files = report.claude?.verdict?.files ?? [];
  if (files.length === 0) return [];
  return ["| ファイル | 解消 |", "|---|---|", ...files.map((file) => `| ${code(file.path)} | ${file.decision.replaceAll("|", "\\|").replaceAll("\n", " ")} |`), ""];
}

function lineCheck(report: Report): string[] {
  if (!report.lines) return [];
  const count = report.lines.reduce((sum, file) => sum + file.droppedFromBranch.length + file.droppedFromMain.length + file.duplicated.length, 0);
  return [
    "<details>",
    `<summary>行の照合（両側が足した行が結果に残っているか${count ? `。${count} 行が当たった` : ""}）</summary>`,
    "",
    fenced(describeFindings(report.lines, report.defaultBranch)),
    "",
    "</details>",
    "",
  ];
}

function failedOutput(results: CommandResult[]): string[] {
  const failed = results.find((result) => !result.ok);
  if (!failed) return [];
  return ["<details>", `<summary>${code(failed.command)} の出力の末尾</summary>`, "", fenced(failed.tail), "", "</details>", ""];
}

// The pull request comment for an outcome, or null when the outcome does not change what the comment should say.
export function commentBody(report: Report, previous: CommentState | null): string | null {
  const main = `${code(report.defaultBranch)}（${code(short(report.mainSha))}）`;
  const verdict = report.claude?.verdict ?? null;
  if (report.outcome === "resolved" && report.pushed && report.commit) {
    const what = report.conflicted.length
      ? `${main} をこのブランチにマージし、衝突した ${report.conflicted.length} ファイルを解消して push しました（${code(short(report.commit))}）。`
      : `${main} をこのブランチにマージすると ${code(report.drift?.command ?? "検証")} が落ちたので、直して push しました（${code(short(report.commit))}）。`;
    return [
      marker("resolved", report.commit, report.mainSha),
      "### Chusai: main を取り込みました",
      "",
      what,
      "",
      ...(verdict?.summary ? ["**解消の方針**", "", verdict.summary, ""] : []),
      ...fileTable(report),
      `検証: ${verifyLine(report.verify)}`,
      "",
      ...lineCheck(report),
      "手元のブランチは、push の前に `git pull` で取り込んでください。",
      "",
      footer(report),
    ].join("\n");
  }
  if (report.outcome === "needs-human") {
    const questions = verdict?.outcome === "needs_human" ? verdict.questions : [];
    return [
      marker("needs-human", report.headSha, report.mainSha),
      "### Chusai: main の取り込みに判断が要ります",
      "",
      report.conflicted.length
        ? `${main} をこのブランチにマージすると、次のファイルが衝突します。Chusai は push していません。`
        : `${main} をこのブランチにマージすると ${code(report.drift?.command ?? "検証")} が落ちます。Chusai は push していません。`,
      "",
      ...report.conflicted.map((file) => `- ${code(file)}`),
      ...(report.conflicted.length ? [""] : []),
      ...(report.reason ? [`**push しなかった理由**: ${report.reason}`, ""] : []),
      ...(questions.length ? ["**判断してほしいこと**", "", ...questions.map((question) => `- ${question}`), ""] : []),
      ...(verdict?.summary ? ["<details>", "<summary>Claude が試した解消</summary>", "", verdict.summary, "", ...fileTable(report), "</details>", ""] : []),
      ...failedOutput(report.verify.length ? report.verify : report.drift ? [report.drift] : []),
      `手元で ${code(report.defaultBranch)} を取り込んで解消し、push してください。このブランチに push すると、Chusai がもう一度確かめます。`,
      "",
      footer(report),
    ].join("\n");
  }
  if ((report.outcome === "up-to-date" || report.outcome === "clean") && previous === "needs-human") {
    return [
      marker("settled", report.headSha, report.mainSha),
      "### Chusai: main の取り込みは済んでいます",
      "",
      `${code(short(report.headSha))} で、${main} との衝突は解消されています。`,
      "",
      footer(report),
    ].join("\n");
  }
  return null;
}

const OUTCOME_TEXT: Record<Outcome, string> = {
  "up-to-date": "取り込み済み（何もしない）",
  clean: "衝突なし（何もしない）",
  "pr-ci-not-green": "PR 自身の CI が通っていないので触らない",
  "waiting-human": "前回人の判断を求めたまま PR が変わっていないので、Claude を呼ばない",
  resolved: "解消した",
  "needs-human": "人の判断が要る（push しない）",
  "push-rejected": "push の前に、ほかの push でブランチが進んだ（何もしない）",
  failed: "Chusai の実行が失敗した（push もコメントもしない。次の実行でやり直す）",
};

const MAX_DIFF_CHARS = 60_000;

export function summaryMarkdown(report: Report): string {
  const verdict = report.claude?.verdict ?? null;
  let outcome = OUTCOME_TEXT[report.outcome];
  if (report.outcome === "resolved") outcome = report.pushed ? `解消して push した（${code(short(report.commit ?? ""))}）` : "解消した（dry-run なので push しない）";
  const lines = [
    `## #${report.number} ${report.title.replaceAll("\n", " ")}`,
    "",
    `- 結果: **${outcome}**`,
    `- きっかけ: ${report.trigger === "push" ? `${report.defaultBranch} への push` : "PR のイベント"}${report.dryRun ? "（dry-run）" : ""}`,
    `- ブランチ: ${code(report.branch)}（${code(short(report.headSha))}） ← ${code(report.defaultBranch)}（${code(short(report.mainSha))}）`,
  ];
  if (report.reason) lines.push(`- 理由: ${report.reason}`);
  if (report.conflicted.length) lines.push(`- 衝突したファイル: ${report.conflicted.map(code).join("、")}`);
  if (report.drift) lines.push(`- マージした結果で落ちた検証: ${code(report.drift.command)}`);
  if (report.verify.length) lines.push(`- 解消後の検証: ${verifyLine(report.verify)}`);
  const claudeLine = cost(report.claude);
  if (claudeLine) lines.push(`- ${claudeLine}`);
  if (report.claude?.error) lines.push(`- Claude のエラー: ${report.claude.error}`);
  lines.push("");
  if (verdict) {
    lines.push(`**Claude の判定**: ${verdict.outcome === "resolved" ? "解消した" : "人の判断が要る"}`, "", verdict.summary, "");
    lines.push(...fileTable(report));
    if (verdict.questions.length) lines.push("**判断してほしいこと**", "", ...verdict.questions.map((question) => `- ${question}`), "");
  }
  lines.push(...lineCheck(report));
  lines.push(...failedOutput(report.verify.length ? report.verify : report.drift && report.outcome !== "clean" ? [report.drift] : []));
  if (report.diff) {
    const diff = report.diff.length > MAX_DIFF_CHARS ? `${report.diff.slice(0, MAX_DIFF_CHARS)}\n…（${report.diff.length - MAX_DIFF_CHARS} 文字を省略）` : report.diff;
    lines.push("<details>", "<summary>解消の差分（両方の親と違う行。<code>git show --cc</code>）</summary>", "", fenced(diff), "", "</details>", "");
  }
  return lines.join("\n");
}
