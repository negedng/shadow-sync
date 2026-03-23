import { createTestEnv, commitOnRemote, commitOnLocal, runPull, runPush, pullRemoteWorking, readRemoteFile } from "./harness";
import { assertEqual, assertIncludes } from "./assert";

/** Test: push handles the case where remote has advanced since the last pull.
 *  Shadow-push fetches latest before creating the worktree, so a concurrent
 *  change that happened before our fetch is included in the base. The push
 *  will delete remote-only files since the monorepo subdir is the source of truth. */
export default function run() {
  const env = createTestEnv("push-concurrent");
  try {
    // Initial sync
    commitOnRemote(env, { "base.txt": "base\n" }, "Add base");
    const r1 = runPull(env);
    assertEqual(r1.status, 0, "initial pull should succeed");

    // Add local change
    commitOnLocal(env, { "local.ts": "export const local = true;\n" }, "Add local");

    // Someone pushes to remote before we push — but shadow-push will fetch
    // this before building the worktree
    commitOnRemote(env, { "concurrent.txt": "someone else\n" }, "Concurrent push");

    // Shadow-push fetches latest, builds worktree from updated ref, then syncs
    // local subdir into it. Since concurrent.txt is not in local subdir, it gets deleted.
    // This is correct behavior: push syncs local state -> remote.
    const r2 = runPush(env, "Push local state");
    assertEqual(r2.status, 0, "push should succeed");

    pullRemoteWorking(env);
    assertEqual(
      readRemoteFile(env, "local.ts"),
      "export const local = true;\n",
      "our file should be on remote",
    );
    // concurrent.txt is intentionally deleted because it doesn't exist in the local subdir
    assertEqual(
      readRemoteFile(env, "concurrent.txt"),
      null,
      "concurrent file should be deleted (local subdir is source of truth for push)",
    );

    // Now test the other direction: pull the remote changes first, then push
    // This is the correct workflow for preserving concurrent changes.
    commitOnRemote(env, { "teammate.txt": "teammate work\n" }, "Teammate commit");
    const r3 = runPull(env);
    assertEqual(r3.status, 0, "pull should sync teammate work");

    commitOnLocal(env, { "local2.ts": "export const y = 2;\n" }, "Add local2");
    const r4 = runPush(env, "Push after pulling");
    assertEqual(r4.status, 0, "push after pull should succeed");

    pullRemoteWorking(env);
    assertEqual(
      readRemoteFile(env, "teammate.txt"),
      "teammate work\n",
      "teammate file preserved when pulled first",
    );
    assertEqual(
      readRemoteFile(env, "local2.ts"),
      "export const y = 2;\n",
      "local2 should be on remote",
    );
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-push-concurrent");
}
