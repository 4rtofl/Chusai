// Runs Claude Code (the CLI) on the checked-out merge and reads its verdict.
//
// Claude Code is run directly rather than through anthropics/claude-code-action: on pull request events that action
// restores `.claude/` and `.mcp.json` from the base branch into the working tree and points the git remote at its own
// token, neither of which may happen in the middle of a merge whose result Chusai is about to commit and push.
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { processEnv, untrustedEnv, type Env } from "./commands.ts";

export const CLAUDE_CODE_VERSION = "2.1.332";
const AUDIENCE = "https://api.anthropic.com";
// GitHub's OIDC tokens live about 5 minutes and each is exchanged once; Claude Code reads the file again whenever it
// renews its access token, so the file is rewritten more often than the token expires.
const IDENTITY_REFRESH_MS = 4 * 60 * 1000;

export interface Verdict {
  outcome: "resolved" | "needs_human";
  summary: string;
  files: { path: string; decision: string }[];
  questions: string[];
}

export interface ClaudeRun {
  // Null when Claude ended without a verdict (an error, the budget, the timeout).
  verdict: Verdict | null;
  error: string | null;
  costUsd: number | null;
  turns: number | null;
  durationMs: number;
}

export const VERDICT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["outcome", "summary", "files", "questions"],
  properties: {
    outcome: { type: "string", enum: ["resolved", "needs_human"] },
    summary: { type: "string", description: "何を正とし、なぜそう解消したか（日本語で 3 行以内）" },
    files: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "decision"],
        properties: { path: { type: "string" }, decision: { type: "string", description: "どちらの変更をどう残したか（日本語で 1 文）" } },
      },
    },
    questions: { type: "array", items: { type: "string" }, description: "needs_human のとき、人に決めてほしいこと（日本語）" },
  },
} as const;

// Commands that only read, which the resolution steps use to compare the two sides.
const READ_ONLY_BASH = [
  "git status",
  "git diff",
  "git log",
  "git show",
  "git ls-files",
  "git merge-base",
  "git merge-file",
  "git rev-parse",
  "git rev-list",
  "git cat-file",
  "git grep",
  "git blame",
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "grep",
  "sort",
  "uniq",
  "comm",
  "diff",
  "sed -n",
  "cut",
  "tr",
];

// Claude may edit files, stage them and run the repository's own commands, nothing else: no commit, no push, no
// network. Chusai commits and pushes itself after verifying the result again.
export function allowedTools(commands: string[]): string[] {
  const bash = [...READ_ONLY_BASH, "git add", "git rm", ...commands].map((command) => `Bash(${command}:*)`);
  return ["Read", "Edit", "Write", "Glob", "Grep", "TodoWrite", ...bash];
}

export function claudeArgs(params: { model: string; maxBudgetUsd: number; commands: string[] }): string[] {
  return [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    params.model,
    "--json-schema",
    JSON.stringify(VERDICT_SCHEMA),
    "--max-budget-usd",
    String(params.maxBudgetUsd),
    "--permission-mode",
    "dontAsk",
    "--tools",
    "Read,Edit,Write,Glob,Grep,Bash,TodoWrite",
    "--allowedTools",
    ...allowedTools(params.commands),
    "--disallowedTools",
    "Bash(git commit:*)",
    "Bash(git push:*)",
    "Bash(git merge:*)",
    "Bash(git reset:*)",
    "Bash(git checkout:*)",
    "Bash(git rebase:*)",
    "Bash(gh:*)",
    "Bash(curl:*)",
    // The repository's own settings and MCP servers are for its developers' machines.
    "--setting-sources",
    "user",
    "--strict-mcp-config",
    "--no-session-persistence",
  ];
}

