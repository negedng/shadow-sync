import { createTestEnv, commitOnRemote, commitOnLocal, runPull, runPush, readShadowFile, getShadowLogFull } from "./harness";
import { assertEqual, assertIncludes } from "./assert";

export default function run() {
  const env = createTestEnv("push-basic");
  try {
    // Sync initial state
    commitOnRemote(env, { "base.txt": "base content\n" }, "Add base.txt");
    const r1 = runPull(env);
    assertEqual(r1.status, 0, "initial pull should succeed");

    // Add a file locally and commit
    commitOnLocal(env, { "new-feature.ts": "export function feat() {}\n" }, "Add new feature");

    // Export to shadow branch
    const r2 = runPush(env, "Add new feature from mono-repo");
    assertEqual(r2.status, 0, "export should succeed");
    assertIncludes(r2.stdout, "Done", "should report done");

    // Verify on the shadow branch
    assertEqual(
      readShadowFile(env, "new-feature.ts"),
      "export function feat() {}\n",
      "new-feature.ts should appear on shadow branch",
    );

    // Shadow commit should have the commit message
    const shadowLog = getShadowLogFull(env);
    assertIncludes(shadowLog, "Add new feature from mono-repo", "shadow commit should have the message");
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-push-basic");
}
