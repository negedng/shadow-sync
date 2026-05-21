/**
 * Branch-filter tests. Five sub-tests:
 *
 *   1. allows-glob — allowlist with `release/*` matches future release branches
 *      and excludes everything else.
 *   2. strict-empty — file present but no entry for source remote → sync zero
 *      branches, log notes "(after filter)".
 *   3. absent-backcompat — filter map is null (file absent) → all branches sync,
 *      preserving engine-upgrade safety.
 *   4. merged-into-allowed — a filtered branch later merged into an allowed
 *      branch: filtered branch still has no shadow ref of its own, but its
 *      commits reach the shadow via reachability from the merge.
 *   5. orphan-multi-commit — a filtered branch with multiple commits that's
 *      never merged anywhere: zero leakage across multiple sync cycles.
 */
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { createTestEnv, runCiSync } from "./harness";
import { setBranchFiltersForTesting, compileIgnorePattern } from "../shadow-common";
import { assertEqual, assertIncludes } from "./assert";

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function hasShadowBranch(env: ReturnType<typeof createTestEnv>, branch: string): boolean {
  try { git("fetch origin", env.localRepo); } catch { /* empty origin is fine */ }
  return git("branch -r", env.localRepo).includes(`origin/shadow/${env.subdir}/${branch}`);
}

function makeBranchWithCommit(env: ReturnType<typeof createTestEnv>, branch: string, file: string): void {
  git(`checkout -b ${branch}`, env.remoteWorking);
  fs.writeFileSync(path.join(env.remoteWorking, file), `content for ${branch}\n`);
  git(`add ${file}`, env.remoteWorking);
  git(`commit -m "Add ${file} on ${branch}"`, env.remoteWorking);
  git(`push origin ${branch}`, env.remoteWorking);
  git("checkout main", env.remoteWorking);
}

function testAllowsGlob(): void {
  const env = createTestEnv("branch-filter-allows-glob");
  try {
    makeBranchWithCommit(env, "release/v1", "rel1.ts");
    makeBranchWithCommit(env, "feature/x", "fx.ts");

    setBranchFiltersForTesting(new Map([
      [env.remoteName, [compileIgnorePattern("main"), compileIgnorePattern("release/*")]],
    ]));

    const r = runCiSync(env);
    assertEqual(r.status, 0, "[filter-allows-glob] sync should succeed");
    assertEqual(hasShadowBranch(env, "main"),       true,  "[filter-allows-glob] main shadow exists");
    assertEqual(hasShadowBranch(env, "release/v1"), true,  "[filter-allows-glob] release/v1 shadow exists");
    assertEqual(hasShadowBranch(env, "feature/x"),  false, "[filter-allows-glob] feature/x shadow absent");
  } finally {
    setBranchFiltersForTesting(null);
    env.cleanup();
  }
}

function testStrictEmpty(): void {
  const env = createTestEnv("branch-filter-strict-empty");
  try {
    setBranchFiltersForTesting(new Map());

    const r = runCiSync(env);
    assertEqual(r.status, 0, "[filter-strict-empty] sync should succeed (no-op)");
    assertIncludes(r.stdout, "(after filter)", "[filter-strict-empty] log mentions filter exclusion");
    assertEqual(hasShadowBranch(env, "main"), false, "[filter-strict-empty] no main shadow");
  } finally {
    setBranchFiltersForTesting(null);
    env.cleanup();
  }
}

function testAbsentBackcompat(): void {
  const env = createTestEnv("branch-filter-absent-backcompat");
  try {
    makeBranchWithCommit(env, "feature/foo", "foo.ts");
    setBranchFiltersForTesting(null);

    const r = runCiSync(env);
    assertEqual(r.status, 0, "[filter-absent-backcompat] sync should succeed");
    assertEqual(hasShadowBranch(env, "main"),         true, "[filter-absent-backcompat] main shadow exists");
    assertEqual(hasShadowBranch(env, "feature/foo"), true, "[filter-absent-backcompat] feature/foo shadow exists");
  } finally {
    env.cleanup();
  }
}

