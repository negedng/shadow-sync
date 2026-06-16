/**
 * Consolidated divergence test. Three sub-tests:
 *
 *   A. force-rewrite — source-side history rewrite halts cleanly
 *      (formerly test-pull-force-rewrite.ts)
 *   B. push-diverged — manual shadow-ref edit halts cleanly
 *      (formerly test-push-diverged.ts)
 *   C. concurrent-merges — sibling merges with mirrored parent order
 *      stay FF via --full-history
 *      (formerly test-push-diverged-concurrent-merges.ts)
 */
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import {
  createTestEnv, commitOnRemote, commitOnLocal,
  runCiSync, mergeShadow, runPush,
  readShadowFile, readExternalShadowFile,
  getExternalShadowLogFull,
  setTestBranchAllowlist,
} from "./harness";
import { assertEqual, assertNotEqual, assertIncludes, assertNotIncludes } from "./assert";

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

// ── A. force-rewrite: source rewrites history; engine halts ────────────────
function runForceRewrite(): void {
  const env = createTestEnv("pull-force-rewrite");
  try {
    // phase 1: force-push on main
    commitOnRemote(env, { "a.ts": "A\n" }, "Add A");
    commitOnRemote(env, { "b.ts": "B\n" }, "Add B");
    const r1 = runCiSync(env);
    assertEqual(r1.status, 0, "[force-rewrite 1] initial sync should succeed");
    assertEqual(readShadowFile(env, "a.ts"), "A\n", "[force-rewrite 1] A synced");
    assertEqual(readShadowFile(env, "b.ts"), "B\n", "[force-rewrite 1] B synced");

    const mainShadowRef = `b-${env.subdir}/main`;
    const shadowHeadBefore = git(`rev-parse origin/${mainShadowRef}`, env.localRepo);

    const aSha = git("rev-parse HEAD~1", env.remoteWorking);
    git(`reset --hard ${aSha}`, env.remoteWorking);
    git("push origin main --force", env.remoteWorking);
    commitOnRemote(env, { "c.ts": "C\n" }, "Add C");

    const r1b = runCiSync(env);
    assertNotEqual(r1b.status, 0, "[force-rewrite 1] sync after force-push should fail");
    assertIncludes(r1b.stderr + r1b.stdout, "diverged with different tree",
      "[force-rewrite 1] engine reports divergence-with-different-tree");
    assertIncludes(r1b.stderr + r1b.stdout, "Operator must reconcile",
      "[force-rewrite 1] engine instructs the operator");

    git("fetch origin", env.localRepo);
    const shadowHeadAfter = git(`rev-parse origin/${mainShadowRef}`, env.localRepo);
    assertEqual(shadowHeadBefore, shadowHeadAfter,
      "[force-rewrite 1] shadow head must NOT advance");
    assertEqual(readShadowFile(env, "c.ts"), null, "[force-rewrite 1] C must NOT be on shadow");
    assertEqual(readShadowFile(env, "b.ts"), "B\n", "[force-rewrite 1] B still on shadow");

    // Operator heals by deleting the divergent shadow ref
    git(`push origin --delete refs/heads/${mainShadowRef}`, env.localRepo);
    const rHeal = runCiSync(env);
    assertEqual(rHeal.status, 0, "[force-rewrite heal] sync after operator clears shadow should succeed");
    assertEqual(readShadowFile(env, "c.ts"), "C\n", "[force-rewrite heal] C now on shadow");

    // phase 2: rebased feature branch
    git("checkout -b feature main", env.remoteWorking);
    fs.writeFileSync(path.join(env.remoteWorking, "x.ts"), "X\n");
    git("add x.ts", env.remoteWorking);
    git('commit -m "X"', env.remoteWorking);
    fs.writeFileSync(path.join(env.remoteWorking, "y.ts"), "Y\n");
    git("add y.ts", env.remoteWorking);
    git('commit -m "Y"', env.remoteWorking);
    git("push origin feature", env.remoteWorking);

    const r2 = runCiSync(env);
    assertEqual(r2.status, 0, "[force-rewrite 2] initial feature sync should succeed");

    git("fetch origin", env.localRepo);
    const featShadowRef = `b-${env.subdir}/feature`;
    const featShadow = `origin/${featShadowRef}`;
    const featShadowBefore = git(`rev-parse ${featShadow}`, env.localRepo);
    assertEqual(git(`show ${featShadow}:${env.subdir}/x.ts`, env.localRepo), "X", "[force-rewrite 2] X on feature shadow");
    assertEqual(git(`show ${featShadow}:${env.subdir}/y.ts`, env.localRepo), "Y", "[force-rewrite 2] Y on feature shadow");

    git("checkout main", env.remoteWorking);
    commitOnRemote(env, { "z.ts": "Z\n" }, "Z on main");
    git("checkout feature", env.remoteWorking);
    git("rebase main", env.remoteWorking);
    git("push origin feature --force", env.remoteWorking);

    const r2b = runCiSync(env);
    assertNotEqual(r2b.status, 0, "[force-rewrite 2] sync after rebase should fail");
    assertIncludes(r2b.stderr + r2b.stdout, "diverged with different tree",
      "[force-rewrite 2] engine reports divergence-with-different-tree");

    git("fetch origin", env.localRepo);
    const featShadowAfter = git(`rev-parse ${featShadow}`, env.localRepo);
    assertEqual(featShadowBefore, featShadowAfter,
      "[force-rewrite 2] feature shadow head must NOT advance");
  } finally {
    env.cleanup();
  }
}

