import { createTestEnv, commitOnRemote, commitOnLocal, runCiSync, mergeShadow, runPush, getShadowLogFull, getExternalShadowLogFull } from "./harness";
import { assertEqual, assertIncludes, assertNotIncludes } from "./assert";

/**
 * Test: replayed trailers from one direction must NOT match the other direction's
 * trigger pattern. This prevents cascade loops where sync triggers forward
 * triggers sync, etc.
 *
 * The trailer format is: Shadow-replayed ({sourceRemote}): {hash}
 * When syncing from b→a, the source remote is "team" (the test harness default).
 * When syncing from a→b, the source remote is "origin".
 * Each direction's commits must only contain its OWN source remote name,
 * never the other's.
 */
export default function run() {
  const env = createTestEnv("no-cascade");
  try {
    // 1. External team adds a file
    commitOnRemote(env, { "feature.ts": "from b\n" }, "Add feature from B");

    // 2. Sync from b → a (pull)
    const r1 = runCiSync(env);
    assertEqual(r1.status, 0, "sync from b should succeed");

    // 3. Check shadow branch trailers on a's side
    const pullLog = getShadowLogFull(env);
    assertIncludes(pullLog, `Shadow-replayed (${env.remoteName})`,
      "pull commits should have trailer with b's remote name");
    assertNotIncludes(pullLog, "Shadow-replayed (origin)",
      "pull commits must NOT have a's remote name — would trigger a→b cascade");

    // 4. Merge shadow into local, add a local file
    mergeShadow(env);
    commitOnLocal(env, { "local.ts": "from a\n" }, "Add local from A");

    // 5. Sync from a → b (push)
    const r2 = runPush(env, "Push local changes");
    assertEqual(r2.status, 0, "sync from a should succeed");

    // 6. Check shadow branch trailers on b's side
    const pushLog = getExternalShadowLogFull(env);
    assertIncludes(pushLog, "Shadow-replayed (origin)",
      "push commits should have trailer with a's remote name");
    assertNotIncludes(pushLog, `Shadow-replayed (${env.remoteName})`,
      "push commits must NOT have b's remote name — would trigger b→a cascade");

  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-no-cascade");
}
