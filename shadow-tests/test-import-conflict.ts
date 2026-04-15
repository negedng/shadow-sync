import * as fs from "fs";
import * as path from "path";
import { execSync, spawnSync } from "child_process";
import { createTestEnv, commitOnRemote, commitOnLocal, runCiSync, mergeShadow, readLocalFile } from "./harness";
import { assertEqual, assertIncludes, assertExitCode } from "./assert";

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function gitSafe(args: string[], cwd: string) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/**
 * Test: git merge detects conflicts and lets the user resolve them,
 * and files outside {dir}/ are not affected by the merge.
 */
export default function run() {
  const env = createTestEnv("import-conflict");
  try {
    // Both sides start with the same file
    commitOnRemote(env, { "shared.ts": "line 1\nline 2\nline 3\n" }, "Add shared.ts");
    const r1 = runCiSync(env);
    assertExitCode(r1, 0, "ci-sync should succeed");

    // Import via git merge
    mergeShadow(env);

    // Add a file outside {dir}/ on the local branch
    const outsideFile = path.join(env.localRepo, "root-file.txt");
    fs.writeFileSync(outsideFile, "should not be touched\n");
    git("add root-file.txt", env.localRepo);
    git('commit -m "Add root-file.txt"', env.localRepo);

    // External modifies the file
    commitOnRemote(env, { "shared.ts": "line 1\nexternal change\nline 3\n" }, "External edit");
    const r3 = runCiSync(env);
    assertExitCode(r3, 0, "second ci-sync should succeed");

    // Local modifies the same line in the same file
    commitOnLocal(env, { "shared.ts": "line 1\nlocal change\nline 3\n" }, "Local edit");

    // git merge should detect the conflict
    git(`fetch origin shadow/${env.subdir}/main`, env.localRepo);
    const mergeResult = gitSafe(
      ["merge", "--no-ff", `origin/shadow/${env.subdir}/main`],
      env.localRepo,
    );
    assertEqual(mergeResult.status !== 0, true, "merge should fail with conflict");
    assertIncludes(
      mergeResult.stdout + mergeResult.stderr,
      "shared.ts",
      "should report the conflicting file",
    );

    // The working tree should have conflict markers
    const content = readLocalFile(env, "shared.ts")!;
    assertIncludes(content, "<<<<<<<", "should have conflict markers");
    assertIncludes(content, ">>>>>>>", "should have conflict markers");

    // File outside {dir}/ should be untouched
    const outsideContent = fs.readFileSync(outsideFile, "utf8");
    assertEqual(outsideContent, "should not be touched\n", "root-file.txt should not be affected by merge");
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-import-conflict");
}
