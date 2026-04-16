import { createTestEnv, commitOnRemote, runCiSync } from "./harness";
import { assertEqual, assertIncludes } from "./assert";
import { execSync, spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/**
 * Consolidated pull-warnings test. Exercises situations where sync either
 * refuses (shallow) or emits a warning (lfs, submodule, symlink, stale).
 *
 * Phases:
 *   1. shallow-clone — local repo is shallow → sync FAILS with SHALLOW_CLONE
 *      (recovery: remove .git/shallow, sync succeeds)
 *   2. stale-branch — feature branch synced, then deleted on source →
 *      subsequent sync warns about stale shadow branch
 *   3. lfs-warn — .gitattributes with LFS filter → warning on stderr
 *   4. submodule-warn — submodule entry in tree → warning
 *   5. symlink-warn — symlink entry in tree → warning
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

    // ── phase 3: lfs-warn ──────────────────────────────────────────────
    fs.writeFileSync(path.join(env.remoteWorking, ".gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs -text\n");
    git("add .gitattributes", env.remoteWorking);
    git('commit -m "Add LFS gitattributes"', env.remoteWorking);
    git("push origin main", env.remoteWorking);
    const r3 = runCiSync(env);
    assertIncludes(r3.stderr, "GIT_LFS", "[phase 3: lfs] stderr mentions GIT_LFS");
    assertIncludes(r3.stderr, "pointer", "[phase 3] stderr mentions pointer files");

    // ── phase 4: submodule-warn ────────────────────────────────────────
    const fakeCommitHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    git(`update-index --add --cacheinfo 160000,${fakeCommitHash},vendor/lib`, env.remoteWorking);
    fs.writeFileSync(
      path.join(env.remoteWorking, ".gitmodules"),
      '[submodule "vendor/lib"]\n\tpath = vendor/lib\n\turl = https://example.com/lib.git\n',
    );
    git("add .gitmodules", env.remoteWorking);
    git('commit -m "Add submodule"', env.remoteWorking);
    git("push origin main", env.remoteWorking);
    const r4 = runCiSync(env);
    assertIncludes(r4.stderr, "SUBMODULE", "[phase 4: submodule] stderr mentions SUBMODULE");
    assertIncludes(r4.stderr, "vendor/lib", "[phase 4] stderr mentions submodule path");

    // ── phase 5: symlink-warn ──────────────────────────────────────────
    const linkTarget = "../config/settings.json";
    const blobResult = spawnSync("git", ["hash-object", "-w", "--stdin"], {
      input: linkTarget, cwd: env.remoteWorking, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    });
    const blobHash = blobResult.stdout.trim();
    git(`update-index --add --cacheinfo 120000,${blobHash},config-link`, env.remoteWorking);
    git('commit -m "Add symlink"', env.remoteWorking);
    git("push origin main", env.remoteWorking);
    const r5 = runCiSync(env);
    assertIncludes(r5.stderr, "SYMLINK", "[phase 5: symlink] stderr mentions SYMLINK");
    assertIncludes(r5.stderr, "config-link", "[phase 5] stderr mentions symlink path");
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-pull-warnings");
}
