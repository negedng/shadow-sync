import { createTestEnv, addRemote, commitOnRemote, commitOnLocal, runCiSync, mergeShadow, runPush, readShadowFile, readExternalShadowFile, getShadowLogFull, getExternalShadowLogFull } from "./harness";
import { assertEqual, assertIncludes, assertNotIncludes } from "./assert";

/**
 * Consolidated multi-repo test.
 *
 *   env1 (frontend + backend remotes):
 *     1. pull — commits on both remotes land on their own shadow branches
 *     2. push — local changes in both subdirs push to correct external remote
 *     3. isolation — updates to one remote never leak to the other; re-sync
 *        is a no-op
 *
 *   env2 (single remote):
 *     4. no-cascade — replay trailers reference only the source remote,
 *        never the opposite direction's remote (prevents sync↔forward loop)
 */
export default function run() {
  // ── env1: multi-remote sync ─────────────────────────────────────────
  const env1 = createTestEnv("multi-repo-env1", "frontend");
  const backend = addRemote(env1, "backend", "backend");
  try {
    // ── phase 1: pull from both remotes ─────────────────────────────────
    commitOnRemote(env1, { "app.tsx": "export default () => <div/>;\n" }, "Add frontend app");
    commitOnRemote(env1, { "server.ts": "app.listen(3000);\n" }, "Add backend server", backend);

    const r1 = runCiSync(env1);
    assertEqual(r1.status, 0, "[phase 1: multi-pull] ci-sync should succeed");
    assertEqual(readShadowFile(env1, "app.tsx"), "export default () => <div/>;\n", "[phase 1] frontend file on frontend shadow");
    assertEqual(readShadowFile(env1, "server.ts", backend), "app.listen(3000);\n", "[phase 1] backend file on backend shadow");
    assertIncludes(getShadowLogFull(env1), "Shadow-replayed-", "[phase 1] replay trailers present");

    // isolation: each subdir only has its own files
    assertEqual(readShadowFile(env1, "server.ts"), null, "[phase 1] backend file NOT on frontend shadow");
    assertEqual(readShadowFile(env1, "app.tsx", backend), null, "[phase 1] frontend file NOT on backend shadow");

    // ── phase 2: push from both subdirs ─────────────────────────────────
    mergeShadow(env1);
    mergeShadow(env1, backend);

    commitOnLocal(env1, { "new.tsx": "// frontend code\n" }, "Add frontend file");
    commitOnLocal(env1, { "new.ts": "// backend code\n" }, "Add backend file", backend);

    const r2a = runPush(env1, "Push frontend changes");
    assertEqual(r2a.status, 0, "[phase 2: multi-push] frontend push should succeed");
    const r2b = runPush(env1, "Push backend changes", [], backend);
    assertEqual(r2b.status, 0, "[phase 2] backend push should succeed");

    assertEqual(readExternalShadowFile(env1, "new.tsx"), "// frontend code\n", "[phase 2] frontend file on frontend external");
    assertEqual(readExternalShadowFile(env1, "new.ts"), null, "[phase 2] backend file NOT on frontend external");
    assertEqual(readExternalShadowFile(env1, "new.ts", backend), "// backend code\n", "[phase 2] backend file on backend external");
    assertEqual(readExternalShadowFile(env1, "new.tsx", backend), null, "[phase 2] frontend file NOT on backend external");

    // ── phase 3: isolation — update one remote, other unchanged ─────────
    commitOnRemote(env1, { "server.ts": "app.listen(3001);\n" }, "Update backend", backend);
    const r3 = runCiSync(env1);
    assertEqual(r3.status, 0, "[phase 3: isolation] ci-sync should succeed");
    assertEqual(readShadowFile(env1, "server.ts", backend), "app.listen(3001);\n", "[phase 3] backend shadow updated");
    // Frontend unchanged
    assertEqual(readShadowFile(env1, "app.tsx"), "export default () => <div/>;\n", "[phase 3] frontend shadow unchanged");

    // Re-sync is a no-op
    const r3b = runCiSync(env1);
    assertEqual(r3b.status, 0, "[phase 3] re-sync should succeed");
    assertIncludes(r3b.stdout, "up to date", "[phase 3] re-sync reports up-to-date");
  } finally {
    env1.cleanup();
  }

  // ── env2: no-cascade (single remote, trailer direction) ─────────────
  const env2 = createTestEnv("multi-repo-no-cascade");
  try {
    // Pull direction: b→a
    commitOnRemote(env2, { "feature.ts": "from b\n" }, "Add feature from B");
    const r4a = runCiSync(env2);
    assertEqual(r4a.status, 0, "[phase 4: no-cascade] sync from b should succeed");

    const pullLog = getShadowLogFull(env2);
    assertIncludes(pullLog, `Shadow-replayed-${env2.remoteName}:`, "[phase 4] pull has b's remote trailer");
    assertNotIncludes(pullLog, "Shadow-replayed-origin:", "[phase 4] pull must NOT have a's trailer (would cascade)");

    // Push direction: a→b
    mergeShadow(env2);
    commitOnLocal(env2, { "local.ts": "from a\n" }, "Add local from A");
    const r4b = runPush(env2, "Push local changes");
    assertEqual(r4b.status, 0, "[phase 4] sync from a should succeed");

    const pushLog = getExternalShadowLogFull(env2);
    assertIncludes(pushLog, "Shadow-replayed-origin:", "[phase 4] push has a's remote trailer");
    assertNotIncludes(pushLog, `Shadow-replayed-${env2.remoteName}:`, "[phase 4] push must NOT have b's trailer (would cascade)");
  } finally {
    env2.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-multi-repo");
}
