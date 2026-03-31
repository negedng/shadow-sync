import { createTestEnv, commitOnRemote, commitOnLocal, runCiSync, runImport, readLocalFile } from "./harness";
import { assertEqual, assertIncludes, assertExitCode } from "./assert";

/**
 * Test: import detects merge conflicts and lets the user resolve them.
 *
 * Scenario: both external and local modify the same file in the same place.
 * Import should exit with code 1 and report the conflicting file, leaving
 * conflict markers in the working tree for the user to resolve.
 */
export default function run() {
  const env = createTestEnv("import-conflict");
  try {
    // Both sides start with the same file
    commitOnRemote(env, { "shared.ts": "line 1\nline 2\nline 3\n" }, "Add shared.ts");
    const r1 = runCiSync(env);
    assertExitCode(r1, 0, "ci-sync should succeed");

    // Import and commit so local has the file
    const r2 = runImport(env);
    assertExitCode(r2, 0, "initial import should succeed");

    // External modifies the file
    commitOnRemote(env, { "shared.ts": "line 1\nexternal change\nline 3\n" }, "External edit");
    const r3 = runCiSync(env);
    assertExitCode(r3, 0, "second ci-sync should succeed");

    // Local modifies the same line in the same file
    commitOnLocal(env, { "shared.ts": "line 1\nlocal change\nline 3\n" }, "Local edit");

    // Import should detect the conflict and exit with code 1
    const r4 = runImport(env);
    assertExitCode(r4, 1, "import should fail with merge conflict");
    assertIncludes(r4.stdout + r4.stderr, "shared.ts", "should report the conflicting file");

    // The working tree should have conflict markers
    const content = readLocalFile(env, "shared.ts")!;
    assertIncludes(content, "<<<<<<<", "should have conflict markers");
    assertIncludes(content, ">>>>>>>", "should have conflict markers");
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-import-conflict");
}
