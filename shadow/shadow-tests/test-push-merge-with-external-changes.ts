import { createTestEnv, commitOnRemote, commitOnLocal, runCiSync, mergeShadow, runPush, readExternalShadowFile } from "./harness";

import { assertEqual } from "./assert";

/**
 * Test: export preserves external changes that arrived via CI sync.
 *
 * Round-trip: external team pushes → CI sync → merge locally → make local
 * changes → export. The external's shadow branch should have BOTH the
 * external file and the local file.
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

    // Export local changes to external's shadow branch
    const r2 = runPush(env, "Export local.ts");
    assertEqual(r2.status, 0, "push should succeed");

    // External shadow branch should have the local file (prefix-stripped)
    assertEqual(
      readExternalShadowFile(env, "local.ts"),
      "from local team\n",
      "local.ts should appear on external shadow branch",
    );

    // Second round: more external changes + more local changes
    commitOnRemote(env, { "external2.ts": "second external file\n" }, "Add external2.ts");
    const r3 = runCiSync(env);
    assertEqual(r3.status, 0, "second ci-sync should succeed");

    mergeShadow(env);
    commitOnLocal(env, { "local2.ts": "second local file\n" }, "Add local2.ts");
    const r4 = runPush(env, "Export local2.ts after merging shadow");
    assertEqual(r4.status, 0, "push should succeed after merging shadow");

    // External shadow branch should have both local files
    assertEqual(readExternalShadowFile(env, "local.ts"), "from local team\n", "local.ts should persist");
    assertEqual(readExternalShadowFile(env, "local2.ts"), "second local file\n", "local2.ts should appear on external shadow branch");
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-push-merge-with-external-changes");
}
