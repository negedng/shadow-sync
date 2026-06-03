// Tags must not be re-pushed when already correct on the target. syncTags now
// snapshots the target's live tags (ls-remote) and skips any whose fingerprint
// (commit for lightweight, full tag-object SHA for annotated) already matches.
// A second consecutive --from b with no source change must push 0 tags.
import { execSync } from "child_process";
import { createTestEnv, setTestBranchAllowlist, commitOnRemote, runCiSync } from "./harness";
import { assertEqual, AssertionError } from "./assert";

const env = createTestEnv("tag-idempotent", "frontend");
setTestBranchAllowlist({ team: ["main"], origin: ["main"] });

const w = env.remoteWorking;
const g = (c: string) => execSync(`git ${c}`, { cwd: w, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });

// Commit, then tag that commit both ways (annotated + lightweight) and push.
commitOnRemote(env, { "a.txt": "hello\n" }, "add a");
g('tag -a v1.0 -m "release v1.0"');   // annotated
g("tag v1.0-lw");                      // lightweight
g("push origin v1.0 v1.0-lw");

function tagSummary(stdout: string): { pushed: number; upToDate: number; skipped: number } {
  const m = stdout.match(/Tags: (\d+) pushed, (\d+) up to date, (\d+) skipped/);
  if (!m) throw new AssertionError(`no tag summary line found in:\n${stdout.slice(-1000)}`);
  return { pushed: +m[1], upToDate: +m[2], skipped: +m[3] };
}

// First sync: both tags should be pushed (their commit gets replayed).
const s1 = tagSummary(runCiSync(env).stdout);
console.log(`run 1: pushed=${s1.pushed} upToDate=${s1.upToDate} skipped=${s1.skipped}`);
if (s1.pushed < 2) throw new AssertionError(`run 1 should push both tags, got pushed=${s1.pushed}`);

// Second sync, no source change: every tag already correct → 0 pushed.
const s2 = tagSummary(runCiSync(env).stdout);
console.log(`run 2: pushed=${s2.pushed} upToDate=${s2.upToDate} skipped=${s2.skipped}`);
assertEqual(s2.pushed, 0, "second consecutive sync must re-push 0 tags");
if (s2.upToDate < 2) throw new AssertionError(`run 2 should report both tags up to date, got ${s2.upToDate}`);

env.cleanup();
console.log("PASS — idempotent tag sync (no re-push on a no-op rerun).");
