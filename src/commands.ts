// Runs the repository's install and verify commands. They run the pull request's code, so they get an environment
// without Chusai's credentials.
import { spawn } from "node:child_process";

export type Env = Record<string, string | undefined>;

// Credentials that must not reach code from the pull request or Claude's commands. NODE_AUTH_TOKEN stays: it is the
// job's read-only token for private packages, which `npm ci` needs.
const SECRET_KEYS = [
  "CHUSAI_GITHUB_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_URL",
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "ACTIONS_RUNTIME_TOKEN",
  "ACTIONS_RESULTS_URL",
  "ACTIONS_CACHE_URL",
];

export function untrustedEnv(env: Env): Env {
  const copy: Env = { ...env };
  for (const key of SECRET_KEYS) delete copy[key];
  return copy;
}

// Child processes take only set values: an undefined one would reach them as the string "undefined".
export function processEnv(env: Env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

export interface CommandResult {
  command: string;
  ok: boolean;
  // The end of the combined output, which is where the error usually is.
  tail: string;
  durationMs: number;
  // It failed once and passed when run again; the first failure's output is kept in `tail`.
  flaky?: boolean;
}

const TAIL_LINES = 200;

export function runCommand(command: string, options: { cwd: string; env: Env; timeoutMs: number; echo?: boolean }): Promise<CommandResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn("bash", ["-c", command], { cwd: options.cwd, env: processEnv(options.env), stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const keep = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (options.echo) process.stdout.write(text);
      output += text;
      // Bounded, so that a chatty test suite cannot exhaust memory.
      if (output.length > 2_000_000) output = output.slice(-1_000_000);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const lines = output.trimEnd().split("\n");
      let tail = lines.slice(-TAIL_LINES).join("\n");
      if (timedOut) tail += `\n(${Math.round(options.timeoutMs / 60_000)} 分で止めました)`;
      else if (signal) tail += `\n(シグナル ${signal} で止まりました)`;
      else if (code !== 0) tail += `\n(終了コード ${code})`;
      resolve({ command, ok: code === 0 && !timedOut, tail, durationMs: Date.now() - started });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ command, ok: false, tail: String(error), durationMs: Date.now() - started });
    });
  });
}

// Runs the commands in order and stops at the first failure. A failing command is run once more: test suites that
// fail now and then (as Gasho's does) would otherwise keep every resolution from being pushed, and send clean merges
// to Claude as if they were broken.
export async function runAll(commands: string[], options: { cwd: string; env: Env; timeoutMs: number; echo?: boolean }): Promise<CommandResult[]> {
  const results: CommandResult[] = [];
  for (const command of commands) {
    if (options.echo) console.log(`::group::${command}`);
    let result = await runCommand(command, options);
    if (!result.ok) {
      if (options.echo) console.log(`::warning::${command} failed; running it once more`);
      const again = await runCommand(command, options);
      result = again.ok ? { ...again, flaky: true, tail: result.tail } : again;
    }
    if (options.echo) console.log("::endgroup::");
    results.push(result);
    if (!result.ok) break;
  }
  return results;
}