// ── B. push-diverged: manual shadow-ref edit halts cleanly ─────────────────
function runPushDiverged(): void {
  const env = createTestEnv("push-diverged");
  try {
    commitOnRemote(env, { "base.txt": "base\n" }, "Add base.txt");
    const r1 = runCiSync(env);
    assertEqual(r1.status, 0, "[push-diverged] initial pull should succeed");
    mergeShadow(env);

    commitOnLocal(env, { "first.ts": "first\n" }, "Add first.ts");
    const r2 = runPush(env);
    assertEqual(r2.status, 0, "[push-diverged] first push should succeed");

    commitOnLocal(env, { "second.ts": "second\n" }, "Add second.ts");

    const subdir = env.subdir;
    const shadowBranch = `a-${subdir}/main`;
    git(`fetch ${env.remoteName} ${shadowBranch}`, env.localRepo);
    const currentTip = git(`rev-parse ${env.remoteName}/${shadowBranch}`, env.localRepo);
    const treeHash = git(`rev-parse "${currentTip}^{tree}"`, env.localRepo);
    const divergeCommit = git(`commit-tree ${treeHash} -p ${currentTip} -m "Diverged commit on B shadow"`, env.localRepo);
    git(`push ${env.remoteName} ${divergeCommit}:refs/heads/${shadowBranch}`, env.localRepo);

    const r3 = runPush(env);
    assertNotEqual(r3.status, 0, "[push-diverged] push with diverged shadow should fail");
    assertIncludes(r3.stderr + r3.stdout, "diverged with different tree",
      "[push-diverged] engine reports divergence");
    assertIncludes(r3.stderr + r3.stdout, "Operator must reconcile",
      "[push-diverged] engine instructs operator on recovery");

    git(`fetch ${env.remoteName} ${shadowBranch}`, env.localRepo);
    const tipAfter = git(`rev-parse ${env.remoteName}/${shadowBranch}`, env.localRepo);
    assertEqual(tipAfter, divergeCommit,
      "[push-diverged] shadow ref should remain at divergent tip");
    assertEqual(
      readExternalShadowFile(env, "second.ts"), null,
      "[push-diverged] second.ts NOT on shadow (engine halted)",
    );
  } finally {
    env.cleanup();
  }
}

// ── C. concurrent-merges: sibling merges stay FF via --full-history ────────
function runConcurrentMerges(): void {
  const env = createTestEnv("push-diverged-concurrent-merges");
  const subdir = env.subdir;
  const pushShadowBranch = `a-${subdir}/main`;

  try {
    // Round 1: concurrent commits
    commitOnRemote(env, { "bea1.txt": "Bea round 1\n" }, "Bea: bea1");
    commitOnLocal(env, { "mira1.txt": "Mira round 1\n" }, "Mira: mira1");

    let r = runCiSync(env);
    assertEqual(r.status, 0, "[concurrent r1] --from b should succeed");
    r = runPush(env);
    assertEqual(r.status, 0, "[concurrent r1] --from a should succeed");

    // Round 2: BOTH sides merge shadow into main concurrently
    git(`fetch origin ${pushShadowBranch}`, env.remoteWorking);
    git(`merge --no-ff origin/${pushShadowBranch} -m "Bea: merge shadow r1"`, env.remoteWorking);
    git(`push origin main`, env.remoteWorking);

    mergeShadow(env);

    // Round 3: --from a creates parent-swap engine merge
    r = runPush(env);
    assertEqual(r.status, 0, "[concurrent r3] --from a should succeed");

    // Rounds 4-6: Bea linear commits, --from b only
    for (let i = 2; i <= 5; i++) {
      commitOnRemote(env, { [`bea${i}.txt`]: `Bea ${i}\n` }, `Bea: bea${i}`);
      r = runCiSync(env);
      assertEqual(r.status, 0, `[concurrent r${i}] --from b should succeed`);
      mergeShadow(env);
    }

    // Divergence point: --from a after long --from b sequence
    r = runPush(env);
    assertEqual(r.status, 0, "[concurrent divergence] --from a should succeed");
    assertNotIncludes(r.stdout, "diverged with different tree",
      "[concurrent divergence] no different-tree halt");
    assertNotIncludes(r.stdout, "same tree on different topology",
      "[concurrent divergence] no same-tree skip — --full-history kept chain FF");
    assertNotIncludes(getExternalShadowLogFull(env), "Reconcile divergent",
      "[concurrent divergence] no reconciliation merge");

    // Phase B: convergence
    mergeShadow(env);
    r = runCiSync(env);
    assertEqual(r.status, 0, "[concurrent converge] --from b should succeed");
    r = runPush(env);
    assertEqual(r.status, 0, "[concurrent converge] --from a should succeed");

    git(`fetch ${env.remoteName} ${pushShadowBranch}`, env.localRepo);
    const localSubTree = git(`ls-tree main -- ${subdir}`, env.localRepo)
      .split("\n")[0].split(/\s+/)[2];
    const shadowRootTree = git(`log -1 --format=%T ${env.remoteName}/${pushShadowBranch}`, env.localRepo);
    assertEqual(localSubTree, shadowRootTree,
      "[concurrent converge] local subdir tree must match remote shadow tree");

    r = runCiSync(env);
    assertEqual(r.status, 0, "[concurrent idem] --from b idempotent");
    r = runPush(env);
    assertEqual(r.status, 0, "[concurrent idem] --from a idempotent");
  } finally {
    env.cleanup();
  }
}

export default function run(): void {
  // Not a filter test — wildcard.
  setTestBranchAllowlist({ origin: ["**"], team: ["**"] });
  try {
    runForceRewrite();
    runPushDiverged();
    runConcurrentMerges();
  } finally {
    setTestBranchAllowlist();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-divergence");
}
