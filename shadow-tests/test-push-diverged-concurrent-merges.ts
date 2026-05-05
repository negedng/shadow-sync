import {
  createTestEnv, commitOnRemote, commitOnLocal,
  runCiSync, mergeShadow, runPush,
  getExternalShadowLogFull,
} from "./harness";
import { assertEqual, assertNotIncludes } from "./assert";
import { execSync } from "child_process";

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/**
 * Test: concurrent merges with substitution (sht5 b53efbd scenario).
 *
 * Both sides merge the OTHER side's shadow content concurrently, producing
 * merge commits with the same content but parents in MIRRORED order.
 * Without substitution the engine fabricates its own merge that's a sibling
 * of the consumer's merge, orphaning the shadow chain and forcing a force-push
 * later. With substitution (M9), the engine detects the consumer's existing
 * merge on target/main with matching parent multiset + tree and reuses it
 * as the mapping — shadow ref points at the consumer's merge directly, no
 * sibling forms, subsequent rounds are pure FF.
 *
 * Phase A: substitution catches the concurrent-merge case in round 3 (--from a).
 *   Backend/shadow advances to Bea's actual merge commit, not a synthetic one.
 *   Subsequent --from b rounds advance monorepo/shadow via FF.
 *   Final --from a after the gap is FF (no force, no skip).
 * Phase B: one more user merge + sync round-trip stays converged.
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

    // PHASE A assertions — substitution in round 3 maps Mira's merge to Bea's
    // existing merge on backend/main, so backend/shadow rides along on
    // backend/main rather than diverging. The post-gap --from a is then a
    // pure FF onto bea5; no divergence, no force-push, no same-tree skip.
    assertNotIncludes(r.stdout, "diverged with different tree",
      "[divergence] no different-tree halt should fire");
    assertNotIncludes(r.stdout, "same tree on different topology",
      "[divergence] no same-tree skip should fire — substitution kept the chain FF");
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
