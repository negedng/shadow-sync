import { createTestEnv, addRemote, commitOnRemote, commitOnLocal, runPull, runPush, readLocalFile, readShadowFile, getLocalLogFull } from "./harness";
import { assertEqual, assertIncludes } from "./assert";

/** Test: changes to one remote don't affect the other (isolation). */
export default function run() {
  const env = createTestEnv("multi-iso", "frontend");
  const backend = addRemote(env, "backend", "backend");
  try {
    // Initial sync
    commitOnRemote(env, { "index.html": "<html/>\n" }, "Frontend init");
    commitOnRemote(env, { "main.go": "package main\n" }, "Backend init", backend);
    assertEqual(runPull(env).status, 0, "frontend pull");
    assertEqual(runPull(env, [], backend).status, 0, "backend pull");

    // Modify frontend locally, push only frontend
    commitOnLocal(env, { "index.html": "<html>updated</html>\n" }, "Update frontend");
    const r1 = runPush(env, "Update frontend HTML");
    assertEqual(r1.status, 0, "frontend push");

    // Backend shadow should be unaffected
    assertEqual(readShadowFile(env, "main.go", backend), null, "backend shadow should not have main.go yet (no backend push)");

    // Modify backend on remote, pull only backend
    commitOnRemote(env, { "main.go": "package main\n\nfunc main() {}\n" }, "Update backend", backend);
    const r2 = runPull(env, [], backend);
    assertEqual(r2.status, 0, "backend pull after update");

    // Frontend subdir should be unaffected by backend pull
    assertEqual(readLocalFile(env, "index.html"), "<html>updated</html>\n", "frontend unchanged after backend pull");
    assertEqual(readLocalFile(env, "main.go", backend), "package main\n\nfunc main() {}\n", "backend updated");

    // Verify sync trailers are scoped — re-pulling each remote should be a no-op
    const r3 = runPull(env);
    assertIncludes(r3.stdout, "Already up to date", "frontend should be up to date");
    const r4 = runPull(env, [], backend);
    assertIncludes(r4.stdout, "Already up to date", "backend should be up to date");
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-multi-independent");
}
