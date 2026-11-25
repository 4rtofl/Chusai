import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { claudeArgs, parseVerdict, startIdentityTokenFile } from "../src/claude.ts";
import { claudeAuthEnv, runAll, untrustedEnv } from "../src/commands.ts";
import { DEFAULT_CONFIG, parseConfig } from "../src/config.ts";
import { buildPrompt } from "../src/prompt.ts";

test("Claude may stage and run the repository's commands, but not commit, push or reach the network", () => {
  const args = claudeArgs({ model: "claude-opus-5-5", maxBudgetUsd: 5, commands: ["npm ci", "npm test"] });
  const allowed = args.slice(args.indexOf("--allowedTools") + 1, args.indexOf("--disallowedTools"));
  assert.ok(allowed.includes("Bash(git add:*)"));
  assert.ok(allowed.includes("Bash(npm test:*)"));
  assert.ok(!allowed.some((tool) => /push|commit|curl|^Bash\(gh /.test(tool)));
  assert.ok(!allowed.includes("WebFetch") && !allowed.includes("Bash"));
  const denied = args.slice(args.indexOf("--disallowedTools") + 1);
  for (const tool of ["Bash(git commit:*)", "Bash(git push:*)", "Bash(git merge:*)", "Bash(git reset:*)"]) assert.ok(denied.includes(tool), tool);
  assert.equal(args[args.indexOf("--permission-mode") + 1], "dontAsk");
});

test("the pull request's commands get no GitHub or Claude credentials; Claude Code gets only the Claude settings that are set", () => {
  const given = {
    CHUSAI_GITHUB_TOKEN: "t",
    GH_TOKEN: "t",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "t",
    ANTHROPIC_API_KEY: "sgk_a.sgu_b",
    ANTHROPIC_BASE_URL: "https://si.sigw.4rtofl.org/anthropic",
    ANTHROPIC_FEDERATION_RULE_ID: "",
    NODE_AUTH_TOKEN: "read-packages",
    PATH: "/bin",
  };
  assert.deepEqual(untrustedEnv(given), { NODE_AUTH_TOKEN: "read-packages", PATH: "/bin" });
  assert.deepEqual(claudeAuthEnv(given), { ANTHROPIC_API_KEY: "sgk_a.sgu_b", ANTHROPIC_BASE_URL: "https://si.sigw.4rtofl.org/anthropic" });
});

test("a command that fails once and then passes counts as passed; one that keeps failing does not", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "chusai-flaky-"));
  try {
    const options = { cwd: dir, env: process.env, timeoutMs: 10_000 };
    const [flaky] = await runAll(["if [ -e seen ]; then exit 0; else touch seen; echo first; exit 1; fi"], options);
    assert.equal(flaky?.ok, true);
    assert.equal(flaky?.flaky, true);
    assert.match(flaky?.tail ?? "", /first/);
    const results = await runAll(["false", "true"], options);
    assert.equal(results.length, 1);
    assert.equal(results[0]?.ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the identity token file holds a GitHub OIDC token for the Claude API audience", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "chusai-wif-"));
  const requested: URL[] = [];
  const fakeFetch = (async (url: URL) => {
    requested.push(url);
    return new Response(JSON.stringify({ value: "jwt-1" }));
  }) as typeof fetch;
  const identity = await startIdentityTokenFile({ ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.example/x?a=1", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "r" }, dir, fakeFetch);
  try {
    assert.equal(requested[0]?.searchParams.get("audience"), "https://api.anthropic.com");
    assert.equal(requested[0]?.searchParams.get("a"), "1");
    assert.equal(readFileSync(identity.env.ANTHROPIC_IDENTITY_TOKEN_FILE ?? "", "utf8"), "jwt-1");
    assert.equal(identity.env.ANTHROPIC_PROFILE, "default");
  } finally {
    await identity.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a verdict without the required fields is no verdict", () => {
  assert.equal(parseVerdict({ outcome: "resolved", summary: "x", files: [] }), null);
  assert.equal(parseVerdict({ outcome: "maybe", summary: "x", files: [], questions: [] }), null);
  assert.equal(parseVerdict({ outcome: "needs_human", summary: "x", files: [], questions: ["q"] })?.questions[0], "q");
});

test("text from the pull request is not expanded as a placeholder", async () => {
  const prompt = await buildPrompt({
    repository: "o/r",
    number: 1,
    title: "{{task}} in the title",
    branch: "feat",
    headSha: "a",
    defaultBranch: "main",
    mainSha: "b",
    task: { kind: "conflict", files: ["x.ts"] },
    config: DEFAULT_CONFIG,
  });
  assert.match(prompt, /「\{\{task\}\} in the title」/);
  assert.doesNotMatch(prompt, /\{\{(?!task\}\} in)/);
});

test("settings: defaults for missing keys, and mistakes are rejected", () => {
  assert.deepEqual(parseConfig({}, "c.json"), DEFAULT_CONFIG);
  assert.equal(parseConfig({ lockfile: null }, "c.json").lockfile, null);
  assert.throws(() => parseConfig({ verfy: [] }, "c.json"), /unknown key "verfy"/);
  assert.throws(() => parseConfig({ verify: [] }, "c.json"), /at least one/);
  assert.throws(() => parseConfig({ install: "npm ci" }, "c.json"), /array of commands/);
  assert.throws(() => parseConfig({ maxBudgetUsd: 0 }, "c.json"), /positive number/);
});
