// The few GitHub REST calls Chusai makes, over fetch, with the installation token of the GitHub App.
const API = process.env.GITHUB_API_URL ?? "https://api.github.com";

export interface PullRequest {
  number: number;
  title: string;
  state: string;
  draft: boolean;
  html_url: string;
  user: { login: string } | null;
  labels: { name: string }[];
  head: { sha: string; ref: string; repo: { full_name: string } | null };
  base: { sha: string; ref: string };
}

export interface IssueComment {
  id: number;
  body?: string;
  user: { login: string; type: string } | null;
}

export interface CheckRun {
  name: string;
  status: string;
  conclusion: string | null;
}

export class GitHubError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// What the rest of Chusai needs from GitHub, so that tests can stand in for it.
export interface GitHubApi {
  readonly repository: string;
  defaultBranch(): Promise<string>;
  pull(number: number): Promise<PullRequest>;
  openPulls(base: string): Promise<PullRequest[]>;
  commitsBehind(head: string, base: string): Promise<number | null>;
  fileAt(file: string, ref: string): Promise<string | null>;
  checkRuns(sha: string): Promise<CheckRun[]>;
  issueComments(number: number): Promise<IssueComment[]>;
  createComment(number: number, body: string): Promise<IssueComment>;
  updateComment(id: number, body: string): Promise<IssueComment>;
  botUserId(login: string): Promise<number | null>;
}

export class GitHub implements GitHubApi {
  readonly repository: string;
  readonly #token: string;

  constructor(repository: string, token: string) {
    const [owner, repo] = repository.split("/");
    if (!owner || !repo) throw new Error(`owner/repo is expected, got "${repository}"`);
    this.repository = repository;
    this.#token = token;
  }

  async #request<T>(method: string, route: string, body?: unknown): Promise<T> {
    const url = route.startsWith("/repos/") || route.startsWith("/users/") ? `${API}${route}` : `${API}/repos/${this.repository}${route}`;
    const response = await fetch(url, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${this.#token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "chusai",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      throw new GitHubError(response.status, `${method} ${route}: ${response.status} ${await response.text()}`);
    }
    return (response.status === 204 ? undefined : await response.json()) as T;
  }

  async #paginate<T>(route: string, pick: (page: unknown) => T[] = (page) => page as T[]): Promise<T[]> {
    const items: T[] = [];
    const separator = route.includes("?") ? "&" : "?";
    for (let page = 1; ; page++) {
      const batch = pick(await this.#request<unknown>("GET", `${route}${separator}per_page=100&page=${page}`));
      items.push(...batch);
      if (batch.length < 100) return items;
    }
  }

  async defaultBranch(): Promise<string> {
    const repo = await this.#request<{ default_branch: string }>("GET", `/repos/${this.repository}`);
    return repo.default_branch;
  }

  pull(number: number): Promise<PullRequest> {
    return this.#request("GET", `/pulls/${number}`);
  }

  openPulls(base: string): Promise<PullRequest[]> {
    return this.#paginate(`/pulls?state=open&base=${encodeURIComponent(base)}`);
  }

  // How many commits `base` has that `head` does not, or null when GitHub cannot compare them.
  async commitsBehind(head: string, base: string): Promise<number | null> {
    try {
      const comparison = await this.#request<{ ahead_by: number }>(
        "GET",
        `/compare/${encodeURIComponent(head)}...${encodeURIComponent(base)}`,
      );
      return comparison.ahead_by;
    } catch (error) {
      if (error instanceof GitHubError && (error.status === 404 || error.status === 422)) return null;
      throw error;
    }
  }

  // A file of the repository at a ref, or null when it is not there.
  async fileAt(file: string, ref: string): Promise<string | null> {
    const route = `/contents/${file.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`;
    try {
      const content = await this.#request<{ type: string; content?: string; encoding?: string }>("GET", route);
      if (content.type !== "file" || content.encoding !== "base64" || content.content === undefined) return null;
      return Buffer.from(content.content, "base64").toString("utf8");
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return null;
      throw error;
    }
  }

  checkRuns(sha: string): Promise<CheckRun[]> {
    return this.#paginate(`/commits/${sha}/check-runs?filter=latest`, (page) => (page as { check_runs: CheckRun[] }).check_runs);
  }

  issueComments(number: number): Promise<IssueComment[]> {
    return this.#paginate(`/issues/${number}/comments`);
  }

  createComment(number: number, body: string): Promise<IssueComment> {
    return this.#request("POST", `/issues/${number}/comments`, { body });
  }

  updateComment(id: number, body: string): Promise<IssueComment> {
    return this.#request("PATCH", `/issues/comments/${id}`, { body });
  }

  // The user ID behind an App's bot account (`chusai[bot]`), which its commits need for their noreply address.
  async botUserId(login: string): Promise<number | null> {
    try {
      const user = await this.#request<{ id: number }>("GET", `/users/${encodeURIComponent(login)}`);
      return user.id;
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return null;
      throw error;
    }
  }
}
