import { createTestEnv, commitOnRemote, commitOnLocal, runPull, runPush, readShadowFile } from "./harness";
import { assertEqual, assertIncludes, assertExitCode } from "./assert";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/** Test: push must not include untracked files, and must refuse when there are
 *  unstaged modifications to tracked files in the subdirectory. */
export default function run() {
  const env = createTestEnv("push-uncommitted");
  try {
    // ── Setup: sync initial state ────────────────────────────────────
    commitOnRemote(env, { "base.txt": "base content\n" }, "Add base.txt");
    const r1 = runPull(env);
    assertEqual(r1.status, 0, "initial pull should succeed");

    // Add a committed file so there's something to push
    commitOnLocal(env, { "feature.ts": "export const x = 1;\n" }, "Add feature");

    // ── Scenario 1: untracked new file in subdir ─────────────────────
    // Drop an untracked file in the local subdir (not git-added)
    const untrackedPath = path.join(env.localRepo, env.subdir, "local-notes.txt");
    fs.writeFileSync(untrackedPath, "my personal notes\n");

    // Push should succeed (untracked files don't block push)
    // but the untracked file must NOT appear on the shadow branch
    const r2 = runPush(env, "Push with untracked file present");
    assertEqual(r2.status, 0, "push should succeed even with untracked file in subdir");

    assertEqual(
      readShadowFile(env, "feature.ts"),
      "export const x = 1;\n",
      "committed file should appear on shadow branch",
    );
    assertEqual(
      readShadowFile(env, "local-notes.txt"),
      null,
      "untracked file must NOT appear on shadow branch",
    );

    // ── Scenario 2: unstaged changes to a tracked file ───────────────
    // Modify base.txt on disk without staging — simulates local WIP edits
    const basePath = path.join(env.localRepo, env.subdir, "base.txt");
    fs.writeFileSync(basePath, "base content\nlocal WIP modification\n");

    // Push should REFUSE because there are unstaged changes to tracked files
    const r3 = runPush(env, "Push with dirty working tree");
    assertEqual(r3.status, 1, "push should fail with unstaged changes");
    assertIncludes(
      r3.stderr,
      "uncommitted changes",
      "error should mention uncommitted changes",
    );

    // Verify the WIP content did NOT reach the shadow branch
    const shadowBase = readShadowFile(env, "base.txt");
    assertEqual(shadowBase, "base content\n", "shadow base.txt should not have WIP edits");

    // ── Scenario 3: staged but uncommitted changes ───────────────────
    // Stage the modification but don't commit
    git(`add ${env.subdir}/base.txt`, env.localRepo);

    const r4 = runPush(env, "Push with staged but uncommitted changes");
    assertEqual(r4.status, 1, "push should fail with staged uncommitted changes");
    assertIncludes(
      r4.stderr,
      "uncommitted changes",
      "error should mention uncommitted changes for staged files",
    );

    // Clean up: commit the change so working tree is clean, then verify
    // a subsequent push works
    git('commit -m "Commit the WIP edit"', env.localRepo);
    fs.unlinkSync(untrackedPath);

    const r5 = runPush(env, "Push after committing");
    assertEqual(r5.status, 0, "push should succeed after committing changes");

    const finalBase = readShadowFile(env, "base.txt");
    assertEqual(
      finalBase,
      "base content\nlocal WIP modification\n",
      "shadow branch should have the committed WIP edit now",
    );
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-push-uncommitted");
}
