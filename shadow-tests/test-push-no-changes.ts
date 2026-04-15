import { createTestEnv, commitOnRemote, runCiSync, mergeShadow, runPush } from "./harness";
import { assertEqual, assertIncludes } from "./assert";

export default function run() {
  const env = createTestEnv("push-noop");
  try {
    // Sync state
    commitOnRemote(env, { "file.txt": "content\n" }, "Add file");
    const r1 = runCiSync(env);
    mergeShadow(env);
    assertEqual(r1.status, 0, "pull should succeed");

    // First push creates the shadow branch with current content
    const r2 = runPush(env, "Initial push");
    assertEqual(r2.status, 0, "initial push should succeed");

    // Second push without any new local changes — should report no changes
    const r3 = runPush(env, "Nothing changed");
    assertEqual(r3.status, 0, "push should exit cleanly");
    assertIncludes(r3.stdout, "up to date", "should report no changes");
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-push-no-changes");
}
