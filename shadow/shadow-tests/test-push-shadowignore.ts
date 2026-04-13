import * as fs from "fs";
import * as path from "path";
import { createTestEnv, commitOnRemote, commitOnLocal, runCiSync, mergeShadow, runPush, readExternalShadowFile } from "./harness";
import { assertEqual, assertIncludes } from "./assert";

export default function run() {
  const env = createTestEnv("push-ignore");
  try {
    // Sync initial state
    commitOnRemote(env, { "base.txt": "base\n" }, "Add base");
    const r1 = runCiSync(env);
    mergeShadow(env);
    assertEqual(r1.status, 0, "initial pull should succeed");

    // Create .shadowignore in the local repo (where scripts live)
    fs.writeFileSync(path.join(env.localRepo, ".shadowignore"), "*.local\nsecrets/\n");

    // Add both ignored and non-ignored files
    commitOnLocal(env, {
      "app.ts": "export const app = true;\n",
      "config.local": "secret stuff\n",
    }, "Add app and config");

    // Push
    const r2 = runPush(env, "Push with shadowignore");
    assertEqual(r2.status, 0, "push should succeed");

    // Verify shadow branch
    assertEqual(readExternalShadowFile(env, "app.ts"), "export const app = true;\n", "app.ts should be on shadow branch");
    assertEqual(readExternalShadowFile(env, "config.local"), null, "config.local should NOT be on shadow branch");
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-push-shadowignore");
}
