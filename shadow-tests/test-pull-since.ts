import { createTestEnv, commitOnRemote, runPull, readLocalFile } from "./harness";
import { assertEqual, assertIncludes } from "./assert";

/**
 * Test: the --since / SYNC_SINCE parameter filters out commits before the cutoff date.
 *
 * Strategy: create two remote commits with a sleep in between, then pull with
 * a --since date that falls between them. Only the later commit should be mirrored.
 */
export default function run() {
  const env = createTestEnv("pull-since");
  try {
    // First commit — record the time right after it
    commitOnRemote(env, { "old.ts": "old content\n" }, "Add old file");

    // Capture a date between the two commits (ISO format, 1 second from now to be safe)
    const cutoff = new Date(Date.now() + 1000).toISOString();

    // Small sleep so the second commit's author date is clearly after the cutoff.
    const start = Date.now();
    while (Date.now() - start < 1500) { /* busy wait */ }

    // Second commit — after the cutoff
    commitOnRemote(env, { "new.ts": "new content\n" }, "Add new file");

    // Pull with --since set to the cutoff
    const r = runPull(env, ["-s", cutoff]);
    assertEqual(r.status, 0, "pull should succeed");

    // Only the second commit should have been mirrored
    assertIncludes(r.stdout, "1 new commit(s) to mirror", "should find exactly 1 new commit");
    assertEqual(readLocalFile(env, "new.ts"), "new content\n", "new.ts should be pulled");
    assertEqual(readLocalFile(env, "old.ts"), null, "old.ts should NOT be pulled (before cutoff)");

    // A second pull with no --since should pick up the older commit too
    const r2 = runPull(env);
    assertEqual(r2.status, 0, "second pull should succeed");
    assertEqual(readLocalFile(env, "old.ts"), "old content\n", "old.ts should now be present");
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-pull-since");
}
