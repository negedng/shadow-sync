import { createTestEnv, commitOnRemote, commitOnLocal, runCiSync, mergeShadow, runPush, readExternalShadowFile, getExternalShadowLogFull } from "./harness";
import { assertEqual, assertIncludes, assertNotIncludes } from "./assert";
import { execSync } from "child_process";

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/**
 * Test: full round-trip A -> B -> merge into B main -> B -> A.
 *
 * Verifies that a commit originating from A, replayed to B's shadow branch,
 * merged into B's main, and then synced back from B does NOT get replayed
 * again on A (the echo is skipped).
 *
 * Both sides use a non-root subdir (A=frontend, B=src) to exercise the case
 * where neither pair endpoint lives at the repo root.
 */
export default function run() {
  const env = createTestEnv("round-trip", "frontend", "shadow", "src");
  try {
    // 1. Establish baseline: pull initial remote content
    commitOnRemote(env, { "base.txt": "base\n" }, "Add base.txt");
    const r1 = runCiSync(env);
    assertEqual(r1.status, 0, "initial pull should succeed");
    mergeShadow(env);

    // 2. Local team makes a commit (originates from A)
    commitOnLocal(env, { "from-a.ts": "local feature\n" }, "Add from-a.ts");

    // 3. Push A -> B
    const r2 = runPush(env);
    assertEqual(r2.status, 0, "push A->B should succeed");

    // Verify it landed on B's shadow branch
    assertEqual(readExternalShadowFile(env, "from-a.ts"), "local feature\n", "file should be on B shadow");

    // 4. Simulate B merging the shadow branch into their main
    const subdir = env.subdir;
    const shadowBranch = `${env.branchPrefix}/${subdir}/main`;
    git(`fetch origin ${shadowBranch}`, env.remoteWorking);
    git(`merge origin/${shadowBranch} --no-ff -m "Merge shadow into B main"`, env.remoteWorking);
    git("push origin main", env.remoteWorking);

    // 5. Now sync B -> A (pull). The commit that originated from A should be skipped.
    const r3 = runCiSync(env);
    assertEqual(r3.status, 0, "pull B->A should succeed");

    // The shadow branch on A should NOT contain a re-replayed version of "Add from-a.ts"
    // (it should either be up-to-date or only contain the merge commit, not a duplicate)
    const shadowLog = git(`fetch origin ${shadowBranch} && git log origin/${shadowBranch} --oneline -10`, env.localRepo);
    const fromACount = (shadowLog.match(/Add from-a\.ts/g) || []).length;
    assertEqual(fromACount <= 1, true, "from-a.ts commit should not be duplicated on shadow branch");

  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-round-trip");
}
