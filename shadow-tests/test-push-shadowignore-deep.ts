import { createTestEnv, commitOnRemote, commitOnLocal, runCiSync, mergeShadow, runPush, readExternalShadowFile } from "./harness";
import { assertEqual } from "./assert";

// Verify that ** glob patterns in .shadowignore exclude files at any depth.
// E.g. "**\/CLAUDE.md" should exclude CLAUDE.md in root and nested dirs.
export default function run() {
  const env = createTestEnv("push-ignore-deep");
  try {
    // Sync initial state
    commitOnRemote(env, { "base.txt": "base\n" }, "Add base");
    const r1 = runCiSync(env);
    mergeShadow(env);
    assertEqual(r1.status, 0, "initial pull should succeed");

    // Add .shadowignore with ** pattern alongside the source files
    commitOnLocal(env, {
      ".shadowignore": "**/CLAUDE.md\n",
      "app.ts": "export const app = true;\n",
      "CLAUDE.md": "# root claude\n",
      "src/CLAUDE.md": "# nested claude\n",
      "src/deep/CLAUDE.md": "# deeply nested claude\n",
      "src/deep/real.ts": "export const real = 1;\n",
    }, "Add files with CLAUDE.md at multiple depths");

    // Push
    const r2 = runPush(env, "Push with deep shadowignore");
    assertEqual(r2.status, 0, "push should succeed");

    // Verify shadow branch
    assertEqual(readExternalShadowFile(env, "app.ts"), "export const app = true;\n", "app.ts should be on shadow branch");
    assertEqual(readExternalShadowFile(env, "src/deep/real.ts"), "export const real = 1;\n", "real.ts should be on shadow branch");
    assertEqual(readExternalShadowFile(env, "CLAUDE.md"), null, "root CLAUDE.md should NOT be on shadow branch");
    assertEqual(readExternalShadowFile(env, "src/CLAUDE.md"), null, "nested CLAUDE.md should NOT be on shadow branch");
    assertEqual(readExternalShadowFile(env, "src/deep/CLAUDE.md"), null, "deeply nested CLAUDE.md should NOT be on shadow branch");
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-push-shadowignore-deep");
}
