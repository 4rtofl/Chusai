import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";
import { parseMarker } from "../src/render.ts";
import { ciIsGreen } from "../src/resolve.ts";
import { FakeGitHub, Fixture, QUIET, fakeClaude, git, resolveIn, verdict } from "./helpers.ts";

let fixture: Fixture;
afterEach(() => fixture?.dispose());

// main and feat both change the same line of a.txt.
function conflicting(): Fixture {
  const made = new Fixture({ "a.txt": "one\n" });
  made.on("main", { "a.txt": "one from main\n" }, "main changes a");
  made.on("feat", { "a.txt": "one from feat\n" }, "feat changes a");
  return made;
}

const resolveBoth = () => {
  writeFileSync(path.join(fixture.work, "a.txt"), "one from main\none from feat\n");
  git(fixture.work, "add", "a.txt");
};

test("a resolved conflict is pushed as a merge of the old head and main, and the comment says so", async () => {
  fixture = conflicting();
  const github = new FakeGitHub(fixture);
  const head = fixture.remoteHead("feat");
  const main = fixture.remoteHead("main");
  const claude = fakeClaude(resolveBoth);

  const result = await resolveIn(fixture, github, claude.run);

  assert.equal(result.report?.outcome, "resolved");
  assert.equal(result.report?.pushed, true);
  const pushed = fixture.remoteHead("feat");
  assert.deepEqual(fixture.parents(pushed), [head, main]);
  assert.equal(fixture.show(pushed, "a.txt"), "one from main\none from feat");
  assert.equal(git(fixture.remote, "log", "-1", "--format=%an", pushed), "chusai[bot]");
  assert.match(claude.calls[0] ?? "", /a\.txt/);
  assert.equal(github.comments.length, 1);
  assert.deepEqual(parseMarker(github.comments[0]?.body), { state: "resolved", head: pushed, main });
});

test("the line check reports a line main added that the resolution dropped, and a line it doubled", async () => {
  fixture = new Fixture({ "a.txt": "first line\nsecond line\n" });
  fixture.on("main", { "a.txt": "first line from main\nsecond line\nshared new line\n" }, "main");
  fixture.on("feat", { "a.txt": "first line from feat\nsecond line\nshared new line\n" }, "feat");
  const github = new FakeGitHub(fixture);
  const claude = fakeClaude(() => {
    writeFileSync(path.join(fixture.work, "a.txt"), "first line from feat\nsecond line\nshared new line\nshared new line\n");
    git(fixture.work, "add", "a.txt");
  });

  const result = await resolveIn(fixture, github, claude.run, { dryRun: true });

  const [finding] = result.report?.lines ?? [];
  assert.deepEqual(finding?.droppedFromMain, ["first line from main"]);
  assert.deepEqual(finding?.droppedFromBranch, []);
  assert.deepEqual(finding?.duplicated, ["shared new line"]);
});

test("when Claude needs a person, nothing is pushed, and the same head is not given to Claude again", async () => {
  fixture = conflicting();
  const github = new FakeGitHub(fixture);
  const head = fixture.remoteHead("feat");
  const claude = fakeClaude(() => {}, verdict({ outcome: "needs_human", questions: ["a.txt の 1 行目はどちらを残しますか"] }));

  const first = await resolveIn(fixture, github, claude.run);
  assert.equal(first.report?.outcome, "needs-human");
  assert.equal(fixture.remoteHead("feat"), head);
  assert.match(github.comments[0]?.body ?? "", /a\.txt の 1 行目はどちらを残しますか/);
  assert.equal(git(fixture.work, "status", "--porcelain", "--untracked-files=no"), "", "the merge is aborted afterwards");

  const second = await resolveIn(fixture, github, claude.run, { trigger: "push" });
  assert.equal(second.report?.outcome, "waiting-human");
  assert.equal(claude.calls.length, 1);
});

test("when Claude Code itself fails, the run fails without asking anyone, so that the next run tries again", async () => {
  fixture = conflicting();
  const github = new FakeGitHub(fixture);
  const head = fixture.remoteHead("feat");
  const claude = fakeClaude(() => {}, null);

  const first = await resolveIn(fixture, github, claude.run);
  assert.equal(first.report?.outcome, "failed");
  assert.equal(fixture.remoteHead("feat"), head);
  assert.equal(github.comments.length, 0);

  await resolveIn(fixture, github, claude.run);
  assert.equal(claude.calls.length, 2);
});

test("conflict markers left behind are not pushed even when Claude says it resolved them", async () => {
  fixture = conflicting();
  const github = new FakeGitHub(fixture);
  const head = fixture.remoteHead("feat");
  const claude = fakeClaude(() => git(fixture.work, "add", "a.txt"));

  const result = await resolveIn(fixture, github, claude.run);

  assert.equal(result.report?.outcome, "needs-human");
  assert.match(result.report?.reason ?? "", /衝突の印/);
  assert.equal(fixture.remoteHead("feat"), head);
});

