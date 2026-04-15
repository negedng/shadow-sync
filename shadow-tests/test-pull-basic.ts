import { createTestEnv, commitOnRemote, runCiSync, readShadowFile, getShadowLogFull } from "./harness";
import { assertEqual, assertIncludes } from "./assert";

export default function run() {
  const env = createTestEnv("pull-basic");
  try {
    // Teammate makes two commits
    commitOnRemote(env, { "app.ts": "console.log('hello');\n" }, "Add app.ts");
    commitOnRemote(env, { "utils.ts": "export const x = 1;\n" }, "Add utils.ts");

    // CI sync replays them into shadow branch
    const r1 = runCiSync(env);
    assertEqual(r1.status, 0, "ci-sync should succeed");
    assertIncludes(r1.stdout, "Replayed", "should replay commits");

    // Files exist on shadow branch
    assertEqual(readShadowFile(env, "app.ts"), "console.log('hello');\n", "app.ts content");
    assertEqual(readShadowFile(env, "utils.ts"), "export const x = 1;\n", "utils.ts content");

    // Commit messages have sync trailers
    const log = getShadowLogFull(env);
    assertIncludes(log, "Shadow-replayed (", "should have replay trailer");

    // Re-run is a no-op
    const r2 = runCiSync(env);
    assertEqual(r2.status, 0, "second ci-sync should succeed");
    assertIncludes(r2.stdout, "up to date", "should be up to date");
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-pull-basic");
}
