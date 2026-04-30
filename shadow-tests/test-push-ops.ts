import { createTestEnv, commitOnRemote, commitOnLocal, runCiSync, mergeShadow, runPush, readExternalShadowFile } from "./harness";
import { assertEqual, assertIncludes } from "./assert";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/**
 * Consolidated push-ops test. Phases:
 *   1. basic add — local commit → push → file on shadow (also doubles as
 *      the original "dry-run" test's only real assertion)
 *   2. rename — `git mv` pushed cleanly: old path gone, new path present
 *   3. deletions — remove a tracked file; shadow reflects deletion
 *   4. no-changes — push without new commits reports "up to date"
 *   5. uncommitted — untracked ignored; unstaged/staged changes refused;
 *      committing WIP then pushing succeeds
 */
export default function run() {
  const env = createTestEnv("push-ops");
  try {
    // Bootstrap — sync external base and merge so the shadow branch exists
    commitOnRemote(env, {
      "base.txt": "base content\n",
      "old-name.ts": "content to rename\n",
      "to-remove.txt": "remove me\n",
    }, "Bootstrap files");
    const b = runCiSync(env);
    assertEqual(b.status, 0, "[bootstrap] pull should succeed");
    mergeShadow(env);

    // ── phase 1: basic add ──────────────────────────────────────────────
    commitOnLocal(env, { "feature.ts": "export const x = 1;\n" }, "Add feature");
    const r1 = runPush(env, "Add feature");
    assertEqual(r1.status, 0, "[phase 1: basic add] push should succeed");
    assertEqual(readExternalShadowFile(env, "feature.ts"), "export const x = 1;\n", "[phase 1] feature.ts on shadow");

    // ── phase 2: rename ─────────────────────────────────────────────────
    git(`mv ${env.subdir}/old-name.ts ${env.subdir}/new-name.ts`, env.localRepo);
    git('commit -m "Rename old-name.ts to new-name.ts"', env.localRepo);
    const r2 = runPush(env);
    assertEqual(r2.status, 0, "[phase 2: rename] push should succeed");
    assertEqual(readExternalShadowFile(env, "new-name.ts"), "content to rename\n", "[phase 2] new name on shadow");
    assertEqual(readExternalShadowFile(env, "old-name.ts"), null, "[phase 2] old name gone on shadow");

    // ── phase 3: deletion ───────────────────────────────────────────────
    commitOnLocal(env, { "to-remove.txt": null }, "Delete to-remove.txt");
    const r3 = runPush(env, "Remove to-remove.txt");
    assertEqual(r3.status, 0, "[phase 3: deletion] push should succeed");
    assertEqual(readExternalShadowFile(env, "to-remove.txt"), null, "[phase 3] file gone on shadow");
    assertEqual(readExternalShadowFile(env, "base.txt"), "base content\n", "[phase 3] other files still present");

    // ── phase 4: no-changes ─────────────────────────────────────────────
    const r4 = runPush(env, "Nothing changed");
    assertEqual(r4.status, 0, "[phase 4: no-changes] push should exit cleanly");
    assertIncludes(r4.stdout, "up to date", "[phase 4] stdout reports up-to-date");

    // ── phase 5: uncommitted edits are invisible to the orchestrator ────
    // Orchestrator-only mode (C4): only committed+pushed state propagates;
    // working-tree edits in the source repo never reach shadow.

    // 5a: untracked file does not reach shadow
    const untrackedPath = path.join(env.localRepo, env.subdir, "local-notes.txt");
    fs.writeFileSync(untrackedPath, "my personal notes\n");
    commitOnLocal(env, { "feature2.ts": "export const y = 2;\n" }, "Add feature2 (with untracked present)");
    const r5a = runPush(env, "Push with untracked file present");
    assertEqual(r5a.status, 0, "[phase 5a] push succeeds even with untracked file");
    assertEqual(readExternalShadowFile(env, "feature2.ts"), "export const y = 2;\n", "[phase 5a] tracked file on shadow");
    assertEqual(readExternalShadowFile(env, "local-notes.txt"), null, "[phase 5a] untracked file NOT on shadow");

    // 5b: unstaged + staged-but-uncommitted edits don't propagate (push succeeds, shadow unchanged)
    const basePath = path.join(env.localRepo, env.subdir, "base.txt");
    fs.writeFileSync(basePath, "base content\nlocal WIP modification\n");
    const r5b = runPush(env, "Push with dirty working tree");
    assertEqual(r5b.status, 0, "[phase 5b] push succeeds; uncommitted edits are invisible");
    assertEqual(readExternalShadowFile(env, "base.txt"), "base content\n", "[phase 5b] shadow unchanged by uncommitted edit");

    git(`add ${env.subdir}/base.txt`, env.localRepo);
    const r5c = runPush(env, "Push with staged but uncommitted");
    assertEqual(r5c.status, 0, "[phase 5c] push succeeds; staged-uncommitted edits are invisible");
    assertEqual(readExternalShadowFile(env, "base.txt"), "base content\n", "[phase 5c] shadow still unchanged");

    // 5d: once committed, the edit propagates
    git('commit -m "Commit the WIP edit"', env.localRepo);
    fs.unlinkSync(untrackedPath);
    const r5d = runPush(env, "Push after committing");
    assertEqual(r5d.status, 0, "[phase 5d] push should succeed after committing");
    assertEqual(
      readExternalShadowFile(env, "base.txt"),
      "base content\nlocal WIP modification\n",
      "[phase 5d] WIP edit propagated to shadow",
    );
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-push-ops");
}
