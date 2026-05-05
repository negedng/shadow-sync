import { createTestEnv, commitOnRemote, commitOnLocal, runCiSync, mergeShadow, runPush, readExternalShadowFile } from "./harness";
import { assertEqual, assertIncludes, assertNotEqual } from "./assert";
import { execSync } from "child_process";

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/**
 * Test: manual intervention on shadow ref produces different-tree divergence
 * that the engine cannot reconcile without force-push. Force-push is disabled
 * by design, so the engine halts with an operator-actionable error and the
 * shadow ref stays untouched until an operator intervenes.
 *
 * This is the case-2 scenario (human writes to shadow ref directly), the
 * symmetric counterpart to case-1 (source rewrite) which is exercised by
 * test-pull-force-rewrite.
 */
export default function run() {
  const env = createTestEnv("push-diverged");
  try {
    // 1. Establish baseline
    commitOnRemote(env, { "base.txt": "base\n" }, "Add base.txt");
    const r1 = runCiSync(env);
    assertEqual(r1.status, 0, "initial pull should succeed");
    mergeShadow(env);

    // 2. Push a first local change to establish the shadow branch on B
    commitOnLocal(env, { "first.ts": "first\n" }, "Add first.ts");
    const r2 = runPush(env);
    assertEqual(r2.status, 0, "first push should succeed");

    // 3. Now create divergence: make another local commit (will produce new replayed SHA)
    commitOnLocal(env, { "second.ts": "second\n" }, "Add second.ts");

    // AND simulate B's shadow branch getting a different commit directly
    // (e.g. a human force-pushing or committing into the shadow ref).
    const subdir = env.subdir;
    const shadowBranch = `${env.branchPrefix}/${subdir}/main`;
    git(`fetch ${env.remoteName} ${shadowBranch}`, env.localRepo);
    const currentTip = git(`rev-parse ${env.remoteName}/${shadowBranch}`, env.localRepo);
    const treeHash = git(`rev-parse "${currentTip}^{tree}"`, env.localRepo);
    const divergeCommit = git(`commit-tree ${treeHash} -p ${currentTip} -m "Diverged commit on B shadow"`, env.localRepo);
    git(`push ${env.remoteName} ${divergeCommit}:refs/heads/${shadowBranch}`, env.localRepo);

    // 4. Push again — engine detects divergence with different tree and halts.
    const r3 = runPush(env);
    assertNotEqual(r3.status, 0, "push with diverged different-tree shadow should fail");
    assertIncludes(r3.stderr + r3.stdout, "diverged with different tree",
      "engine should report divergence-with-different-tree in output");
    assertIncludes(r3.stderr + r3.stdout, "Operator must reconcile",
      "engine should instruct the operator on how to recover");

    // 5. The shadow ref must still point at the operator's diverged commit —
    //    the engine did NOT force-update past it.
    git(`fetch ${env.remoteName} ${shadowBranch}`, env.localRepo);
    const tipAfter = git(`rev-parse ${env.remoteName}/${shadowBranch}`, env.localRepo);
    assertEqual(tipAfter, divergeCommit,
      "shadow ref should remain at the divergent tip; engine must not force-push");
    assertEqual(
      readExternalShadowFile(env, "second.ts"),
      null,
      "second.ts should NOT be on shadow branch (engine halted before pushing replay)",
    );

  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-push-diverged");
}
