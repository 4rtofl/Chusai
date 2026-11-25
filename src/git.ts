// The git commands of a resolution, run in the checked-out repository. Credentials are passed per command as an HTTP
// header and never written to the repository's config, where Claude and the verify commands could read them.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export class Git {
  readonly cwd: string;
  readonly #token: string | null;

  constructor(cwd: string, token: string | null) {
    this.cwd = cwd;
    this.#token = token;
  }

  #auth(): string[] {
    if (!this.#token) return [];
    const basic = Buffer.from(`x-access-token:${this.#token}`).toString("base64");
    // An empty value first drops any header that actions/checkout may have left in the config.
    return ["-c", "http.https://github.com/.extraheader=", "-c", `http.https://github.com/.extraheader=AUTHORIZATION: basic ${basic}`];
  }

  async raw(args: string[], options: { auth?: boolean; allowFailure?: boolean } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
    const full = [...(options.auth ? this.#auth() : []), ...args];
    try {
      const { stdout, stderr } = await run("git", full, { cwd: this.cwd, maxBuffer: 256 * 1024 * 1024, encoding: "utf8" });
      return { code: 0, stdout, stderr };
    } catch (error) {
      const failure = error as { code?: number | string; stdout?: string; stderr?: string };
      if (!options.allowFailure) {
        throw new Error(`git ${args.join(" ")} failed: ${failure.stderr?.trim() || String(error)}`);
      }
      return { code: typeof failure.code === "number" ? failure.code : 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
    }
  }

  async out(args: string[]): Promise<string> {
    return (await this.raw(args)).stdout.trim();
  }

  async fetch(defaultBranch: string, branch: string): Promise<void> {
    await this.raw(
      [
        "fetch",
        "--no-tags",
        "origin",
        `+refs/heads/${defaultBranch}:refs/remotes/origin/${defaultBranch}`,
        `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
      ],
      { auth: true },
    );
  }

  async checkoutDetached(ref: string): Promise<string> {
    await this.raw(["checkout", "--quiet", "--detach", ref]);
    return this.out(["rev-parse", "HEAD"]);
  }

  async rev(ref: string): Promise<string> {
    return this.out(["rev-parse", `${ref}^{commit}`]);
  }

  async isClean(): Promise<boolean> {
    return (await this.out(["status", "--porcelain", "--untracked-files=no"])) === "";
  }

  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    return (await this.raw(["merge-base", "--is-ancestor", ancestor, descendant], { allowFailure: true })).code === 0;
  }

  // Leaves the merge uncommitted either way, so that a clean merge can still be verified and fixed before committing.
  // git asks for an identity even with --no-commit, and a runner has none configured.
  async merge(ref: string, author: { name: string; email: string }): Promise<{ conflicted: string[] }> {
    // zdiff3 puts the common ancestor's lines between the markers too, so that Claude sees all three versions in place.
    const result = await this.raw(
      ["-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`, "-c", "merge.conflictStyle=zdiff3", "merge", "--no-ff", "--no-commit", ref],
      { allowFailure: true },
    );
    const conflicted = await this.unmerged();
    if (result.code !== 0 && conflicted.length === 0) {
      throw new Error(`git merge ${ref} failed without conflicts: ${result.stderr.trim() || result.stdout.trim()}`);
    }
    return { conflicted };
  }

  async unmerged(): Promise<string[]> {
    const listed = await this.out(["diff", "--name-only", "--diff-filter=U", "-z"]);
    return listed.split("\0").filter(Boolean);
  }

  async mergeHead(): Promise<string | null> {
    const result = await this.raw(["rev-parse", "-q", "--verify", "MERGE_HEAD"], { allowFailure: true });
    return result.code === 0 ? result.stdout.trim() : null;
  }

  async abortMerge(): Promise<void> {
    if (await this.mergeHead()) await this.raw(["merge", "--abort"]);
  }

  // The files among `files` that still hold conflict markers. Only the opening and closing markers count:
  // `=======` alone is a heading underline in Markdown.
  async withMarkers(files: string[]): Promise<string[]> {
    const marked: string[] = [];
    for (const file of files) {
      let text: string;
      try {
        text = await readFile(path.join(this.cwd, file), "utf8");
      } catch {
        continue; // deleted as part of the resolution
      }
      if (hasConflictMarkers(text)) marked.push(file);
    }
    return marked;
  }

  // Tracked files changed since the merge started (Claude's edits included) are staged; new files only when Claude
  // staged them itself, so that files left behind by builds and tests do not end up in the commit.
  async stageTracked(): Promise<void> {
    await this.raw(["add", "--update", "--", "."]);
  }

  // --no-verify: the repository's own hooks are for its developers' machines, not for this commit.
  async commit(message: string, author: { name: string; email: string }): Promise<string> {
    await this.raw(["-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`, "commit", "--no-verify", "-m", message]);
    return this.out(["rev-parse", "HEAD"]);
  }

  // Never forced: when someone pushed to the branch meanwhile, the remote refuses this push as not a fast-forward.
  async push(branch: string): Promise<{ pushed: boolean; message: string }> {
    const result = await this.raw(["push", "--porcelain", "origin", `HEAD:refs/heads/${branch}`], { auth: true, allowFailure: true });
    // --porcelain puts the reason of a refusal ("[rejected] (fetch first)") on stdout and git's hints on stderr.
    return { pushed: result.code === 0, message: `${result.stdout}\n${result.stderr}`.trim() };
  }
}

export function hasConflictMarkers(text: string): boolean {
  return /^(<{7}|>{7})( |$)/m.test(text);
}
