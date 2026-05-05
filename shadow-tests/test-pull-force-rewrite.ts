import { createTestEnv, commitOnRemote, runCiSync, readShadowFile } from "./harness";
import { assertEqual, assertNotEqual, assertIncludes } from "./assert";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/**
 * History-rewrite halt test. Force-push is disabled on shadow refs by
 * design, so when source-side history is rewritten (force-push on main
 * or rebased feature branch) the engine cannot fast-forward the existing
 * shadow ref and the trees differ. Engine halts with an operator message.
 *
 * Two phases:
 *   1. force-push on main — source rewrites history (A,B → A,C). Sync
 *      should fail cleanly with a divergence message; shadow stays on
 *      the pre-rewrite chain (A,B replays). Operator heals by deleting
 *      the shadow ref; subsequent sync re-creates it cleanly.
 *   2. rebased feature branch — feature with X,Y synced, then rebased
 *      onto Z and force-pushed. Sync should fail cleanly on the feature
 *      branch; shadow feature stays on the pre-rebase chain.
 */
export default function run() {
  const env = createTestEnv("pull-force-rewrite");
  try {
    // ── phase 1: force-push on main ─────────────────────────────────────
    commitOnRemote(env, { "a.ts": "A\n" }, "Add A");
    commitOnRemote(env, { "b.ts": "B\n" }, "Add B");
    const r1 = runCiSync(env);
    assertEqual(r1.status, 0, "[phase 1] initial sync should succeed");
    assertEqual(readShadowFile(env, "a.ts"), "A\n", "[phase 1] A synced");
    assertEqual(readShadowFile(env, "b.ts"), "B\n", "[phase 1] B synced");

    const mainShadowRef = `shadow/${env.subdir}/main`;
    const shadowHeadBefore = git(`rev-parse origin/${mainShadowRef}`, env.localRepo);

    // Force-push: reset main back to A, drop B, add C instead
    const aSha = git("rev-parse HEAD~1", env.remoteWorking);
    git(`reset --hard ${aSha}`, env.remoteWorking);
    git("push origin main --force", env.remoteWorking);
    commitOnRemote(env, { "c.ts": "C\n" }, "Add C");

    const r1b = runCiSync(env);
    assertNotEqual(r1b.status, 0, "[phase 1] sync after force-push should fail (halt)");
    assertIncludes(r1b.stderr + r1b.stdout, "diverged with different tree",
      "[phase 1] engine should report divergence-with-different-tree");
    assertIncludes(r1b.stderr + r1b.stdout, "Operator must reconcile",
      "[phase 1] engine should instruct the operator");

    git("fetch origin", env.localRepo);
    const shadowHeadAfter = git(`rev-parse origin/${mainShadowRef}`, env.localRepo);
    assertEqual(shadowHeadBefore, shadowHeadAfter,
      "[phase 1] shadow head must NOT advance — engine halted before push");
    assertEqual(readShadowFile(env, "c.ts"), null, "[phase 1] C must NOT be on shadow");
    assertEqual(readShadowFile(env, "b.ts"), "B\n", "[phase 1] B still on shadow (pre-rewrite tip)");

    // Operator heals by deleting the divergent shadow ref. Subsequent sync
    // re-creates it cleanly from the rewritten source state.
    git(`push origin --delete refs/heads/${mainShadowRef}`, env.localRepo);
    const rHeal = runCiSync(env);
    assertEqual(rHeal.status, 0, "[heal] sync after operator clears shadow should succeed");
    assertEqual(readShadowFile(env, "c.ts"), "C\n", "[heal] C now on shadow");

    // ── phase 2: rebased feature branch ─────────────────────────────────
    git("checkout -b feature main", env.remoteWorking);
    fs.writeFileSync(path.join(env.remoteWorking, "x.ts"), "X\n");
    git("add x.ts", env.remoteWorking);
    git('commit -m "X"', env.remoteWorking);
    fs.writeFileSync(path.join(env.remoteWorking, "y.ts"), "Y\n");
    git("add y.ts", env.remoteWorking);
    git('commit -m "Y"', env.remoteWorking);
    git("push origin feature", env.remoteWorking);

    const r2 = runCiSync(env);
    assertEqual(r2.status, 0, "[phase 2] initial feature sync should succeed");

    git("fetch origin", env.localRepo);
    const featShadowRef = `shadow/${env.subdir}/feature`;
    const featShadow = `origin/${featShadowRef}`;
    const featShadowBefore = git(`rev-parse ${featShadow}`, env.localRepo);
    assertEqual(git(`show ${featShadow}:${env.subdir}/x.ts`, env.localRepo), "X", "[phase 2] X on feature shadow");
    assertEqual(git(`show ${featShadow}:${env.subdir}/y.ts`, env.localRepo), "Y", "[phase 2] Y on feature shadow");

    // Land Z on main, rebase feature onto main
    git("checkout main", env.remoteWorking);
    commitOnRemote(env, { "z.ts": "Z\n" }, "Z on main");
    git("checkout feature", env.remoteWorking);
    git("rebase main", env.remoteWorking);
    git("push origin feature --force", env.remoteWorking);

    const r2b = runCiSync(env);
    assertNotEqual(r2b.status, 0, "[phase 2] sync after rebase should fail (halt)");
    assertIncludes(r2b.stderr + r2b.stdout, "diverged with different tree",
      "[phase 2] engine should report divergence-with-different-tree");

    // Feature shadow ref must NOT have moved.
    git("fetch origin", env.localRepo);
    const featShadowAfter = git(`rev-parse ${featShadow}`, env.localRepo);
    assertEqual(featShadowBefore, featShadowAfter,
      "[phase 2] feature shadow head must NOT advance — engine halted");
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-pull-force-rewrite");
}
