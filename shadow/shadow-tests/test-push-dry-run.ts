import { createTestEnv, commitOnRemote, commitOnLocal, runCiSync, mergeShadow, runPush, readShadowFile } from "./harness";
import { assertEqual, assertIncludes } from "./assert";

/** Test: --dry-run shows changes without pushing. */
export default function run() {
  const env = createTestEnv("push-dry-run");
  try {
    // Sync initial state
    commitOnRemote(env, { "base.txt": "base\n" }, "Add base");
    const r1 = runCiSync(env);
    mergeShadow(env);
    assertEqual(r1.status, 0, "initial pull should succeed");

    // Add file locally
    commitOnLocal(env, { "feature.ts": "export const x = 1;\n" }, "Add feature");

    // Dry-run push
    const r2 = runPush(env, "Dry run push", ["-n"]);
    assertEqual(r2.status, 0, "dry-run push should succeed");
    assertIncludes(r2.stdout, "DRY RUN", "should mention dry run");

    // File should NOT appear on shadow branch
    assertEqual(readShadowFile(env, "feature.ts"), null, "file should not be on shadow branch after dry-run");

    // Real push should still work
    const r3 = runPush(env, "Real push");
    assertEqual(r3.status, 0, "real push should succeed");
    assertEqual(
      readShadowFile(env, "feature.ts"),
      "export const x = 1;\n",
      "file should appear on shadow branch after real push",
    );
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-push-dry-run");
}
