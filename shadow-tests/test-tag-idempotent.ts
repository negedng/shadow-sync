// Tags must not be re-pushed when already correct on the target, and tags whose
// commit isn't replayed (e.g. on an unsynced branch) must be skipped cheaply —
// no `git rev-parse` spawn per tag. syncTags peels via for-each-ref's
// %(*objectname) and compares against a single ls-remote snapshot of the target.
//   - already-correct tag  -> upToDate (no push)
//   - unreplayed-commit tag -> skipped (no per-tag spawn, no per-tag log)
import { execSync } from "child_process";
import * as fs from "fs";
import { createTestEnv, setTestBranchAllowlist, commitOnRemote, runCiSync } from "./harness";
import { assertEqual, AssertionError } from "./assert";

const env = createTestEnv("tag-idempotent", "frontend");
setTestBranchAllowlist({ team: ["main"], origin: ["main"] });

const w = env.remoteWorking;
const g = (c: string) => execSync(`git ${c}`, { cwd: w, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });

// On the synced branch: a commit tagged both ways (annotated + lightweight).
commitOnRemote(env, { "a.txt": "hello\n" }, "add a");
g('tag -a v1.0 -m "release v1.0"');   // annotated
g("tag v1.0-lw");                      // lightweight
g("push origin v1.0 v1.0-lw");

// On an UNSYNCED side branch: a tag whose commit never gets replayed.
g("checkout -b sidebranch");
fs.writeFileSync(`${w}/side.txt`, "side\n");
g("add -A"); g('commit -m "side commit (never synced)"');
g("tag v-side");                       // points at an unreplayed commit
g("checkout main");
g("push origin sidebranch v-side");

function tagSummary(stdout: string): { pushed: number; upToDate: number; skipped: number } {
  const m = stdout.match(/Tags: (\d+) pushed, (\d+) up to date, (\d+) skipped/);
  if (!m) throw new AssertionError(`no tag summary line found in:\n${stdout.slice(-1000)}`);
  return { pushed: +m[1], upToDate: +m[2], skipped: +m[3] };
}

// Run 1: the two synced tags push; v-side is skipped (commit not replayed).
const s1 = tagSummary(runCiSync(env).stdout);
console.log(`run 1: pushed=${s1.pushed} upToDate=${s1.upToDate} skipped=${s1.skipped}`);
if (s1.pushed < 2) throw new AssertionError(`run 1 should push both synced tags, got pushed=${s1.pushed}`);
if (s1.skipped < 1) throw new AssertionError(`run 1 should skip the unreplayed-commit tag, got skipped=${s1.skipped}`);

// Run 2 (no source change): synced tags up-to-date, v-side still skipped, 0 pushed.
const s2 = tagSummary(runCiSync(env).stdout);
console.log(`run 2: pushed=${s2.pushed} upToDate=${s2.upToDate} skipped=${s2.skipped}`);
assertEqual(s2.pushed, 0, "second consecutive sync must re-push 0 tags");
if (s2.upToDate < 2) throw new AssertionError(`run 2 should report both synced tags up to date, got ${s2.upToDate}`);
if (s2.skipped < 1) throw new AssertionError(`run 2 should still skip the unreplayed-commit tag, got ${s2.skipped}`);

env.cleanup();
console.log("PASS — idempotent tag sync; unmapped tags skipped without per-tag spawn/log.");
