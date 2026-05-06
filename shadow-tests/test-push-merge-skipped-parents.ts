import { createTestEnv, commitOnLocal, runPush, getExternalShadowLogFull } from "./harness";
import { assertEqual, assertNotIncludes } from "./assert";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/**
 * Merge whose immediate parents touch only files OUTSIDE source.dir/ —
 * those parents drop out of `rev-list -- frontend/`, so they never get
 * replayed. Question: what does the replayed merge use as parents?
 *
 * Topology on local:
 *
 *      M1 ── M2 ── M4(AI)        (feature1)
 *        \                \
 *         \                M6   (merge)
 *          \              /
 *           M3 ── M5(AI)        (feature2)
 *
 * Expected on shadow: M4 and M5 are skipped; M6' is grafted onto M2' and
 * M3' via findEchoAnchor's walk back to the nearest replayed ancestor.
 */
export default function run() {
  const env = createTestEnv("push-merge-skipped-parents");
  try {
    // M1: bootstrap. One file under subdir, push to establish shadow chain.
    commitOnLocal(env, { "app.ts": "v1\n" }, "M1: bootstrap app.ts");
    const r0 = runPush(env);
    assertEqual(r0.status, 0, "[M1] bootstrap push should succeed");
    const m1 = git("rev-parse HEAD", env.localRepo);

    // M2 on feature1: subdir change.
    git("checkout -b feature1", env.localRepo);
    commitOnLocal(env, { "feat1.ts": "feat1\n" }, "M2: feat1.ts on feature1");
    const m2 = git("rev-parse HEAD", env.localRepo);

    // M4 on feature1: AI-only — touches a root file, NOT under env.subdir.
    fs.writeFileSync(path.join(env.localRepo, "ai-notes-1.txt"), "ai work for feat1\n");
    git("add ai-notes-1.txt", env.localRepo);
    git('commit -m "M4: AI-only edits outside subdir (feature1)"', env.localRepo);
    const m4 = git("rev-parse HEAD", env.localRepo);

    // M3 on feature2 (branched from M1): subdir change.
    git(`checkout -b feature2 ${m1}`, env.localRepo);
    commitOnLocal(env, { "feat2.ts": "feat2\n" }, "M3: feat2.ts on feature2");
    const m3 = git("rev-parse HEAD", env.localRepo);

    // M5 on feature2: AI-only — root file again.
    fs.writeFileSync(path.join(env.localRepo, "ai-notes-2.txt"), "ai work for feat2\n");
    git("add ai-notes-2.txt", env.localRepo);
    git('commit -m "M5: AI-only edits outside subdir (feature2)"', env.localRepo);
    const m5 = git("rev-parse HEAD", env.localRepo);

    // M6: merge feature2 into feature1. Parents must be [M4, M5].
    git("checkout feature1", env.localRepo);
    git('merge --no-ff feature2 -m "M6: merge feature2 into feature1"', env.localRepo);
    const m6 = git("rev-parse HEAD", env.localRepo);
    const m6Parents = git("rev-list --parents -1 HEAD", env.localRepo).split(/\s+/).slice(1);
    assertEqual(m6Parents.length, 2, "[setup] M6 should have 2 parents");
    assertEqual(m6Parents[0], m4, "[setup] M6 first parent is M4");
    assertEqual(m6Parents[1], m5, "[setup] M6 second parent is M5");

    // Fast-forward main to M6, then drop the feature branches so listRemoteBranches
    // returns just main (otherwise the orchestrator pushes an extra shadow ref per branch).
    git("checkout main", env.localRepo);
    git(`merge --ff-only ${m6}`, env.localRepo);
    git("branch -D feature1", env.localRepo);
    git("branch -D feature2", env.localRepo);

    // Push: replay local → shadow on the external remote.
    const rPush = runPush(env);
    assertEqual(rPush.status, 0, "[push] should succeed");

    // Inspect the shadow tip on the external remote.
    const shadowBranch = `${env.branchPrefix}/${env.subdir}/main`;
    git(`fetch ${env.remoteName} ${shadowBranch}`, env.localRepo);
    const shadowTip = git(`rev-parse ${env.remoteName}/${shadowBranch}`, env.localRepo);
    const shadowTipParents = git(`rev-list --parents -1 ${shadowTip}`, env.localRepo)
      .split(/\s+/).slice(1);

    // The replayed merge should still be a 2-parent merge.
    assertEqual(shadowTipParents.length, 2, `[shadow] M6' has 2 parents (got ${shadowTipParents.length})`);

    // Build source→shadow mapping by walking shadow log + reading replay trailers.
    // Trailer is added with the SOURCE remote name; pushing a→b means source = "origin".
    const trailerKey = `Shadow-replayed-origin`;
    const shadowLogFull = getExternalShadowLogFull(env, 50);
    const mapping = new Map<string, string>();
    {
      const blocks = git(
        `log ${env.remoteName}/${shadowBranch} --format=%H%x00%(trailers:only,unfold=true)%x01`,
        env.localRepo,
      ).split("\x01").map(s => s.trim()).filter(Boolean);
      for (const b of blocks) {
        const [shadowSha, trailers] = b.split("\x00");
        const m = trailers?.match(new RegExp(`^${trailerKey}:\\s*([0-9a-f]+)`, "m"));
        if (m) mapping.set(m[1], shadowSha.trim());
      }
    }

    const m1Shadow = mapping.get(m1);
    const m2Shadow = mapping.get(m2);
    const m3Shadow = mapping.get(m3);
    const m6Shadow = mapping.get(m6);
    assertEqual(typeof m1Shadow, "string", "[shadow] M1 was replayed");
    assertEqual(typeof m2Shadow, "string", "[shadow] M2 was replayed");
    assertEqual(typeof m3Shadow, "string", "[shadow] M3 was replayed");
    assertEqual(typeof m6Shadow, "string", "[shadow] M6 was replayed");

    // The AI-only commits must NOT have been replayed.
    assertEqual(mapping.has(m4), false, "[shadow] M4 (AI-only) NOT replayed");
    assertEqual(mapping.has(m5), false, "[shadow] M5 (AI-only) NOT replayed");
    assertNotIncludes(shadowLogFull, m4, "[shadow] no commit references M4");
    assertNotIncludes(shadowLogFull, m5, "[shadow] no commit references M5");

    // Shadow tip is the replayed M6.
    assertEqual(shadowTip, m6Shadow, "[shadow] tip is M6'");

    // M6's parents on shadow should be M2' and M3' (the nearest replayed
    // ancestors of the dropped M4/M5 parents).
    const expectedSet = new Set([m2Shadow!, m3Shadow!]);
    const actualSet = new Set(shadowTipParents);
    assertEqual(actualSet.size, 2, "[shadow] M6' parents are distinct");
    assertEqual(
      [...actualSet].every(p => expectedSet.has(p)),
      true,
      `[shadow] M6' parents are M2' and M3'\n  expected: ${[...expectedSet]}\n  actual:   ${[...actualSet]}`,
    );
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-push-merge-skipped-parents");
}
