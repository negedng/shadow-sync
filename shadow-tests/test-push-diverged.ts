import { createTestEnv, commitOnRemote, commitOnLocal, runCiSync, mergeShadow, runPush, readExternalShadowFile } from "./harness";
import { assertEqual } from "./assert";
import { execSync } from "child_process";

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/**
 * Test: diverged shadow branch reconciliation.
 *
 * When both sides make changes between syncs, the shadow branch on the target
 * diverges from the replayed result. The tool should create a merge commit
 * using the replayed tree (ours strategy) and push successfully.
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
    // (e.g. from a concurrent push or manual edit)
    const subdir = env.subdir;
    const shadowBranch = `${env.branchPrefix}/${subdir}/main`;
    git(`fetch ${env.remoteName} ${shadowBranch}`, env.localRepo);
    // Create a commit on top of the current shadow branch tip
    const currentTip = git(`rev-parse ${env.remoteName}/${shadowBranch}`, env.localRepo);
    const treeHash = git(`rev-parse "${currentTip}^{tree}"`, env.localRepo);
    const divergeCommit = git(`commit-tree ${treeHash} -p ${currentTip} -m "Diverged commit on B shadow"`, env.localRepo);
    git(`push ${env.remoteName} ${divergeCommit}:refs/heads/${shadowBranch}`, env.localRepo);

    // 4. Push again — should detect divergence and create reconciliation merge
    const r3 = runPush(env);
    assertEqual(r3.status, 0, "push with diverged shadow should succeed");

    // 5. The replayed content should win (second.ts should be there)
    assertEqual(
      readExternalShadowFile(env, "second.ts"),
      "second\n",
      "second.ts should be on shadow branch (replayed tree wins)",
    );
    assertEqual(
      readExternalShadowFile(env, "first.ts"),
      "first\n",
      "first.ts should still be on shadow branch",
    );

    // 6. The shadow branch tip should be a merge commit (2 parents)
    git(`fetch ${env.remoteName} ${shadowBranch}`, env.localRepo);
    const parentLine = git(`log -1 --format=%P ${env.remoteName}/${shadowBranch}`, env.localRepo);
    const parentCount = parentLine.split(/\s+/).filter(Boolean).length;
    assertEqual(parentCount, 2, "shadow branch tip should be a merge commit with 2 parents");

  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-push-diverged-reconciliation");
}
