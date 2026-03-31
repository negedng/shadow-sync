import { createTestEnv, addRemote, commitOnRemote, commitOnLocal, runCiSync, runExport, readShadowFile, mergeShadow } from "./harness";
import { assertEqual, assertIncludes } from "./assert";

/** Test: changes to one remote don't affect the other (isolation). */
export default function run() {
  const env = createTestEnv("multi-iso", "frontend");
  const backend = addRemote(env, "backend", "backend");
  try {
    // Initial sync — CI pulls both remotes
    commitOnRemote(env, { "index.html": "<html/>\n" }, "Frontend init");
    commitOnRemote(env, { "main.go": "package main\n" }, "Backend init", backend);
    const r1 = runCiSync(env);
    assertEqual(r1.status, 0, "ci-sync should succeed");

    // Verify each shadow branch has only its own files
    assertEqual(readShadowFile(env, "index.html"), "<html/>\n", "frontend shadow has index.html");
    assertEqual(readShadowFile(env, "main.go", backend), "package main\n", "backend shadow has main.go");

    // Merge shadow into local, modify frontend, export
    mergeShadow(env);
    commitOnLocal(env, { "index.html": "<html>updated</html>\n" }, "Update frontend");
    const r2 = runExport(env, "Update frontend HTML");
    assertEqual(r2.status, 0, "frontend export");

    // Frontend shadow should be updated
    assertEqual(readShadowFile(env, "index.html"), "<html>updated</html>\n", "frontend shadow updated");

    // Backend shadow should be unaffected
    assertEqual(readShadowFile(env, "main.go", backend), "package main\n", "backend shadow unchanged");

    // Modify backend on external, CI sync again
    commitOnRemote(env, { "main.go": "package main\n\nfunc main() {}\n" }, "Update backend", backend);
    const r3 = runCiSync(env);
    assertEqual(r3.status, 0, "second ci-sync should succeed");

    // Backend shadow updated, frontend shadow unchanged
    assertEqual(readShadowFile(env, "main.go", backend), "package main\n\nfunc main() {}\n", "backend shadow updated");
    assertEqual(readShadowFile(env, "index.html"), "<html>updated</html>\n", "frontend shadow still has our update");

    // Re-sync should be a no-op
    const r4 = runCiSync(env);
    assertEqual(r4.status, 0, "third ci-sync should succeed");
    assertIncludes(r4.stdout, "up to date", "should be up to date");
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-multi-independent");
}
