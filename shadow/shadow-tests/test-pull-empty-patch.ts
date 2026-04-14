import { createTestEnv, commitOnRemote, runCiSync, getShadowLogFull } from "./harness";
import { assertEqual, assertIncludes } from "./assert";

/** Test: pulling a remote commit that produces no net change locally still gets
 *  recorded (as an empty synced commit) without crashing. */
export default function run() {
  const env = createTestEnv("pull-empty-patch");
  try {
    // Teammate creates a file
    commitOnRemote(env, { "file.txt": "hello\n" }, "Add file");

    // Pull it
    const r1 = runCiSync(env);
    assertEqual(r1.status, 0, "first pull should succeed");

    // Teammate makes a commit that changes and then reverts the file, producing
    // a commit with the same end-state but a non-empty diff from its parent.
    commitOnRemote(env, { "file.txt": "changed\n" }, "Modify file");
    commitOnRemote(env, { "file.txt": "hello\n" }, "Revert file to original");

    // This commit has a non-empty diff on the remote side (from its parent),
    // but after applying to our already-up-to-date subdir, it should be empty.
    const r2 = runCiSync(env);
    assertEqual(r2.status, 0, "pull of redundant commit should succeed");

    // Should record it as synced (empty)
    const log = getShadowLogFull(env);
    assertIncludes(log, "Shadow-replayed (", "should still track the commit");
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-pull-empty-patch");
}
