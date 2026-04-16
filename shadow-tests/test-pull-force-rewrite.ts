import { createTestEnv, commitOnRemote, runCiSync, readShadowFile, getShadowLogFull } from "./harness";
import { assertEqual, assertNotEqual } from "./assert";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/**
 * Consolidated force-push / history-rewrite test. Two phases:
 *   1. force-push on main — source rewrites history (A,B → A,C). Sync should
 *      survive and land C on shadow without crashing.
 *   2. rebased feature branch — feature with X,Y synced, then rebased onto
 *      Z on main and force-pushed. Shadow feature should now see Z's
 *      content in addition to X,Y.
 */
export default function run() {
  const env = createTestEnv("pull-force-rewrite");
  try {
    // ── phase 1: force-push on main ─────────────────────────────────────
    commitOnRemote(env, { "a.ts": "A\n" }, "Add A");
    commitOnRemote(env, { "b.ts": "B\n" }, "Add B");
    const r1 = runCiSync(env);
    assertEqual(r1.status, 0, "[phase 1: force-push] initial sync should succeed");
    assertEqual(readShadowFile(env, "a.ts"), "A\n", "[phase 1] A synced");
    assertEqual(readShadowFile(env, "b.ts"), "B\n", "[phase 1] B synced");

    const shadowHeadBefore = git("rev-parse origin/shadow/frontend/main", env.localRepo);

    // Force-push: reset main back to A, drop B, add C instead
    const aSha = git("rev-parse HEAD~1", env.remoteWorking);
    git(`reset --hard ${aSha}`, env.remoteWorking);
    git("push origin main --force", env.remoteWorking);
    commitOnRemote(env, { "c.ts": "C\n" }, "Add C");

    const r1b = runCiSync(env);
    assertEqual(r1b.status, 0, "[phase 1] sync after force-push should not crash");
    assertEqual(readShadowFile(env, "c.ts"), "C\n", "[phase 1] C visible on shadow");
    assertEqual(readShadowFile(env, "a.ts"), "A\n", "[phase 1] A still present");

    const shadowHeadAfter = git("rev-parse origin/shadow/frontend/main", env.localRepo);
    assertNotEqual(shadowHeadBefore, shadowHeadAfter, "[phase 1] shadow head advanced after force-push");
    const log = getShadowLogFull(env);
    if (!log.includes("Add C")) throw new Error("[phase 1] shadow log missing 'Add C'");

    // ── phase 2: rebased feature branch ─────────────────────────────────
    // Create feature branch with X, Y off current main (which is A, C)
    git("checkout -b feature main", env.remoteWorking);
    fs.writeFileSync(path.join(env.remoteWorking, "x.ts"), "X\n");
    git("add x.ts", env.remoteWorking);
    git('commit -m "X"', env.remoteWorking);
    fs.writeFileSync(path.join(env.remoteWorking, "y.ts"), "Y\n");
    git("add y.ts", env.remoteWorking);
    git('commit -m "Y"', env.remoteWorking);
    git("push origin feature", env.remoteWorking);

    const r2 = runCiSync(env);
    assertEqual(r2.status, 0, "[phase 2: rebased-feature] initial sync should succeed");

    git("fetch origin", env.localRepo);
    const featShadow = `origin/shadow/${env.subdir}/feature`;
    assertEqual(git(`show ${featShadow}:${env.subdir}/x.ts`, env.localRepo), "X", "[phase 2] X on feature shadow");
    assertEqual(git(`show ${featShadow}:${env.subdir}/y.ts`, env.localRepo), "Y", "[phase 2] Y on feature shadow");

    // Land Z on main, rebase feature onto main
    git("checkout main", env.remoteWorking);
    commitOnRemote(env, { "z.ts": "Z\n" }, "Z on main");
    git("checkout feature", env.remoteWorking);
    git("rebase main", env.remoteWorking);
    git("push origin feature --force", env.remoteWorking);

    const r2b = runCiSync(env);
    assertEqual(r2b.status, 0, "[phase 2] sync after rebase should not crash");

    git("fetch origin", env.localRepo);
    assertEqual(git(`show ${featShadow}:${env.subdir}/x.ts`, env.localRepo), "X", "[phase 2] X still on shadow feature");
    assertEqual(git(`show ${featShadow}:${env.subdir}/y.ts`, env.localRepo), "Y", "[phase 2] Y still on shadow feature");
    assertEqual(git(`show ${featShadow}:${env.subdir}/z.ts`, env.localRepo), "Z", "[phase 2] Z visible on shadow feature after rebase");
    assertEqual(readShadowFile(env, "z.ts"), "Z\n", "[phase 2] Z on shadow main");
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-pull-force-rewrite");
}
