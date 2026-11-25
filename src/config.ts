// The per-repository settings, read from `.github/chusai.json` at the tip of the default branch. Never from the pull
// request's head: a pull request could otherwise choose the commands that decide whether its own merge gets pushed.
export interface Config {
  // Run in order before verifying, after every merge (for example `npm ci`).
  install: string[];
  // All of them must pass before Chusai pushes a merge.
  verify: string[];
  // Regenerates the lockfile from the manifests. Claude is told to run it instead of editing a conflicted lockfile.
  lockfile: string | null;
  // Pull requests with this label are left alone.
  skipLabel: string;
  // Claude stops when one resolution would cost more than this.
  maxBudgetUsd: number;
  // Claude is stopped after this long.
  claudeTimeoutMinutes: number;
  // Each install or verify command is stopped after this long.
  commandTimeoutMinutes: number;
}

export const DEFAULT_CONFIG: Config = {
  install: ["npm ci"],
  verify: ["npm run typecheck", "npm test"],
  lockfile: "npm install --package-lock-only --ignore-scripts --no-audit --no-fund",
  skipLabel: "chusai:skip",
  maxBudgetUsd: 5,
  claudeTimeoutMinutes: 30,
  commandTimeoutMinutes: 20,
};

// No file means the defaults.
export function configFromText(text: string | null, source: string): Config {
  if (text === null) return DEFAULT_CONFIG;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`${source}: not valid JSON (${(error as Error).message})`);
  }
  return parseConfig(raw, source);
}

export function parseConfig(raw: unknown, source: string): Config {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`${source}: an object is expected`);
  const value = raw as Record<string, unknown>;
  const known = new Set(Object.keys(DEFAULT_CONFIG));
  for (const key of Object.keys(value)) {
    if (key !== "$schema" && !known.has(key)) throw new Error(`${source}: unknown key "${key}"`);
  }
  const commands = (key: "install" | "verify"): string[] => {
    const field = value[key];
    if (field === undefined) return DEFAULT_CONFIG[key];
    if (!Array.isArray(field) || !field.every((item) => typeof item === "string" && item.trim() !== "")) {
      throw new Error(`${source}: "${key}" must be an array of commands`);
    }
    return field;
  };
  const positive = (key: "maxBudgetUsd" | "claudeTimeoutMinutes" | "commandTimeoutMinutes"): number => {
    const field = value[key];
    if (field === undefined) return DEFAULT_CONFIG[key];
    if (typeof field !== "number" || !Number.isFinite(field) || field <= 0) {
      throw new Error(`${source}: "${key}" must be a positive number`);
    }
    return field;
  };
  const lockfile = value.lockfile;
  if (lockfile !== undefined && lockfile !== null && (typeof lockfile !== "string" || lockfile.trim() === "")) {
    throw new Error(`${source}: "lockfile" must be a command or null`);
  }
  const skipLabel = value.skipLabel;
  if (skipLabel !== undefined && (typeof skipLabel !== "string" || skipLabel === "")) {
    throw new Error(`${source}: "skipLabel" must be a label name`);
  }
  const verify = commands("verify");
  if (verify.length === 0) throw new Error(`${source}: "verify" needs at least one command`);
  return {
    install: commands("install"),
    verify,
    lockfile: lockfile === undefined ? DEFAULT_CONFIG.lockfile : lockfile,
    skipLabel: skipLabel ?? DEFAULT_CONFIG.skipLabel,
    maxBudgetUsd: positive("maxBudgetUsd"),
    claudeTimeoutMinutes: positive("claudeTimeoutMinutes"),
    commandTimeoutMinutes: positive("commandTimeoutMinutes"),
  };
}
