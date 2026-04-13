import { createTestEnv, commitOnRemote, commitOnLocal, runCiSync, mergeShadow, runPush, readShadowFile } from "./harness";

import { assertEqual } from "./assert";

/**
 * Test: export preserves external changes that arrived via CI sync.
 *
 * Round-trip: external team pushes → CI sync → merge locally → make local
 * changes → export. The shadow branch should have BOTH the external file
 * and the local file. A snapshot approach would overwrite external-only
 * changes; the merge approach preserves them.
 */
export default function run() {
  const env = createTestEnv("push-merge-external");
  try {
    // External team adds a file
    commitOnRemote(env, { "external.ts": "from external team\n" }, "Add external.ts");

    // CI sync pulls it into shadow branch
    const r1 = runCiSync(env);
    assertEqual(r1.status, 0, "ci-sync should succeed");

    // Merge shadow into local working branch so local is up to date
    mergeShadow(env);

    // Make a local change to a different file
    commitOnLocal(env, { "local.ts": "from local team\n" }, "Add local.ts");

    // Export local changes to shadow branch
    const r2 = runPush(env, "Export local.ts");
    assertEqual(r2.status, 0, "push should succeed");

    // Shadow branch should have BOTH files
    assertEqual(
      readShadowFile(env, "external.ts"),
      "from external team\n",
      "external.ts should still exist on shadow branch (not overwritten by export)",
    );
    assertEqual(
      readShadowFile(env, "local.ts"),
      "from local team\n",
      "local.ts should appear on shadow branch",
    );

    // Now test the safeguard: external team adds another file AFTER
    // our last merge. Export should REFUSE until we merge shadow first.
    commitOnRemote(env, { "external2.ts": "second external file\n" }, "Add external2.ts");
    const r3 = runCiSync(env);
    assertEqual(r3.status, 0, "second ci-sync should succeed");

    // DON'T merge shadow locally — export should refuse
    commitOnLocal(env, { "local2.ts": "second local file\n" }, "Add local2.ts");
    const r4 = runPush(env, "Export local2.ts without merging first");
    assertEqual(r4.status, 1, "push should refuse when shadow has unmerged changes");

    // Now merge shadow and retry — should succeed
    mergeShadow(env);
    const r5 = runPush(env, "Export local2.ts after merging shadow");
    assertEqual(r5.status, 0, "push should succeed after merging shadow");

    // Shadow branch should have all four files
    assertEqual(readShadowFile(env, "external.ts"), "from external team\n", "external.ts should persist");
    assertEqual(readShadowFile(env, "local.ts"), "from local team\n", "local.ts should persist");
    assertEqual(readShadowFile(env, "external2.ts"), "second external file\n", "external2.ts should exist");
    assertEqual(readShadowFile(env, "local2.ts"), "second local file\n", "local2.ts should appear on shadow branch");
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-push-merge-with-external-changes");
}