test("a resolution that fails the verify commands is not pushed", async () => {
  fixture = conflicting();
  const github = new FakeGitHub(fixture);
  const head = fixture.remoteHead("feat");
  const claude = fakeClaude(resolveBoth);

  const result = await resolveIn(fixture, github, claude.run, { config: { ...QUIET, verify: ["echo broken; false"] } });

  assert.equal(result.report?.outcome, "needs-human");
  assert.equal(fixture.remoteHead("feat"), head);
  assert.match(github.comments[0]?.body ?? "", /broken/);
});

test("a push by someone else during the resolution wins: Chusai's push is refused, not forced", async () => {
  fixture = conflicting();
  const github = new FakeGitHub(fixture);
  const claude = fakeClaude(() => {
    resolveBoth();
    fixture.on("feat", { "b.txt": "meanwhile\n" }, "someone pushes meanwhile");
  });
  const theirs = () => fixture.remoteHead("feat");

  const result = await resolveIn(fixture, github, claude.run);

  assert.equal(result.report?.outcome, "push-rejected");
  assert.equal(fixture.show(theirs(), "b.txt"), "meanwhile");
  assert.equal(github.comments.length, 0);
});

test("a dry run resolves but writes nothing", async () => {
  fixture = conflicting();
  const github = new FakeGitHub(fixture);
  const head = fixture.remoteHead("feat");

  const result = await resolveIn(fixture, github, fakeClaude(resolveBoth).run, { dryRun: true });

  assert.equal(result.report?.outcome, "resolved");
  assert.equal(result.report?.pushed, false);
  assert.equal(fixture.remoteHead("feat"), head);
  assert.equal(github.comments.length, 0);
  assert.match(result.report?.diff ?? "", /one from feat/);
});

// main renames `old` to `new`; feat, made before that, starts using `old`. They merge without conflicts.
function drifting(): Fixture {
  const made = new Fixture({ "lib.txt": "def old\n", "app.txt": "", "check.sh": 'while read -r n; do grep -qx "def $n" lib.txt || { echo "missing $n"; exit 1; }; done < app.txt\n' });
  made.on("main", { "lib.txt": "def new\n" }, "main renames old to new");
  made.on("feat", { "app.txt": "old\n" }, "feat uses old");
  return made;
}

const DRIFT = { ...QUIET, verify: ["bash check.sh"] };

test("after a push to main, a clean merge that breaks the verify commands is fixed and pushed", async () => {
  fixture = drifting();
  const github = new FakeGitHub(fixture);
  const claude = fakeClaude(() => {
    writeFileSync(path.join(fixture.work, "app.txt"), "new\n");
  });

  const result = await resolveIn(fixture, github, claude.run, { trigger: "push", config: DRIFT });

  assert.equal(result.report?.outcome, "resolved");
  assert.match(claude.calls[0] ?? "", /missing old/);
  assert.equal(fixture.show(fixture.remoteHead("feat"), "app.txt"), "new");
});

test("a pull request whose own CI is not green is left alone after a push to main", async () => {
  fixture = drifting();
  const github = new FakeGitHub(fixture);
  github.checks = [{ name: "test", status: "completed", conclusion: "failure" }];
  const head = fixture.remoteHead("feat");
  const claude = fakeClaude(() => {});

  const result = await resolveIn(fixture, github, claude.run, { trigger: "push", config: DRIFT });

  assert.equal(result.report?.outcome, "pr-ci-not-green");
  assert.equal(claude.calls.length, 0);
  assert.equal(fixture.remoteHead("feat"), head);
});

test("on a pull request event a clean merge is left to the repository's CI, and an old question is marked settled", async () => {
  fixture = drifting();
  const github = new FakeGitHub(fixture);
  await github.createComment(1, "<!-- chusai state=needs-human head=0000000 main=1111111 -->\nold question");
  const claude = fakeClaude(() => {});

  const result = await resolveIn(fixture, github, claude.run, { config: DRIFT });

  assert.equal(result.report?.outcome, "clean");
  assert.equal(claude.calls.length, 0);
  assert.equal(github.comments.length, 1);
  assert.equal(parseMarker(github.comments[0]?.body)?.state, "settled");
});

test("a pull request with the skip label is not touched", async () => {
  fixture = conflicting();
  const github = new FakeGitHub(fixture);
  github.labels = ["chusai:skip"];

  const result = await resolveIn(fixture, github, fakeClaude(resolveBoth).run);

  assert.match(result.skipped ?? "", /chusai:skip/);
  assert.equal(github.comments.length, 0);
});

test("CI is green only when every check run finished without failing", () => {
  const done = (conclusion: string) => ({ name: "x", status: "completed", conclusion });
  assert.equal(ciIsGreen([done("success"), done("neutral"), done("skipped")]), true);
  assert.equal(ciIsGreen([]), false);
  assert.equal(ciIsGreen([done("success"), done("cancelled")]), false);
  assert.equal(ciIsGreen([done("success"), { name: "y", status: "in_progress", conclusion: null }]), false);
});
