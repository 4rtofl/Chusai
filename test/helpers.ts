import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ClaudeRun, Verdict } from "../src/claude.ts";
import { DEFAULT_CONFIG, type Config } from "../src/config.ts";
import { Git } from "../src/git.ts";
import type { CheckRun, GitHubApi, IssueComment, PullRequest } from "../src/github.ts";
import { resolvePull, type ResolveParams } from "../src/resolve.ts";

export const REPOSITORY = "o/r";

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

// A remote with `main` and a pull request branch `feat`, a clone to make commits in (as the people pushing), and a
// separate clone for Chusai to work in, as actions/checkout leaves it.
export class Fixture {
  readonly root = mkdtempSync(path.join(os.tmpdir(), "chusai-test-"));
  readonly remote = path.join(this.root, "remote.git");
  readonly people = path.join(this.root, "people");
  readonly work = path.join(this.root, "work");

  constructor(base: Record<string, string>) {
    git(this.root, "init", "--quiet", "--bare", "--initial-branch=main", this.remote);
    git(this.root, "clone", "--quiet", this.remote, this.people);
    git(this.people, "config", "user.name", "Someone");
    git(this.people, "config", "user.email", "someone@example.com");
    git(this.people, "checkout", "--quiet", "-b", "main");
    this.commit(base, "base");
    git(this.people, "push", "--quiet", "origin", "main");
    git(this.people, "checkout", "--quiet", "-b", "feat");
    git(this.people, "push", "--quiet", "origin", "feat");
    git(this.root, "clone", "--quiet", this.remote, this.work);
  }

  commit(files: Record<string, string>, message: string): string {
    for (const [file, text] of Object.entries(files)) writeFileSync(path.join(this.people, file), text);
    git(this.people, "add", ".");
    git(this.people, "commit", "--quiet", "-m", message);
    return git(this.people, "rev-parse", "HEAD");
  }

  // Commits on a branch and pushes it.
  on(branch: string, files: Record<string, string>, message: string): string {
    git(this.people, "checkout", "--quiet", branch);
    const sha = this.commit(files, message);
    git(this.people, "push", "--quiet", "origin", branch);
    return sha;
  }

  remoteHead(branch: string): string {
    return git(this.remote, "rev-parse", `refs/heads/${branch}`);
  }

  parents(sha: string): string[] {
    return git(this.remote, "rev-list", "--parents", "-n", "1", sha).split(" ").slice(1);
  }

  show(sha: string, file: string): string {
    return git(this.remote, "show", `${sha}:${file}`);
  }

  dispose(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}

export class FakeGitHub implements GitHubApi {
  readonly repository = REPOSITORY;
  readonly comments: IssueComment[] = [];
  checks: CheckRun[] = [{ name: "test", status: "completed", conclusion: "success" }];
  labels: string[] = [];
  readonly fixture: Fixture;
  #next = 1;

  constructor(fixture: Fixture) {
    this.fixture = fixture;
  }

  async defaultBranch() {
    return "main";
  }

  async pull(number: number): Promise<PullRequest> {
    return {
      number,
      title: "Add a feature",
      state: "open",
      draft: true,
      html_url: `https://github.com/${REPOSITORY}/pull/${number}`,
      user: { login: "someone" },
      labels: this.labels.map((name) => ({ name })),
      head: { sha: this.fixture.remoteHead("feat"), ref: "feat", repo: { full_name: REPOSITORY } },
      base: { sha: this.fixture.remoteHead("main"), ref: "main" },
    };
  }

  async openPulls() {
    return [await this.pull(1)];
  }

  async commitsBehind() {
    return 1;
  }

  async fileAt() {
    return null;
  }

  async checkRuns() {
    return this.checks;
  }

  async issueComments() {
    return this.comments;
  }

  async createComment(_number: number, body: string) {
    const comment = { id: this.#next++, body, user: { login: "chusai[bot]", type: "Bot" } };
    this.comments.push(comment);
    return comment;
  }

  async updateComment(id: number, body: string) {
    const comment = this.comments.find((item) => item.id === id);
    if (!comment) throw new Error(`no comment ${id}`);
    comment.body = body;
    return comment;
  }

  async botUserId() {
    return 1;
  }
}

export function verdict(overrides: Partial<Verdict> = {}): Verdict {
  return { outcome: "resolved", summary: "両方の変更を残した。", files: [{ path: "a.txt", decision: "両方の行を残した" }], questions: [], ...overrides };
}

// A stand-in for Claude: does `act` (to the working copy) and answers `answer`.
export function fakeClaude(act: () => void, answer: Verdict | null = verdict()) {
  const calls: string[] = [];
  const run = async (prompt: string): Promise<ClaudeRun> => {
    calls.push(prompt);
    act();
    return { verdict: answer, error: answer ? null : "Claude が判定を返しませんでした（error）", costUsd: 1.23, turns: 10, durationMs: 60_000 };
  };
  return { calls, run };
}

export const QUIET: Config = { ...DEFAULT_CONFIG, install: [], verify: ["true"], lockfile: null };

export function resolveIn(
  fixture: Fixture,
  github: FakeGitHub,
  claude: (prompt: string, commands: string[]) => Promise<ClaudeRun>,
  overrides: Partial<ResolveParams> = {},
) {
  return resolvePull({
    github,
    git: new Git(fixture.work, null),
    config: QUIET,
    env: process.env,
    defaultBranch: "main",
    number: 1,
    trigger: "pull_request",
    dryRun: false,
    runUrl: null,
    author: { name: "chusai[bot]", email: "1+chusai[bot]@users.noreply.github.com" },
    claude,
    ...overrides,
  });
}
