// Which pull requests a run looks at. A push to the default branch can break any open pull request, so it looks at all
// of them; a pull request event only at that pull request. Drafts are included: the pull requests opened by agents
// start as drafts and are the ones most likely to be built on an old main.
import type { Config } from "./config.ts";
import type { GitHubApi, PullRequest } from "./github.ts";

export type Trigger = "push" | "pull_request";

export interface Target {
  number: number;
  trigger: Trigger;
}

// Why a pull request is left alone, or null when it is looked at.
export function exclusion(pull: PullRequest, repository: string, defaultBranch: string, config: Config): string | null {
  if (pull.state !== "open") return "閉じている";
  // A fork's branch cannot be pushed to with the App's token, and its runs get no secrets.
  if (pull.head.repo?.full_name.toLowerCase() !== repository.toLowerCase()) return "fork からの PR";
  if (pull.base.ref !== defaultBranch) return `base が ${defaultBranch} ではない（${pull.base.ref}）`;
  if (pull.labels.some((label) => label.name === config.skipLabel)) return `ラベル ${config.skipLabel} が付いている`;
  return null;
}

export interface Selection {
  targets: Target[];
  skipped: { number: number; reason: string }[];
}

export async function selectTargets(params: {
  github: GitHubApi;
  config: Config;
  defaultBranch: string;
  trigger: Trigger;
  // The pull request of a pull request event.
  number?: number;
}): Promise<Selection> {
  const { github, config, defaultBranch, trigger } = params;
  const selection: Selection = { targets: [], skipped: [] };
  if (trigger === "pull_request") {
    if (!params.number) throw new Error("a pull request event without a pull request number");
    // Read again rather than trusting the event: labels may have changed since it was sent.
    const pull = await github.pull(params.number);
    const reason = exclusion(pull, github.repository, defaultBranch, config);
    if (reason) selection.skipped.push({ number: pull.number, reason });
    else selection.targets.push({ number: pull.number, trigger });
    return selection;
  }
  for (const pull of await github.openPulls(defaultBranch)) {
    const reason = exclusion(pull, github.repository, defaultBranch, config);
    if (reason) {
      selection.skipped.push({ number: pull.number, reason });
      continue;
    }
    // A pull request that already has every commit of the default branch cannot have been broken by the push.
    const behind = await github.commitsBehind(pull.head.sha, defaultBranch);
    if (behind === 0) {
      selection.skipped.push({ number: pull.number, reason: `${defaultBranch} の最新を取り込み済み` });
      continue;
    }
    selection.targets.push({ number: pull.number, trigger });
  }
  return selection;
}
