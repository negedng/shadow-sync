import { createTestEnv, commitOnRemote, commitOnLocal, runPull, readLocalFile, getLocalLogFull } from "./harness";
import { assertEqual, assertIncludes } from "./assert";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/** Test: pull must refuse when the local subdir has uncommitted changes. */
export default function run() {
  const env = createTestEnv("pull-uncommitted");
  try {
    // ── Setup: sync an initial file from remote ──────────────────────
    commitOnRemote(env, { "base.txt": "base content\n" }, "Add base.txt");
    const r1 = runPull(env);
    assertEqual(r1.status, 0, "initial pull should succeed");

    // ── Scenario 1: untracked new file in subdir ─────────────────────
    // Drop an untracked file directly into the local subdir (not git-added)
    const untrackedPath = path.join(env.localRepo, env.subdir, "untracked-secret.env");
    fs.writeFileSync(untrackedPath, "SECRET_KEY=abc123\n");

    // Teammate pushes a new commit
    commitOnRemote(env, { "feature.ts": "export const f = 1;\n" }, "Add feature.ts");

    // Pull should REFUSE because there's an untracked file in the subdir
    const r2 = runPull(env);
    assertEqual(r2.status, 1, "pull should fail with untracked file in subdir");
    assertIncludes(r2.stderr, "uncommitted changes", "should mention uncommitted changes");

    // The remote file should NOT have been pulled
    assertEqual(readLocalFile(env, "feature.ts"), null, "feature.ts should not exist yet");

    // Remove the untracked file, now pull should work
    fs.unlinkSync(untrackedPath);
    const r3 = runPull(env);
    assertEqual(r3.status, 0, "pull should succeed after removing untracked file");
    assertEqual(readLocalFile(env, "feature.ts"), "export const f = 1;\n", "feature.ts pulled");

    // ── Scenario 2: unstaged changes to a tracked file ───────────────
    // Modify base.txt on disk without staging — simulates local WIP edits
    const basePath = path.join(env.localRepo, env.subdir, "base.txt");
    fs.writeFileSync(basePath, "base content\nlocal WIP edit\n");

    // Teammate pushes another commit
    commitOnRemote(env, { "utils.ts": "export const u = 2;\n" }, "Add utils.ts");

    // Pull should REFUSE because there are unstaged changes
    const r4 = runPull(env);
    assertEqual(r4.status, 1, "pull should fail with unstaged changes");
    assertIncludes(r4.stderr, "uncommitted changes", "should mention uncommitted changes");

    // Stash the WIP, pull, then restore
    git("stash", env.localRepo);
    const r5 = runPull(env);
    assertEqual(r5.status, 0, `pull should succeed after stashing: ${r5.stderr.slice(0, 300)}`);
    assertEqual(readLocalFile(env, "utils.ts"), "export const u = 2;\n", "utils.ts pulled");
    git("stash pop", env.localRepo);

    // WIP edit should be back on disk
    const baseContent = fs.readFileSync(basePath, "utf8").replace(/\r\n/g, "\n");
    assertEqual(baseContent, "base content\nlocal WIP edit\n", "WIP edit restored after stash pop");

    // ── Scenario 3: staged but uncommitted changes ───────────────────
    git(`add ${env.subdir}/base.txt`, env.localRepo);

    commitOnRemote(env, { "extra.ts": "export const e = 3;\n" }, "Add extra.ts");

    const r6 = runPull(env);
    assertEqual(r6.status, 1, "pull should fail with staged uncommitted changes");
    assertIncludes(r6.stderr, "uncommitted changes", "should mention uncommitted changes");

    // Commit the staged change, pull should work
    git('commit -m "Commit WIP edit"', env.localRepo);
    const r7 = runPull(env);
    assertEqual(r7.status, 0, "pull should succeed after committing");
    assertEqual(readLocalFile(env, "extra.ts"), "export const e = 3;\n", "extra.ts pulled");
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-pull-uncommitted");
}
