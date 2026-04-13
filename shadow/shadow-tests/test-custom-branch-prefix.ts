import { createTestEnv, commitOnRemote, commitOnLocal, runCiSync, mergeShadow, runPush, readShadowFile, readExternalShadowFile, getExternalShadowLogFull, pullRemoteWorking, readRemoteFile } from "./harness";
import { assertEqual, assertIncludes } from "./assert";

/**
 * Verifies that a non-default shadowBranchPrefix (e.g. "shd") works
 * end-to-end: ci-sync pull, export (which now pushes directly to external).
 */
export default function run() {
  const env = createTestEnv("custom-prefix", "frontend", "shd");
  try {
    // 1) Pull: external commit → ci-sync → shadow branch under "shd/" prefix
    commitOnRemote(env, { "hello.txt": "from external\n" }, "Add hello");
    const r1 = runCiSync(env);
    assertEqual(r1.status, 0, "ci-sync should succeed with custom prefix");
    assertIncludes(r1.stdout, "shd/frontend/main", "ci-sync output should reference custom prefix branch");
    mergeShadow(env);

    // Verify the file arrived on origin's shadow branch (import side)
    assertEqual(
      readShadowFile(env, "hello.txt"),
      "from external\n",
      "hello.txt should be on the custom-prefix shadow branch",
    );

    // 2) Push: local commit → export → external's shadow branch
    commitOnLocal(env, { "feature.ts": "export const x = 1;\n" }, "Add feature");
    const r2 = runPush(env, "Push feature");
    assertEqual(r2.status, 0, "export should succeed with custom prefix");
    assertIncludes(r2.stdout, "shd/main", "export output should reference custom prefix branch on external");

    // Verify on external's shadow branch (export side — no prefix)
    assertEqual(
      readExternalShadowFile(env, "feature.ts"),
      "export const x = 1;\n",
      "feature.ts should appear on the external's shadow branch",
    );

    // Export commit should have the forward trailer
    const shadowLog = getExternalShadowLogFull(env);
    assertIncludes(shadowLog, "Shadow-forwarded-from:", "shadow commit should have forward trailer");
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-custom-branch-prefix");
}
