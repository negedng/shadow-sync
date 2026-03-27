import { createTestEnv, addRemote, commitOnRemote, commitOnLocal, runCiSync, mergeShadow, runPush, readShadowFile } from "./harness";
import { assertEqual } from "./assert";

/** Test: push to two independent remotes from separate subdirs. */
export default function run() {
  const env = createTestEnv("multi-push", "frontend");
  const backend = addRemote(env, "backend", "backend");
  try {
    // Sync initial state from both remotes
    commitOnRemote(env, { "base.txt": "frontend base\n" }, "Frontend base");
    commitOnRemote(env, { "base.txt": "backend base\n" }, "Backend base", backend);
    const r0 = runCiSync(env);
    assertEqual(r0.status, 0, "ci-sync should succeed");
    mergeShadow(env);
    mergeShadow(env, backend);

    // Make local changes to both subdirs
    commitOnLocal(env, { "new.tsx": "// frontend code\n" }, "Add frontend file");
    commitOnLocal(env, { "new.ts": "// backend code\n" }, "Add backend file", backend);

    // Push frontend
    const r1 = runPush(env, "Push frontend changes");
    assertEqual(r1.status, 0, "frontend push should succeed");

    // Push backend
    const r2 = runPush(env, "Push backend changes", [], backend);
    assertEqual(r2.status, 0, "backend push should succeed");

    // Verify each shadow branch only got its own files
    assertEqual(readShadowFile(env, "new.tsx"), "// frontend code\n", "frontend file on frontend shadow");
    assertEqual(readShadowFile(env, "new.ts"), null, "backend file should NOT be on frontend shadow");

    assertEqual(readShadowFile(env, "new.ts", backend), "// backend code\n", "backend file on backend shadow");
    assertEqual(readShadowFile(env, "new.tsx", backend), null, "frontend file should NOT be on backend shadow");
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-multi-push");
}
