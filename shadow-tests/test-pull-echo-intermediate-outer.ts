import { createTestEnv, runCiSync, mergeShadow, runPush } from "./harness";
import { assertEqual } from "./assert";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/**
 * M1 (cross-repo merge composition): when a replayed source commit has an
 * echo'd source parent (i.e. one of its parents on the source side carries
 * a Shadow-replayed-<our-remote> trailer pointing back to a commit on our
 * side), the engine composes the echo'd commit's outer tree with the
 * shadow-chain parent's dir/ subtree to build the replayed commit's
 * parentTree.
 *
 * Without this composition, intermediate shadow commits would inherit a
 * stale outer tree from the chain (anchored at target init by M2). With it,
 * commits between two round-trip echoes carry the most recent round-tripped
 * commit's outer state — useful when consumers check out an old shadow
 * commit for inspection, and required for plain `git merge` to find the
 * right merge-base with target/main.
 *
 * This test sets up a round-trip where B integrates via a merge commit
 * (not FF), then verifies the replayed B-side merge commit on A's shadow
 * has A's outer file modifications from the round-tripped commit, even
 * though the path filter dropped those changes on the way out.
 */
export default function run() {
  const env = createTestEnv("pull-echo-intermediate-outer");
  try {
    // ── Phase 1: initial sync to populate shadow with B's content ────────
    runCiSync(env);
    mergeShadow(env);

    // ── Phase 2: A makes commit x — modifies BOTH frontend/ AND outer ────
    fs.writeFileSync(path.join(env.localRepo, env.subdir, "feature.ts"), "feature from A\n");
    git(`add ${env.subdir}/feature.ts`, env.localRepo);
    fs.writeFileSync(path.join(env.localRepo, "mono.txt"), "monorepo updated by x\n");
    git("add mono.txt", env.localRepo);
    git('commit -m "x: A modifies frontend AND outer mono.txt"', env.localRepo);
    const xHash = git("rev-parse HEAD", env.localRepo);
    // Push A/main to origin so the cross-repo merge replay (M1) can resolve x via the echo.
    git("push origin main", env.localRepo);

    // ── Phase 3: push A→B (replays x as x' with frontend changes only) ───
    const r1 = runPush(env);
    assertEqual(r1.status, 0, "[phase 3] push should succeed");

    // ── Phase 4: B integrates x' via merge commit (NOT fast-forward) ─────
    git(`fetch origin shadow/${env.subdir}/main`, env.remoteWorking);
    git(`merge --no-ff origin/shadow/${env.subdir}/main -m "B: merge shadow into main"`, env.remoteWorking);
    git("push origin main", env.remoteWorking);

    // ── Phase 5: B makes another commit (a) on top of the merge ──────────
    fs.writeFileSync(path.join(env.remoteWorking, "after-merge.ts"), "B's work after merge\n");
    git("add after-merge.ts", env.remoteWorking);
    git('commit -m "a: B commit after merge"', env.remoteWorking);
    git("push origin main", env.remoteWorking);

    // ── Phase 6: pull B→A — replay must trigger M9 on the merge commit ───
    const r2 = runCiSync(env);
    assertEqual(r2.status, 0, "[phase 6] pull should succeed");

    // ── Phase 7: verify the replayed B-side merge commit has x's outer ───
    git("fetch origin", env.localRepo);
    const shadowBranch = `${env.branchPrefix}/${env.subdir}/main`;
    const tipSha = git(`rev-parse origin/${shadowBranch}`, env.localRepo);

    // (debug output removed)

    // Find the replayed B-side merge commit on shadow — it's the merge
    // commit (2 parents) reachable from tip whose second parent is xHash.
    const mergesOutput = git(`log --merges --format=%H origin/${shadowBranch}`, env.localRepo);
    const mergeCandidates = mergesOutput.split("\n").filter(Boolean);

    let mergeReplayed: string | null = null;
    for (const candidate of mergeCandidates) {
      const parents = git(`log -1 --format=%P ${candidate}`, env.localRepo).split(/\s+/).filter(Boolean);
      if (parents.includes(xHash)) {
        mergeReplayed = candidate;
        break;
      }
    }

    assertEqual(
      mergeReplayed != null, true,
      `[phase 7] should find a replayed merge commit on shadow with x as a parent (echo). Candidates: ${mergeCandidates.join(", ")}`,
    );

    const mergeParents = git(`log -1 --format=%P ${mergeReplayed}`, env.localRepo).split(/\s+/).filter(Boolean);
    assertEqual(
      mergeParents.length, 2,
      `[phase 7] merge replay should have 2 parents, got ${mergeParents.length}`,
    );
    assertEqual(
      mergeParents.includes(xHash), true,
      `[phase 7] merge replay should have x (${xHash.slice(0, 7)}) as a parent via echo`,
    );

    // The crucial M1 check: M_B''s tree should have mono.txt with x's
    // modification, NOT the bootstrap content. Without M1's composition,
    // mono.txt on M_B' would be the original "internal repo root\n".
    const monoOnMerge = git(`show ${mergeReplayed}:mono.txt`, env.localRepo);
    assertEqual(
      monoOnMerge.trim(), "monorepo updated by x",
      "[M1] merge-replay's mono.txt should have x's modification (proves M1 composed x's outer)",
    );

    // Tip should also have x's outer — it inherits parentTree from the merge replay,
    // which M1 composed from x's tree.
    const monoOnTip = git(`show ${tipSha}:mono.txt`, env.localRepo);
    assertEqual(
      monoOnTip.trim(), "monorepo updated by x",
      "[M1] tip's mono.txt should have x's modification (inherited via merge replay's composed tree)",
    );

    // Sanity: the merge replay should have feature.ts under frontend/ from
    // x's contribution. (If M1's composition were wrong and clobbered shadow's
    // dir/, we'd lose B-side content.)
    const featureOnMerge = git(`show ${mergeReplayed}:${env.subdir}/feature.ts`, env.localRepo);
    assertEqual(
      featureOnMerge.trim(), "feature from A",
      "[M1] merge-replay's frontend/feature.ts should still have x's contribution",
    );

    // Sanity: the merge replay should preserve the original B-side
    // initial-commit's frontend/README.md (was the README.md commit on B,
    // replayed onto shadow with frontend/ prefix). M1's composition keeps shadow's
    // dir/ from previous_shadow_tip, so this earlier B-side content survives.
    let readmePresent = false;
    try {
      git(`show ${mergeReplayed}:${env.subdir}/README.md`, env.localRepo);
      readmePresent = true;
    } catch { /* not found */ }
    assertEqual(
      readmePresent, true,
      "[M1] merge-replay should still have frontend/README.md from earlier B-side commit",
    );
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-pull-echo-intermediate-outer");
}
