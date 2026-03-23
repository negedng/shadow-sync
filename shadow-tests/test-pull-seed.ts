import { createTestEnv, commitOnRemote, runPull, readLocalFile, getLocalLogFull } from "./harness";
import { assertEqual, assertIncludes } from "./assert";

/**
 * Test: --seed records the current remote HEAD as sync baseline.
 * Commits before the seed point are skipped; commits after are mirrored.
 */
export default function run() {
  const env = createTestEnv("pull-seed");
  try {
    // 3 commits exist on remote before seeding
    commitOnRemote(env, { "old1.ts": "old1\n" }, "Add old1");
    commitOnRemote(env, { "old2.ts": "old2\n" }, "Add old2");
    commitOnRemote(env, { "old3.ts": "old3\n" }, "Add old3");

    // Seed — marks all existing remote history as already synced
    const seed = runPull(env, ["--seed"]);
    assertEqual(seed.status, 0, "seed should succeed");
    assertIncludes(seed.stdout, "Seeded", "should print seed confirmation");

    // Verify seed trailer is in the commit log
    const log1 = getLocalLogFull(env);
    assertIncludes(log1, "Shadow-seed:", "should have seed trailer");

    // 2 new commits on remote after seeding
    commitOnRemote(env, { "new1.ts": "new1\n" }, "Add new1");
    commitOnRemote(env, { "new2.ts": "new2\n" }, "Add new2");

    // Normal pull should only mirror the 2 new commits
    const r = runPull(env);
    assertEqual(r.status, 0, "pull should succeed");
    assertIncludes(r.stdout, "2 new commit(s) to mirror", "should find exactly 2 new commits");

    // New files should exist
    assertEqual(readLocalFile(env, "new1.ts"), "new1\n", "new1.ts should be pulled");
    assertEqual(readLocalFile(env, "new2.ts"), "new2\n", "new2.ts should be pulled");

    // Old files should NOT exist (they were before the seed)
    assertEqual(readLocalFile(env, "old1.ts"), null, "old1.ts should not be pulled");
    assertEqual(readLocalFile(env, "old2.ts"), null, "old2.ts should not be pulled");
    assertEqual(readLocalFile(env, "old3.ts"), null, "old3.ts should not be pulled");

    // Re-run should be a no-op
    const r2 = runPull(env);
    assertEqual(r2.status, 0, "second pull should succeed");
    assertIncludes(r2.stdout, "Already up to date", "should be up to date");
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-pull-seed");
}