// Workload Identity Federation: a file holding a fresh GitHub OIDC token, which Claude Code exchanges itself.
export async function startIdentityTokenFile(env: Env, dir: string, fetchImpl: typeof fetch = fetch): Promise<{ env: Env; stop: () => Promise<void> }> {
  const requestUrl = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !requestToken) {
    throw new Error("no GitHub OIDC token: the job needs `permissions: id-token: write` (Workload Identity Federation)");
  }
  const tokenFile = path.join(dir, "identity-token");
  const write = async () => {
    const url = new URL(requestUrl);
    url.searchParams.set("audience", AUDIENCE);
    const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${requestToken}` } });
    if (!response.ok) throw new Error(`GitHub OIDC token request failed: ${response.status} ${response.statusText}`);
    const body = (await response.json()) as { value?: unknown };
    if (typeof body.value !== "string" || body.value === "") throw new Error("GitHub OIDC token response has no value");
    console.log(`::add-mask::${body.value}`);
    await writeFile(tokenFile, body.value, { mode: 0o600 });
  };
  await mkdir(path.join(dir, "configs"), { recursive: true, mode: 0o700 });
  // A profile makes Claude Code cache the exchanged access token on disk instead of exchanging the one-use identity
  // token again in every process it starts.
  await writeFile(path.join(dir, "configs", "default.json"), JSON.stringify({ version: "1.0", authentication: { type: "oidc_federation" } }), {
    mode: 0o600,
  });
  await write();
  const timer = setInterval(() => {
    write().catch((error) => console.log(`::warning::GitHub OIDC token refresh failed: ${String(error)}`));
  }, IDENTITY_REFRESH_MS);
  return {
    env: { ANTHROPIC_IDENTITY_TOKEN_FILE: tokenFile, ANTHROPIC_CONFIG_DIR: dir, ANTHROPIC_PROFILE: "default" },
    stop: async () => {
      clearInterval(timer);
      await rm(dir, { recursive: true, force: true });
    },
  };
}

interface ResultMessage {
  type: "result";
  subtype: string;
  is_error?: boolean;
  result?: string;
  total_cost_usd?: number;
  num_turns?: number;
  structured_output?: unknown;
}

export function parseVerdict(value: unknown): Verdict | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (raw.outcome !== "resolved" && raw.outcome !== "needs_human") return null;
  if (typeof raw.summary !== "string" || !Array.isArray(raw.files) || !Array.isArray(raw.questions)) return null;
  const files = raw.files.filter(
    (file): file is { path: string; decision: string } =>
      typeof file === "object" && file !== null && typeof file.path === "string" && typeof file.decision === "string",
  );
  const questions = raw.questions.filter((question): question is string => typeof question === "string");
  return { outcome: raw.outcome, summary: raw.summary, files, questions };
}

// One line of the log per tool call, so that a long run shows what it is doing without dumping file contents.
function describe(message: Record<string, unknown>): string | null {
  if (message.type !== "assistant") return null;
  const content = (message.message as { content?: unknown[] } | undefined)?.content ?? [];
  const lines: string[] = [];
  for (const block of content as { type?: string; name?: string; input?: Record<string, unknown> }[]) {
    if (block.type !== "tool_use") continue;
    const input = block.input ?? {};
    const detail = input.command ?? input.file_path ?? input.pattern ?? "";
    lines.push(`[claude] ${block.name} ${String(detail).split("\n")[0]?.slice(0, 160)}`);
  }
  return lines.length ? lines.join("\n") : null;
}

export async function runClaude(params: {
  executable: string;
  cwd: string;
  prompt: string;
  model: string;
  maxBudgetUsd: number;
  timeoutMs: number;
  commands: string[];
  env: Env;
  extraEnv: Env;
}): Promise<ClaudeRun> {
  const started = Date.now();
  const env: Env = {
    ...untrustedEnv(params.env),
    ...params.extraEnv,
    // Keeps Bash from moving the session out of the repository.
    CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: "1",
    DISABLE_AUTOUPDATER: "1",
  };
  const args = claudeArgs({ model: params.model, maxBudgetUsd: params.maxBudgetUsd, commands: params.commands });
  return new Promise((resolve) => {
    const child = spawn(params.executable, args, { cwd: params.cwd, env: processEnv(env), stdio: ["pipe", "pipe", "pipe"] });
    let result: ResultMessage | null = null;
    let buffer = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        const text = describe(message);
        if (text) console.log(text);
        if (message.type === "result") result = message as unknown as ResultMessage;
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-20_000);
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
    }, params.timeoutMs);
    child.stdin.end(params.prompt);
    const finish = (error: string | null) => {
      clearTimeout(timer);
      const final = result as ResultMessage | null;
      const verdict = parseVerdict(final?.structured_output);
      let reason = error;
      if (!verdict && !reason) {
        if (timedOut) reason = `${Math.round(params.timeoutMs / 60_000)} 分で止めました`;
        else if (final?.subtype === "error_max_budget_usd") reason = `費用の上限（$${params.maxBudgetUsd}）に達しました`;
        else if (final) reason = `Claude が判定を返しませんでした（${final.subtype}）`;
        else reason = `Claude Code が結果を出さずに終わりました: ${stderr.trim().split("\n").slice(-5).join(" / ")}`;
      }
      resolve({
        verdict,
        error: verdict ? null : reason,
        costUsd: final?.total_cost_usd ?? null,
        turns: final?.num_turns ?? null,
        durationMs: Date.now() - started,
      });
    };
    child.on("close", () => finish(null));
    child.on("error", (error) => finish(`Claude Code を起動できませんでした: ${String(error)}`));
  });
}

// Installs the pinned Claude Code on the runner and returns the path of its executable.
export async function installClaudeCode(version: string, env: Env): Promise<string> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const code = await new Promise<number>((resolve) => {
      const child = spawn("bash", ["-c", `set -o pipefail; curl -fsSL https://claude.ai/install.sh | bash -s -- ${version}`], {
        stdio: "inherit",
        env: processEnv(untrustedEnv(env)),
      });
      child.on("close", (exit) => resolve(exit ?? 1));
      child.on("error", () => resolve(1));
    });
    if (code === 0) return path.join(env.HOME ?? "", ".local", "bin", "claude");
    console.log(`::warning::Claude Code install attempt ${attempt} failed`);
  }
  throw new Error(`could not install Claude Code ${version}`);
}
