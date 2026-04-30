import { createTestEnv, commitOnRemote, runCiSync } from "./harness";
import { assertEqual, assertIncludes } from "./assert";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/**
 * Consolidated pull-warnings test. Exercises situations where sync either
 * refuses (shallow) or emits a warning (stale shadow branch).
 *
 * Phases:
 *   1. shallow-clone — local repo is shallow → sync FAILS with SHALLOW_CLONE
 *      (recovery: remove .git/shallow, sync succeeds)
 *   2. stale-branch — feature branch synced, then deleted on source →
 *      subsequent sync warns about stale shadow branch
 */
export default function run() {
  const env = createTestEnv("pull-warnings");
  try {
    // ── phase 1: shallow-clone ─────────────────────────────────────────
    commitOnRemote(env, { "file.txt": "content\n" }, "Add file for shallow test");
    const head = git("rev-parse HEAD", env.localRepo);
    fs.writeFileSync(path.join(env.localRepo, ".git", "shallow"), head + "\n");
    assertEqual(git("rev-parse --is-shallow-repository", env.localRepo), "true", "[phase 1: shallow] repo is shallow");

    const r1 = runCiSync(env);
    assertEqual(r1.status, 1, "[phase 1] sync should fail on shallow clone");
    assertIncludes(r1.stderr, "SHALLOW_CLONE", "[phase 1] stderr mentions SHALLOW_CLONE");
    assertIncludes(r1.stderr, "unshallow", "[phase 1] stderr suggests fix");

    fs.unlinkSync(path.join(env.localRepo, ".git", "shallow"));
    const r1b = runCiSync(env);
    assertEqual(r1b.status, 0, "[phase 1] sync succeeds after removing shallow marker");

    // ── phase 2: stale-branch warning ──────────────────────────────────
    git("checkout -b feature/temp", env.remoteWorking);
    fs.writeFileSync(path.join(env.remoteWorking, "temp.ts"), "temporary\n");
    git("add temp.ts", env.remoteWorking);
    git('commit -m "Add temp feature"', env.remoteWorking);
    git("push origin feature/temp", env.remoteWorking);
    git("checkout main", env.remoteWorking);

    const r2a = runCiSync(env);
    assertEqual(r2a.status, 0, "[phase 2: stale] sync of feature branch should succeed");
    git("fetch origin", env.localRepo);
    assertEqual(
      git("branch -r", env.localRepo).includes(`origin/${env.branchPrefix}/${env.subdir}/feature/temp`),
      true, "[phase 2] feature shadow created",
    );

    git("push origin --delete feature/temp", env.remoteWorking);
    git(`fetch ${env.remoteName} --prune`, env.localRepo);
    const r2b = runCiSync(env);
    assertEqual(r2b.status, 0, "[phase 2] sync after branch deletion should succeed");
    assertIncludes(r2b.stdout, "Stale shadow branch", "[phase 2] warns about stale branch");
    assertIncludes(r2b.stdout, "feature/temp", "[phase 2] warning mentions deleted branch");
    assertIncludes(r2b.stdout, "--delete", "[phase 2] suggests cleanup command");
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-pull-warnings");
}
