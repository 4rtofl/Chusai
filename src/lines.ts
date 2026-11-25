// The mechanical check of a resolution: lines either side added that are no longer in the result, and lines the result
// has more often than either side. Neither is wrong by itself (a line may have been rewritten on purpose), so the
// findings are shown to Claude and to the people reading the result, not used to refuse a push.
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Git } from "./git.ts";

export interface FileFindings {
  file: string;
  // Lines the pull request's branch added that the result lacks.
  droppedFromBranch: string[];
  // Lines the default branch added that the result lacks.
  droppedFromMain: string[];
  // Lines that appear more often in the result than in either side.
  duplicated: string[];
}

// Lines too common to say anything: brackets, `});`, `---`, short keywords.
function meaningful(line: string): boolean {
  return line.length >= 6 && /[\p{L}\p{N}]/u.test(line);
}

function added(diff: string): string[] {
  const lines = diff
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1).trim())
    .filter(meaningful);
  return [...new Set(lines)];
}

function counts(text: string): Map<string, number> {
  const map = new Map<string, number>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (meaningful(trimmed)) map.set(trimmed, (map.get(trimmed) ?? 0) + 1);
  }
  return map;
}

async function show(git: Git, ref: string, file: string): Promise<string> {
  const result = await git.raw(["show", `${ref}:${file}`], { allowFailure: true });
  return result.code === 0 ? result.stdout : "";
}

export async function checkLines(git: Git, files: string[]): Promise<FileFindings[]> {
  const base = await git.out(["merge-base", "HEAD", "MERGE_HEAD"]);
  const findings: FileFindings[] = [];
  for (const file of files) {
    let result: string;
    try {
      result = await readFile(path.join(git.cwd, file), "utf8");
    } catch {
      continue; // deleted by the resolution; nothing to compare
    }
    const missing = async (side: string) => {
      const diff = (await git.raw(["diff", "--no-color", "--no-ext-diff", "-U0", base, side, "--", file])).stdout;
      return added(diff).filter((line) => !result.includes(line));
    };
    const ours = counts(await show(git, "HEAD", file));
    const theirs = counts(await show(git, "MERGE_HEAD", file));
    const duplicated = [...counts(result)]
      .filter(([line, count]) => count > Math.max(ours.get(line) ?? 0, theirs.get(line) ?? 0))
      .map(([line]) => line);
    const entry = { file, droppedFromBranch: await missing("HEAD"), droppedFromMain: await missing("MERGE_HEAD"), duplicated };
    if (entry.droppedFromBranch.length || entry.droppedFromMain.length || entry.duplicated.length) findings.push(entry);
  }
  return findings;
}

export function describeFindings(findings: FileFindings[], defaultBranch: string, limit = 20): string {
  if (findings.length === 0) return "両側が足した行はすべて結果に残っていて、どちらよりも多く入った行もありません。";
  const lines: string[] = [];
  const list = (title: string, items: string[]) => {
    if (items.length === 0) return;
    lines.push(`  ${title}（${items.length} 行）`);
    for (const item of items.slice(0, limit)) lines.push(`    ${item}`);
    if (items.length > limit) lines.push(`    …ほか ${items.length - limit} 行`);
  };
  for (const finding of findings) {
    lines.push(finding.file);
    list("PR のブランチが足したのに結果に無い行", finding.droppedFromBranch);
    list(`${defaultBranch} が足したのに結果に無い行`, finding.droppedFromMain);
    list("どちらの側よりも多く入った行", finding.duplicated);
  }
  return lines.join("\n");
}
