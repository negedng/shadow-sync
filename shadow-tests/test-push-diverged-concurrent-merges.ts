import {
  createTestEnv, commitOnRemote, commitOnLocal,
  runCiSync, mergeShadow, runPush,
  getExternalShadowLogFull,
} from "./harness";
import { assertEqual, assertIncludes, assertNotIncludes } from "./assert";
import { execSync } from "child_process";

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/**
 * Test: divergence from concurrent merges, the sht5 b53efbd scenario.
 *
 * Key topology: each side merges the OTHER side's content from shadow,
 * producing two merge commits with the same content but parents in
 * SIBLING ordering (neither is ancestor of the other). Plus a long
 * gap of --from b syncs that brings echoes into origin/main reachable
 * via Mira's merges. When --from a finally runs, mapBranchesToTargetTips
 * walks origin/main no-pathspec and the topo order can land on an echo
 * (mapping to one of Bea's main commits) before reaching the previously-
 * mapped Mira-merge commit. The echo target descends from Bea's-merge,
 * which is a SIBLING of the engine's earlier replay → divergence with
 * IDENTICAL TREES.
 *
 * Phase A: divergence detected, engine takes the same-tree skip path.
 *   No synthetic "Reconcile divergent" merge is created.
 * Phase B: one more user merge + sync round-trip drives both sides to
 *   the same tree (engine converges cleanly).
 */
export default function run() {
  const env = createTestEnv("push-diverged-concurrent-merges");
  const subdir = env.subdir;
  const shadowBranch = `${env.branchPrefix}/${subdir}/main`;

  try {
    // ── Round 1: concurrent commits (no merges yet) ────────────────────────

    commitOnRemote(env, { "bea1.txt": "Bea round 1\n" }, "Bea: bea1");
    commitOnLocal(env, { "mira1.txt": "Mira round 1\n" }, "Mira: mira1");

    // Sync each direction independently — each side has only its own commit.
    let r = runCiSync(env);
    assertEqual(r.status, 0, "[r1] --from b should succeed");
    r = runPush(env);
    assertEqual(r.status, 0, "[r1] --from a should succeed");

    // ── Round 2: BOTH sides merge shadow into their main concurrently ──────
    // This produces sibling merges: Bea's has parents [bea1, mira1-replay]
    //                              Mira's has parents [mira1, bea1-replay]
    // Engine hasn't seen Mira's merge yet, so team's shadow tip is just
    // mira1-replay-on-team. Bea merges THAT into her main, not engine-merge.

    git(`fetch origin ${shadowBranch}`, env.remoteWorking);
    git(`merge --no-ff origin/${shadowBranch} -m "Bea: merge shadow r1"`, env.remoteWorking);
    git(`push origin main`, env.remoteWorking);

    mergeShadow(env);  // Mira's merge: parents [mira1, bea1-replay]

    // ── Round 3: --from a sees Mira's merge, creates the parent-swap engine-merge ──
    r = runPush(env);
    assertEqual(r.status, 0, "[r3] --from a should succeed");

    // ── Round 4-6: Bea adds linear commits, --from b only ──────────────────
    //  Long gap with no --from a — matches sht5's gap that exposed the bug.

    for (let i = 2; i <= 5; i++) {
      commitOnRemote(env, { [`bea${i}.txt`]: `Bea ${i}\n` }, `Bea: bea${i}`);
      r = runCiSync(env);
      assertEqual(r.status, 0, `[r${i}] --from b should succeed`);
      mergeShadow(env);
    }

    // ── Divergence point: --from a after the long --from b sequence ────────
    r = runPush(env);
    assertEqual(r.status, 0, "[divergence] --from a should succeed");

    // PHASE A assertions — engine should detect divergence and either:
    //   (a) leave the target tip in place when trees match (silent skip), or
    //   (b) force-update the target with the replayed tip.
    // No synthetic "Reconcile divergent" merge should ever appear.
    const sawDivergence =
      r.stdout.includes("same tree on different topology") ||
      r.stdout.includes("force-updating engine view");
    assertEqual(sawDivergence, true,
      "[divergence] engine should detect divergence and report skip-or-force in stdout");
    assertNotIncludes(getExternalShadowLogFull(env), "Reconcile divergent",
      "[divergence] no reconciliation merge should be on remote shadow history");

    // ── Phase B: convergence after one more merge + round-trip ─────────────

    mergeShadow(env);
    r = runCiSync(env);
    assertEqual(r.status, 0, "[converge] --from b should succeed");
    r = runPush(env);
    assertEqual(r.status, 0, "[converge] --from a should succeed");

    git(`fetch ${env.remoteName} ${shadowBranch}`, env.localRepo);
    // Tree under local/main:<subdir>/ should equal remote shadow's root tree.
    // Pull SHAs via ls-tree (avoids ^{tree} brace-quoting headaches).
    const localSubTree = git(`ls-tree main -- ${subdir}`, env.localRepo)
      .split("\n")[0].split(/\s+/)[2];
    const shadowRootTree = git(`log -1 --format=%T ${env.remoteName}/${shadowBranch}`, env.localRepo);
    assertEqual(localSubTree, shadowRootTree,
      "[converge] local subdir tree must match remote shadow tree");

    r = runCiSync(env);
    assertEqual(r.status, 0, "[idem] --from b idempotent");
    r = runPush(env);
    assertEqual(r.status, 0, "[idem] --from a idempotent");
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-push-diverged-concurrent-merges");
}
