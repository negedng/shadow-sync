import { createTestEnv, commitOnRemote, runCiSync, readShadowFile } from "./harness";
import { assertEqual, assertIncludes } from "./assert";

export default function run() {
  const env = createTestEnv("pull-del");
  try {
    // Teammate adds a file, pull it
    commitOnRemote(env, { "temp.txt": "will be deleted\n" }, "Add temp.txt");
    const r1 = runCiSync(env);
    assertEqual(r1.status, 0, "first pull should succeed");
    assertEqual(readShadowFile(env, "temp.txt"), "will be deleted\n", "temp.txt should exist");

    // Teammate deletes the file
    commitOnRemote(env, { "temp.txt": null }, "Delete temp.txt");
    const r2 = runCiSync(env);
    assertEqual(r2.status, 0, "second pull should succeed");
    assertEqual(readShadowFile(env, "temp.txt"), null, "temp.txt should be deleted");
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-pull-deletions");
}
