import { createTestEnv, commitOnRemote, runCiSync, readShadowFile, getShadowLogFull } from "./harness";
import { assertEqual, assertIncludes } from "./assert";
import { execSync, spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/**
 * Consolidated pull-paths test. Phases:
 *   1. deep-dirs — deeply nested paths
 *   2. deletions → delete-readd → revert — file lifecycle on a single path
 *   3. empty-message — --allow-empty-message commit replays with a trailer
 *   4. tag-sync — tag on source, sync, characterize tag propagation
 *   5. unicode-names — unicode file + branch name
 *   6. case-conflict — terminal: expects ci-sync to FAIL (only on Win/mac)
 *
 * Note: case-conflict must be last because it commits a poisonous tree
 * (two files differing only in case) that will block any subsequent sync.
 */
export default function run() {
  const env = createTestEnv("pull-paths");
  try {
    // ── phase 1: deep-dirs ─────────────────────────────────────────────
    commitOnRemote(env, {
      "src/components/Button.tsx": "export const Button = () => {};\n",
      "src/utils/helpers/format.ts": "export function format() {}\n",
      "docs/api/v1/README.md": "# API v1\n",
    }, "Add deeply nested files");
    const r1 = runCiSync(env);
    assertEqual(r1.status, 0, "[phase 1: deep-dirs] should succeed");
    assertEqual(readShadowFile(env, "src/components/Button.tsx"), "export const Button = () => {};\n", "[phase 1] tsx");
    assertEqual(readShadowFile(env, "src/utils/helpers/format.ts"), "export function format() {}\n", "[phase 1] triple-nested");
    assertEqual(readShadowFile(env, "docs/api/v1/README.md"), "# API v1\n", "[phase 1] docs");

    // ── phase 2: deletions → delete-readd → revert ─────────────────────
    commitOnRemote(env, { "foo.ts": "v1\n" }, "Add foo.ts");
    const r2a = runCiSync(env);
    assertEqual(r2a.status, 0, "[phase 2a: add] should succeed");
    assertEqual(readShadowFile(env, "foo.ts"), "v1\n", "[phase 2a] foo.ts present");

    commitOnRemote(env, { "foo.ts": null }, "Delete foo.ts");
    const r2b = runCiSync(env);
    assertEqual(r2b.status, 0, "[phase 2b: delete] should succeed");
    assertEqual(readShadowFile(env, "foo.ts"), null, "[phase 2b] foo.ts absent");

    commitOnRemote(env, { "foo.ts": "v1\n" }, "Readd foo.ts");
    const r2c = runCiSync(env);
    assertEqual(r2c.status, 0, "[phase 2c: readd] should succeed");
    assertEqual(readShadowFile(env, "foo.ts"), "v1\n", "[phase 2c] foo.ts present again");

    // Revert the readd → foo.ts gone again
    git("revert --no-edit HEAD", env.remoteWorking);
    git("push origin main", env.remoteWorking);
    const r2d = runCiSync(env);
    assertEqual(r2d.status, 0, "[phase 2d: revert] should succeed");
    assertEqual(readShadowFile(env, "foo.ts"), null, "[phase 2d] foo.ts absent after revert");

    // ── phase 3: empty-message ─────────────────────────────────────────
    fs.writeFileSync(path.join(env.remoteWorking, "empty-msg.ts"), "E\n");
    git("add empty-msg.ts", env.remoteWorking);
    git('commit --allow-empty-message -m ""', env.remoteWorking);
    git("push origin main", env.remoteWorking);
    const r3 = runCiSync(env);
    assertEqual(r3.status, 0, "[phase 3: empty-message] should succeed");
    assertEqual(readShadowFile(env, "empty-msg.ts"), "E\n", "[phase 3] file synced");

    // ── phase 4: tag-sync ──────────────────────────────────────────────
    commitOnRemote(env, { "release.ts": "v1\n" }, "Release v1");
    git('tag -a v1.0.0 -m "Version 1.0.0"', env.remoteWorking);
    git("push origin main --tags", env.remoteWorking);
    const r4 = runCiSync(env);
    assertEqual(r4.status, 0, "[phase 4: tag-sync] should succeed");
    assertEqual(readShadowFile(env, "release.ts"), "v1\n", "[phase 4] tagged content on shadow");
    // Characterize (not assert): tag propagation to origin
    git("fetch origin --tags", env.localRepo);
    const tagOnOrigin = git("tag -l", env.localRepo).includes("v1.0.0");
    console.log(`    [phase 4 info] tag v1.0.0 on origin: ${tagOnOrigin}`);

    // ── phase 5: unicode-names ─────────────────────────────────────────
    git("config core.quotePath false", env.remoteWorking);
    git("config core.quotePath false", env.localRepo);
    const uniBranch = "feature/日本語";
    git(`checkout -b "${uniBranch}"`, env.remoteWorking);
    const uniFile = "résumé.ts";
    fs.writeFileSync(path.join(env.remoteWorking, uniFile), "こんにちは // résumé\n");
    git(`add "${uniFile}"`, env.remoteWorking);
    git('commit -m "Add résumé.ts (unicode)"', env.remoteWorking);
    git(`push origin "${uniBranch}"`, env.remoteWorking);
    // Return to main so later phases don't run on the feature branch
    git("checkout main", env.remoteWorking);
    const r5 = runCiSync(env);
    assertEqual(r5.status, 0, "[phase 5: unicode] should succeed");
    git("fetch origin", env.localRepo);
    const uniContent = git(`show "origin/shadow/${env.subdir}/${uniBranch}:${env.subdir}/${uniFile}"`, env.localRepo);
    assertEqual(uniContent, "こんにちは // résumé", "[phase 5] unicode file content on shadow");
    const refs = git("branch -r", env.localRepo);
    assertEqual(refs.includes(`origin/shadow/${env.subdir}/feature/日本語`), true, "[phase 5] unicode shadow branch exists");

    // Sanity: accumulated log has multiple trailers
    const log = getShadowLogFull(env);
    const trailerCount = (log.match(/Shadow-replayed-[^:]+:/g) ?? []).length;
    if (trailerCount < 5) throw new Error(`expected >=5 replay trailers, got ${trailerCount}`);

    // ── phase 6: case-conflict (terminal — expects FAILURE) ───────────
    // Only meaningful on case-insensitive filesystems.
    if (process.platform === "win32" || process.platform === "darwin") {
      const blob1 = spawnSync("git", ["hash-object", "-w", "--stdin"], {
        input: "content of README2.md\n", cwd: env.remoteWorking, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
      }).stdout.trim();
      const blob2 = spawnSync("git", ["hash-object", "-w", "--stdin"], {
        input: "content of readme2.md\n", cwd: env.remoteWorking, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
      }).stdout.trim();
      git(`update-index --add --cacheinfo 100644,${blob1},docs/case/README2.md`, env.remoteWorking);
      git(`update-index --add --cacheinfo 100644,${blob2},docs/case/readme2.md`, env.remoteWorking);
      git('commit -m "Add case-conflicting files"', env.remoteWorking);
      git("push origin main", env.remoteWorking);
      const r6 = runCiSync(env);
      assertEqual(r6.status, 1, "[phase 6: case-conflict] should FAIL");
      assertIncludes(r6.stderr, "CASE_CONFLICT", "[phase 6] should mention CASE_CONFLICT");
      assertIncludes(r6.stderr, "README2.md", "[phase 6] should mention README2.md");
      assertIncludes(r6.stderr, "readme2.md", "[phase 6] should mention readme2.md");
    } else {
      console.log("    [phase 6 info] case-conflict skipped on this platform");
    }
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-pull-paths");
}
