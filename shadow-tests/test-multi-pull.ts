import { createTestEnv, addRemote, commitOnRemote, runCiSync, readShadowFile, getShadowLogFull } from "./harness";
import { assertEqual, assertIncludes, assertNotEqual } from "./assert";

/** Test: pull from two independent remotes into separate subdirs. */
export default function run() {
  const env = createTestEnv("multi-pull", "frontend");
  const backend = addRemote(env, "backend", "backend");
  try {
    // Teammate commits to frontend remote
    commitOnRemote(env, { "app.tsx": "export default () => <div/>;\n" }, "Add frontend app");

    // Teammate commits to backend remote
    commitOnRemote(env, { "server.ts": "app.listen(3000);\n" }, "Add backend server", backend);

    // Pull frontend
    const r1 = runCiSync(env);
    assertEqual(r1.status, 0, "frontend pull should succeed");
    assertEqual(readShadowFile(env, "app.tsx"), "export default () => <div/>;\n", "frontend file");

    // Pull backend
    const r2 = runCiSync(env);
    assertEqual(r2.status, 0, "backend pull should succeed");
    assertEqual(readShadowFile(env, "server.ts", backend), "app.listen(3000);\n", "backend file");

    // Verify both have sync trailers
    const log = getShadowLogFull(env);
    assertIncludes(log, "Shadow-replayed (", "should have replay trailers");

    // Verify each subdir only has its own files
    assertEqual(readShadowFile(env, "server.ts"), null, "backend file should NOT be in frontend/");
    assertEqual(readShadowFile(env, "app.tsx", backend), null, "frontend file should NOT be in backend/");
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-multi-pull");
}
