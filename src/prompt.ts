import { readFile } from "node:fs/promises";
import type { CommandResult } from "./commands.ts";
import type { Config } from "./config.ts";

const TEMPLATE = new URL("../prompts/resolve.md", import.meta.url);

export type Task = { kind: "conflict"; files: string[] } | { kind: "drift"; failure: CommandResult };

export interface PromptContext {
  repository: string;
  number: number;
  title: string;
  branch: string;
  headSha: string;
  defaultBranch: string;
  mainSha: string;
  task: Task;
  config: Config;
}

const code = (text: string) => `\`${text.replaceAll("`", "'")}\``;

// A fence longer than any run of backticks in the text, so that test output cannot close it early.
export function fenced(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}\n${text}\n${fence}`;
}

export function taskSection(task: Task, defaultBranch: string): string {
  if (task.kind === "conflict") {
    return [
      "## やること",
      "",
      `\`${defaultBranch}\` とのマージで、次のファイルが衝突しています。解消してください。`,
      "",
      ...task.files.map((file) => `- ${code(file)}`),
      "",
      "衝突していないファイルでも、手順 4 の食い違いを見てください。",
    ].join("\n");
  }
  return [
    "## やること",
    "",
    `マージは衝突しませんでしたが、マージした結果で ${code(task.failure.command)} が落ちました。` +
      `PR のブランチだけの CI は通っているので、\`${defaultBranch}\` の変更と PR の変更が食い違っています` +
      `（例: \`${defaultBranch}\` で改名・削除された名前を、PR が古い名前のまま使っている）。` +
      `PR 側を \`${defaultBranch}\` に合わせて直してください。\`${defaultBranch}\` 側の変更は戻さないでください。`,
    "",
    "出力の末尾:",
    "",
    fenced(task.failure.tail),
  ].join("\n");
}

export async function buildPrompt(context: PromptContext): Promise<string> {
  const template = await readFile(TEMPLATE, "utf8");
  const list = (commands: string[]) => (commands.length ? commands.map(code).join("、") : "なし");
  const values: Record<string, string> = {
    repository: context.repository,
    number: String(context.number),
    title: context.title.replaceAll("\n", " "),
    branch: context.branch,
    headSha: context.headSha,
    defaultBranch: context.defaultBranch,
    mainSha: context.mainSha,
    task: taskSection(context.task, context.defaultBranch),
    install: list(context.config.install),
    verify: list(context.config.verify),
    lockfile: context.config.lockfile ? code(context.config.lockfile) : "なし",
  };
  // One pass, so that text from the pull request (its title, test output) is never itself expanded.
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => values[key] ?? match);
}
