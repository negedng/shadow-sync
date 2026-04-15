import { createTestEnv, commitOnRemote, commitOnLocal, runCiSync, mergeShadow, runPush, readExternalShadowFile } from "./harness";
import { assertEqual } from "./assert";

/** Test: basic export succeeds and file appears on external shadow branch. */
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

    // Push should work
    const r2 = runPush(env, "Real push");
    assertEqual(r2.status, 0, "push should succeed");
    assertEqual(
      readExternalShadowFile(env, "feature.ts"),
      "export const x = 1;\n",
      "file should appear on external shadow branch after push",
    );
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-push-dry-run");
}