function testMergedIntoAllowed(): void {
  const env = createTestEnv("branch-filter-merged-into-allowed");
  try {
    // feature/x gets 2 commits; later merged into main.
    git("checkout -b feature/x", env.remoteWorking);
    fs.writeFileSync(path.join(env.remoteWorking, "fx1.ts"), "fx1\n");
    git("add fx1.ts", env.remoteWorking);
    git('commit -m "fx1"', env.remoteWorking);
    fs.writeFileSync(path.join(env.remoteWorking, "fx2.ts"), "fx2\n");
    git("add fx2.ts", env.remoteWorking);
    git('commit -m "fx2"', env.remoteWorking);
    git("push origin feature/x", env.remoteWorking);

    git("checkout main", env.remoteWorking);
    git('merge --no-ff feature/x -m "merge feature/x"', env.remoteWorking);
    git("push origin main", env.remoteWorking);

    // feature/y is filtered AND never merged — control for the leakage check.
    makeBranchWithCommit(env, "feature/y", "fy1.ts");

    setBranchFiltersForTesting(new Map([
      [env.remoteName, [compileIgnorePattern("main")]],
    ]));

    const r = runCiSync(env);
    assertEqual(r.status, 0, "[filter-merged-into-allowed] sync should succeed");

    assertEqual(hasShadowBranch(env, "main"),      true,  "[filter-merged-into-allowed] main shadow exists");
    assertEqual(hasShadowBranch(env, "feature/x"), false, "[filter-merged-into-allowed] feature/x shadow absent (filtered)");
    assertEqual(hasShadowBranch(env, "feature/y"), false, "[filter-merged-into-allowed] feature/y shadow absent (filtered, orphan)");

    git("fetch origin", env.localRepo);
    const shadowMain = `origin/shadow/${env.subdir}/main`;
    const treeFiles = git(`ls-tree -r --name-only ${shadowMain}`, env.localRepo).split("\n").filter(Boolean);
    assertEqual(treeFiles.includes(`${env.subdir}/fx1.ts`), true,  "[filter-merged-into-allowed] fx1.ts reaches shadow/main via merge reachability");
    assertEqual(treeFiles.includes(`${env.subdir}/fx2.ts`), true,  "[filter-merged-into-allowed] fx2.ts reaches shadow/main via merge reachability");
    assertEqual(treeFiles.includes(`${env.subdir}/fy1.ts`), false, "[filter-merged-into-allowed] fy1.ts (orphan filtered) does NOT leak");
  } finally {
    setBranchFiltersForTesting(null);
    env.cleanup();
  }
}

function testOrphanMultiCommit(): void {
  const env = createTestEnv("branch-filter-orphan-multi-commit");
  try {
    // feature/x: 3 commits, never merged. main: just the initial commit.
    git("checkout -b feature/x", env.remoteWorking);
    for (let i = 1; i <= 3; i++) {
      fs.writeFileSync(path.join(env.remoteWorking, `fx${i}.ts`), `fx${i}\n`);
      git(`add fx${i}.ts`, env.remoteWorking);
      git(`commit -m "fx${i}"`, env.remoteWorking);
    }
    git("push origin feature/x", env.remoteWorking);
    git("checkout main", env.remoteWorking);

    setBranchFiltersForTesting(new Map([
      [env.remoteName, [compileIgnorePattern("main")]],
    ]));

    // Two sync cycles — verify the orphan stays orphaned even after re-sync.
    for (let cycle = 1; cycle <= 2; cycle++) {
      const r = runCiSync(env);
      assertEqual(r.status, 0, `[filter-orphan-multi] cycle ${cycle} sync should succeed`);
      assertEqual(hasShadowBranch(env, "feature/x"), false, `[filter-orphan-multi] cycle ${cycle}: feature/x shadow STILL absent`);

      git("fetch origin", env.localRepo);
      const shadowMain = `origin/shadow/${env.subdir}/main`;
      const treeFiles = git(`ls-tree -r --name-only ${shadowMain}`, env.localRepo).split("\n").filter(Boolean);
      for (let i = 1; i <= 3; i++) {
        assertEqual(treeFiles.includes(`${env.subdir}/fx${i}.ts`), false,
          `[filter-orphan-multi] cycle ${cycle}: fx${i}.ts must not leak to shadow/main`);
      }
    }
  } finally {
    setBranchFiltersForTesting(null);
    env.cleanup();
  }
}

function run(): void {
  testAllowsGlob();
  testStrictEmpty();
  testAbsentBackcompat();
  testMergedIntoAllowed();
  testOrphanMultiCommit();
}

if (require.main === module) {
  run();
  console.log("PASS  test-branch-filter");
}
