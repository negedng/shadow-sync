/**
 * Branch-filter tests. Three sub-tests:
 *
 *   1. allows-glob — allowlist with `release/*` matches future release branches
 *      and excludes everything else.
 *   2. strict-empty — file present but no entry for source remote → sync zero
 *      branches, log notes "(after filter)".
 *   3. absent-backcompat — filter map is null (file absent) → all branches sync,
 *      preserving engine-upgrade safety.
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

function run(): void {
  testAllowsGlob();
  testStrictEmpty();
  testAbsentBackcompat();
}

if (require.main === module) {
  run();
  console.log("PASS  test-branch-filter");
}
