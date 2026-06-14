/**
 * Consolidated paths/branches/warnings/shadowignore test. Four sub-tests:
 *
 *   A. paths — deep dirs, deletions/revert, empty-message, tag sync,
 *      unicode (CJK + Hungarian Latin-extended), case-conflict
 *      (formerly test-pull-paths.ts)
 *   B. warnings — shallow clone refusal + stale shadow branch
 *      (formerly test-pull-warnings.ts)
 *   C. branches — feature, feature-range, orphan, custom branch prefix
 *      (formerly test-pull-branches.ts)
 *   D. shadowignore — ignore patterns, rename in/out of ignore,
 *      unignore-by-pattern-removal, history audit
 *      (formerly test-push-shadowignore.ts)
 *   E. multi-level .shadowignore + implicit self-strip
 *   F. multi-pair root .shadowignore — root cascades into every pair
 */
import * as fs from "fs";
import * as path from "path";
import { execSync, spawnSync } from "child_process";
import {
  createTestEnv, addRemote, commitOnRemote, commitOnLocal,
  runCiSync, mergeShadow, runPush,
  readShadowFile, readExternalShadowFile,
  getShadowLogFull, getExternalShadowLogFull,
  setTestBranchAllowlist,
} from "./harness";
import { assertEqual, assertIncludes } from "./assert";

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

// ── A. paths: deep dirs, deletions, tags, unicode, case-conflict ────────────
// Phase 6 (case-conflict) is terminal — must run last in the shared env.
function runPullPaths(env: ReturnType<typeof createTestEnv>): void {
  {
    // phase 1: deep-dirs
    commitOnRemote(env, {
      "src/components/Button.tsx": "export const Button = () => {};\n",
      "src/utils/helpers/format.ts": "export function format() {}\n",
      "docs/api/v1/README.md": "# API v1\n",
    }, "Add deeply nested files");
    const r1 = runCiSync(env);
    assertEqual(r1.status, 0, "[paths 1: deep-dirs] should succeed");
    assertEqual(readShadowFile(env, "src/components/Button.tsx"), "export const Button = () => {};\n", "[paths 1] tsx");
    assertEqual(readShadowFile(env, "src/utils/helpers/format.ts"), "export function format() {}\n", "[paths 1] triple-nested");
    assertEqual(readShadowFile(env, "docs/api/v1/README.md"), "# API v1\n", "[paths 1] docs");

    // phase 2: deletions → delete-readd → revert
    commitOnRemote(env, { "foo.ts": "v1\n" }, "Add foo.ts");
    const r2a = runCiSync(env);
    assertEqual(r2a.status, 0, "[paths 2a: add] should succeed");
    assertEqual(readShadowFile(env, "foo.ts"), "v1\n", "[paths 2a] foo.ts present");

    commitOnRemote(env, { "foo.ts": null }, "Delete foo.ts");
    const r2b = runCiSync(env);
    assertEqual(r2b.status, 0, "[paths 2b: delete] should succeed");
    assertEqual(readShadowFile(env, "foo.ts"), null, "[paths 2b] foo.ts absent");

    commitOnRemote(env, { "foo.ts": "v1\n" }, "Readd foo.ts");
    const r2c = runCiSync(env);
    assertEqual(r2c.status, 0, "[paths 2c: readd] should succeed");
    assertEqual(readShadowFile(env, "foo.ts"), "v1\n", "[paths 2c] foo.ts present again");

    git("revert --no-edit HEAD", env.remoteWorking);
    git("push origin main", env.remoteWorking);
    const r2d = runCiSync(env);
    assertEqual(r2d.status, 0, "[paths 2d: revert] should succeed");
    assertEqual(readShadowFile(env, "foo.ts"), null, "[paths 2d] foo.ts absent after revert");

    // phase 3: empty-message
    fs.writeFileSync(path.join(env.remoteWorking, "empty-msg.ts"), "E\n");
    git("add empty-msg.ts", env.remoteWorking);
    git('commit --allow-empty-message -m ""', env.remoteWorking);
    git("push origin main", env.remoteWorking);
    const r3 = runCiSync(env);
    assertEqual(r3.status, 0, "[paths 3: empty-message] should succeed");
    assertEqual(readShadowFile(env, "empty-msg.ts"), "E\n", "[paths 3] file synced");

    // phase 4: tag-sync — annotated + lightweight tags propagate to target
    commitOnRemote(env, { "release.ts": "v1\n" }, "Release v1");
    git('tag -a v1.0.0 -m "Version 1.0.0"', env.remoteWorking);
    git('tag v1.0.0-lw', env.remoteWorking);
    git("push origin main --tags", env.remoteWorking);
    const r4 = runCiSync(env, { tags: true });
    assertEqual(r4.status, 0, "[paths 4: tag-sync] should succeed");
    assertEqual(readShadowFile(env, "release.ts"), "v1\n", "[paths 4] tagged content on shadow");

    const originTags = spawnSync(
      "git", ["for-each-ref", "refs/tags", "--format=%(refname:short)|%(objecttype)"],
      { cwd: env.originBare, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    ).stdout.trim().split("\n").filter(Boolean).sort();
    assertEqual(originTags.join(","), "v1.0.0-lw|commit,v1.0.0|tag",
      "[paths 4] both annotated and lightweight tags propagated, types preserved");

    const peel = (cwd: string) => spawnSync("git", ["rev-parse", "v1.0.0^{commit}"],
      { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).stdout.trim();
    const sourceTagCommit = peel(env.remoteWorking);
    const targetTagCommit = peel(env.originBare);
    assertEqual(targetTagCommit !== sourceTagCommit, true,
      "[paths 4] tag points to replayed commit (different SHA), not source commit");

    const targetTagBody = execSync(`git -C "${env.originBare}" cat-file tag v1.0.0`, {
      encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    });
    assertIncludes(targetTagBody, "Version 1.0.0", "[paths 4] annotated tag message preserved on target");
    assertIncludes(targetTagBody, `object ${targetTagCommit}`, "[paths 4] annotated tag's object header points to replay");

    // phase 5: unicode-names (CJK). No core.quotePath override — the engine's
    // -z plumbing parsing must work under the quoting default.
    const uniBranch = "feature/日本語";
    git(`checkout -b "${uniBranch}"`, env.remoteWorking);
    const uniFile = "résumé.ts";
    fs.writeFileSync(path.join(env.remoteWorking, uniFile), "こんにちは // résumé\n");
    git(`add "${uniFile}"`, env.remoteWorking);
    git('commit -m "Add résumé.ts (unicode)"', env.remoteWorking);
    git(`push origin "${uniBranch}"`, env.remoteWorking);
    git("checkout main", env.remoteWorking);
    const r5 = runCiSync(env);
    assertEqual(r5.status, 0, "[paths 5: unicode] should succeed");
    git("fetch origin", env.localRepo);
    const uniContent = git(`show "origin/shadow/${env.subdir}/${uniBranch}:${env.subdir}/${uniFile}"`, env.localRepo);
    assertEqual(uniContent, "こんにちは // résumé", "[paths 5] unicode file content on shadow");
    const refs = git("branch -r", env.localRepo);
    assertEqual(refs.includes(`origin/shadow/${env.subdir}/feature/日本語`), true,
      "[paths 5] unicode shadow branch exists");

    // phase 5b: Hungarian (Latin-extended + spaces + parens)
    git("checkout main", env.remoteWorking);
    const huDir = "doc/help/meghatározott cselekmény végrehajtása (v1)";
    fs.mkdirSync(path.join(env.remoteWorking, huDir), { recursive: true });
    const huFile = `${huDir}/szélessávú mérés.md`;
    fs.writeFileSync(path.join(env.remoteWorking, huFile), "Tartalom árvíztűrő tükörfúrógép.\n");
    git(`add -A`, env.remoteWorking);
    git('commit -m "Add Hungarian-named asset"', env.remoteWorking);
    git("push origin main", env.remoteWorking);
    const r5b = runCiSync(env);
    assertEqual(r5b.status, 0, "[paths 5b: hu-names] should succeed");
    git("fetch origin", env.localRepo);
    const huShadowPath = `origin/shadow/${env.subdir}/main:${env.subdir}/${huFile}`;
    const huContent = spawnSync("git", ["show", huShadowPath], {
      cwd: env.localRepo, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    }).stdout.replace(/\r\n/g, "\n");
    assertEqual(huContent, "Tartalom árvíztűrő tükörfúrógép.\n", "[paths 5b] hu file content on shadow");

    const log = getShadowLogFull(env);
    const trailerCount = (log.match(/Shadow-replayed-[^:]+:/g) ?? []).length;
    if (trailerCount < 5) throw new Error(`expected >=5 replay trailers, got ${trailerCount}`);

    // phase 6: case-conflict (Win/mac only — terminal)
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
      assertEqual(r6.status, 1, "[paths 6: case-conflict] should FAIL");
      assertIncludes(r6.stderr, "CASE_CONFLICT", "[paths 6] should mention CASE_CONFLICT");
      assertIncludes(r6.stderr, "README2.md", "[paths 6] should mention README2.md");
      assertIncludes(r6.stderr, "readme2.md", "[paths 6] should mention readme2.md");
    } else {
      console.log("    [paths 6 info] case-conflict skipped on this platform");
    }
  }
}

// ── B. warnings: shallow clone + stale shadow branch ────────────────────────
// Needs its own env (manipulates .git/shallow on a fresh clone).
function runWarnings(): void {
  const env = createTestEnv("pull-warnings");
  try {
    // phase 1: shallow-clone refusal
    commitOnRemote(env, { "file.txt": "content\n" }, "Add file for shallow test");
    const head = git("rev-parse HEAD", env.localRepo);
    fs.writeFileSync(path.join(env.localRepo, ".git", "shallow"), head + "\n");
    assertEqual(git("rev-parse --is-shallow-repository", env.localRepo), "true",
      "[warnings 1: shallow] repo is shallow");

    const r1 = runCiSync(env);
    assertEqual(r1.status, 1, "[warnings 1] sync should fail on shallow clone");
    assertIncludes(r1.stderr, "SHALLOW_CLONE", "[warnings 1] stderr mentions SHALLOW_CLONE");
    assertIncludes(r1.stderr, "unshallow", "[warnings 1] stderr suggests fix");

    fs.unlinkSync(path.join(env.localRepo, ".git", "shallow"));
    const r1b = runCiSync(env);
    assertEqual(r1b.status, 0, "[warnings 1] sync succeeds after removing shallow marker");

    // phase 2: stale-branch warning
    git("checkout -b feature/temp", env.remoteWorking);
    fs.writeFileSync(path.join(env.remoteWorking, "temp.ts"), "temporary\n");
    git("add temp.ts", env.remoteWorking);
    git('commit -m "Add temp feature"', env.remoteWorking);
    git("push origin feature/temp", env.remoteWorking);
    git("checkout main", env.remoteWorking);

    const r2a = runCiSync(env);
    assertEqual(r2a.status, 0, "[warnings 2: stale] sync of feature branch should succeed");
    git("fetch origin", env.localRepo);
    assertEqual(
      git("branch -r", env.localRepo).includes(`origin/${env.branchPrefix}/${env.subdir}/feature/temp`),
      true, "[warnings 2] feature shadow created",
    );

    git("push origin --delete feature/temp", env.remoteWorking);
    git(`fetch ${env.remoteName} --prune`, env.localRepo);
    const r2b = runCiSync(env);
    assertEqual(r2b.status, 0, "[warnings 2] sync after branch deletion should succeed");
    assertIncludes(r2b.stdout, "Stale shadow branch", "[warnings 2] warns about stale branch");
    assertIncludes(r2b.stdout, "feature/temp", "[warnings 2] warning mentions deleted branch");
    assertIncludes(r2b.stdout, "--delete", "[warnings 2] suggests cleanup command");
  } finally {
    env.cleanup();
  }
}

// ── C. branches: feature, range, orphan, custom prefix ──────────────────────
// Default-prefix phases (env1) share the main env; custom-prefix gets its own.
function runBranchesDefault(env1: ReturnType<typeof createTestEnv>): void {
  {
    // phase 1: feature-branch
    git("checkout -b feature/cool-thing", env1.remoteWorking);
    fs.writeFileSync(path.join(env1.remoteWorking, "cool.ts"), "export const cool = true;\n");
    git("add cool.ts", env1.remoteWorking);
    git('commit -m "Add cool feature"', env1.remoteWorking);
    git("push origin feature/cool-thing", env1.remoteWorking);

    const r1 = runCiSync(env1);
    assertEqual(r1.status, 0, "[branches 1: feature] should succeed");
    git("fetch origin", env1.localRepo);
    assertEqual(
      git("branch -r", env1.localRepo).includes("origin/shadow/frontend/feature/cool-thing"),
      true, "[branches 1] feature shadow branch exists",
    );
    const cool = git("show \"origin/shadow/frontend/feature/cool-thing:frontend/cool.ts\"", env1.localRepo);
    assertEqual(cool, "export const cool = true;", "[branches 1] cool.ts on feature shadow");

    // phase 2: feature-range
    git("checkout main", env1.remoteWorking);
    commitOnRemote(env1, { "main1.ts": "main1\n" }, "Add main1");
    commitOnRemote(env1, { "main2.ts": "main2\n" }, "Add main2");

    git("checkout -b feature/range-test", env1.remoteWorking);
    fs.writeFileSync(path.join(env1.remoteWorking, "feat1.ts"), "feat1\n");
    git("add feat1.ts", env1.remoteWorking);
    git('commit -m "Add feat1 on branch"', env1.remoteWorking);
    fs.writeFileSync(path.join(env1.remoteWorking, "feat2.ts"), "feat2\n");
    git("add feat2.ts", env1.remoteWorking);
    git('commit -m "Add feat2 on branch"', env1.remoteWorking);
    git("push origin feature/range-test", env1.remoteWorking);

    const r2 = runCiSync(env1);
    assertEqual(r2.status, 0, "[branches 2: range] should succeed");
    assertIncludes(r2.stdout, "Replayed", "[branches 2] should replay");
    git("fetch origin", env1.localRepo);
    const f1 = git("show \"origin/shadow/frontend/feature/range-test:frontend/feat1.ts\"", env1.localRepo);
    const f2 = git("show \"origin/shadow/frontend/feature/range-test:frontend/feat2.ts\"", env1.localRepo);
    assertEqual(f1, "feat1", "[branches 2] feat1 on feature shadow");
    assertEqual(f2, "feat2", "[branches 2] feat2 on feature shadow");

    // phase 3: orphan-branch
    git("checkout main", env1.remoteWorking);
    git("checkout --orphan docs", env1.remoteWorking);
    git("rm -rf .", env1.remoteWorking);
    fs.writeFileSync(path.join(env1.remoteWorking, "doc.md"), "# docs\n");
    git("add doc.md", env1.remoteWorking);
    git('commit -m "Orphan docs root"', env1.remoteWorking);
    git("push origin docs", env1.remoteWorking);
    git("checkout main", env1.remoteWorking);

    const r3 = runCiSync(env1);
    assertEqual(r3.status, 0, "[branches 3: orphan] should not crash");
    git("fetch origin", env1.localRepo);
    assertEqual(
      git("branch -r", env1.localRepo).includes(`origin/shadow/${env1.subdir}/docs`),
      true, "[branches 3] orphan shadow branch exists",
    );
    const tip = git(`log -1 --format=%s origin/shadow/${env1.subdir}/docs`, env1.localRepo);
    if (!tip) throw new Error("[branches 3] orphan shadow branch should have a commit");
  }
}

// Custom-prefix branches test gets its own env (different prefix).
function runBranchesCustomPrefix(): void {
  const env2 = createTestEnv("pull-branches-custom", "frontend", "shd");
  try {
    commitOnRemote(env2, { "hello.txt": "from external\n" }, "Add hello");
    const r4 = runCiSync(env2);
    assertEqual(r4.status, 0, "[branches 4: custom-prefix pull] should succeed");
    assertIncludes(r4.stdout, "shd/frontend/main", "[branches 4] output references custom prefix");
    mergeShadow(env2);
    assertEqual(readShadowFile(env2, "hello.txt"), "from external\n", "[branches 4] file on custom-prefix shadow");

    commitOnLocal(env2, { "feature.ts": "export const x = 1;\n" }, "Add feature");
    const r5 = runPush(env2, "Push feature");
    assertEqual(r5.status, 0, "[branches 5: custom-prefix push] should succeed");
    assertIncludes(r5.stdout, "shd/frontend/main", "[branches 5] push references custom prefix");
    assertEqual(readExternalShadowFile(env2, "feature.ts"), "export const x = 1;\n", "[branches 5] file on external shadow");
    assertIncludes(getExternalShadowLogFull(env2), "Shadow-replayed-", "[branches 5] trailer present");
  } finally {
    env2.cleanup();
  }
}

// ── D. shadowignore: ignore patterns + history audit ────────────────────────
// Behavior phases share the main env; never-in-tree audit gets its own (needs
// clean history to walk).
function runShadowignoreBehavior(env1: ReturnType<typeof createTestEnv>): void {
  {
    commitOnRemote(env1, { "ignore-base.txt": "base\n" }, "shadowignore: add ignore-base");
    const b = runCiSync(env1);
    assertEqual(b.status, 0, "[shadowignore bootstrap] pull should succeed");
    mergeShadow(env1);

    // phase 1: basic ignore
    commitOnLocal(env1, {
      ".shadowignore": "*.local\nsecrets/\n",
      "app.ts": "export const app = true;\n",
      "config.local": "secret stuff\n",
    }, "Add app, config, and .shadowignore");
    const r1 = runPush(env1, "Push with shadowignore");
    assertEqual(r1.status, 0, "[shadowignore 1: basic] push should succeed");
    assertEqual(readExternalShadowFile(env1, "app.ts"), "export const app = true;\n", "[shadowignore 1] app.ts on shadow");
    assertEqual(readExternalShadowFile(env1, "config.local"), null, "[shadowignore 1] config.local NOT on shadow");

    // phase 2: deep-glob `**/CLAUDE.md`
    commitOnLocal(env1, {
      ".shadowignore": "**/CLAUDE.md\n",
      "deep-app.ts": "export const deepApp = true;\n",
      "CLAUDE.md": "# root claude\n",
      "src/CLAUDE.md": "# nested claude\n",
      "src/deep/CLAUDE.md": "# deeply nested claude\n",
      "src/deep/real.ts": "export const real = 1;\n",
    }, "Add files with CLAUDE.md at multiple depths");
    const r2 = runPush(env1, "Push with deep shadowignore");
    assertEqual(r2.status, 0, "[shadowignore 2: deep-glob] push should succeed");
    assertEqual(readExternalShadowFile(env1, "deep-app.ts"), "export const deepApp = true;\n", "[shadowignore 2] deep-app.ts on shadow");
    assertEqual(readExternalShadowFile(env1, "src/deep/real.ts"), "export const real = 1;\n", "[shadowignore 2] real.ts on shadow");
    assertEqual(readExternalShadowFile(env1, "CLAUDE.md"), null, "[shadowignore 2] root CLAUDE.md NOT on shadow");
    assertEqual(readExternalShadowFile(env1, "src/CLAUDE.md"), null, "[shadowignore 2] nested CLAUDE.md NOT on shadow");
    assertEqual(readExternalShadowFile(env1, "src/deep/CLAUDE.md"), null, "[shadowignore 2] deeply nested CLAUDE.md NOT on shadow");

    // phase 3: midhistory — pattern added partway through
    commitOnLocal(env1, {
      "visible.ts": "should sync\n",
      "secret.mid": "should not sync later\n",
    }, "Add visible.ts and secret.mid (pre-ignore)");
    const r3a = runPush(env1);
    assertEqual(r3a.status, 0, "[shadowignore 3: midhistory] first push should succeed");
    assertEqual(readExternalShadowFile(env1, "visible.ts"), "should sync\n", "[shadowignore 3] visible.ts on shadow");
    assertEqual(readExternalShadowFile(env1, "secret.mid"), "should not sync later\n", "[shadowignore 3] secret.mid initially on shadow");

    commitOnLocal(env1, {
      ".shadowignore": "**/*.mid\n**/CLAUDE.md\n",
      "secret.mid": "updated secret\n",
      "another.ts": "also visible\n",
    }, "Add .shadowignore pattern for *.mid + updates");
    const r3b = runPush(env1);
    assertEqual(r3b.status, 0, "[shadowignore 3] push after adding pattern should succeed");
    assertEqual(readExternalShadowFile(env1, "another.ts"), "also visible\n", "[shadowignore 3] another.ts on shadow");
    assertEqual(
      readExternalShadowFile(env1, "secret.mid"),
      "should not sync later\n",
      "[shadowignore 3] secret.mid update blocked by shadowignore",
    );

    // phase 4: rename INTO ignore — engine diffs without -M, so a rename is a
    // D+A pair: the delete replays (old path leaves the shadow), the add is
    // blocked (content must not escape under the ignored name).
    commitOnLocal(env1, { "renamed-into.ts": "rename me\n" }, "Add renamed-into.ts (pre-rename)");
    const r4a = runPush(env1);
    assertEqual(r4a.status, 0, "[shadowignore 4: rename-into] pre-rename push should succeed");
    assertEqual(readExternalShadowFile(env1, "renamed-into.ts"), "rename me\n", "[shadowignore 4] renamed-into.ts on shadow pre-rename");

    commitOnLocal(env1, {
      "renamed-into.ts": null,
      "renamed-into.mid": "rename me\n",
    }, "Rename renamed-into.ts -> renamed-into.mid (into ignore)");
    const r4b = runPush(env1);
    assertEqual(r4b.status, 0, "[shadowignore 4] rename push should succeed");
    assertEqual(readExternalShadowFile(env1, "renamed-into.ts"), null, "[shadowignore 4] old path deleted on shadow");
    assertEqual(readExternalShadowFile(env1, "renamed-into.mid"), null, "[shadowignore 4] content must NOT leak via the ignored new name");

    // phase 5: rename OUT of ignore — the add side lands outside the filter,
    // so the previously hidden content surfaces at the new name.
    commitOnLocal(env1, {
      "escape.mid": "hidden v1\n",
      "carrier.ts": "keeps the commit load-bearing\n",
    }, "Add escape.mid (ignored) + carrier.ts");
    const r5a = runPush(env1);
    assertEqual(r5a.status, 0, "[shadowignore 5: rename-out] setup push should succeed");
    assertEqual(readExternalShadowFile(env1, "escape.mid"), null, "[shadowignore 5] escape.mid blocked while ignored");
    assertEqual(readExternalShadowFile(env1, "carrier.ts"), "keeps the commit load-bearing\n", "[shadowignore 5] carrier.ts on shadow");

    commitOnLocal(env1, {
      "escape.mid": null,
      "escape.ts": "hidden v1\n",
    }, "Rename escape.mid -> escape.ts (out of ignore)");
    const r5b = runPush(env1);
    assertEqual(r5b.status, 0, "[shadowignore 5] rename push should succeed");
    assertEqual(readExternalShadowFile(env1, "escape.ts"), "hidden v1\n", "[shadowignore 5] content surfaces at the unignored name");
    assertEqual(readExternalShadowFile(env1, "escape.mid"), null, "[shadowignore 5] old ignored path still absent");

    // phase 6: unignore by pattern removal — block-not-purge: dropping the
    // pattern resurrects nothing by itself (the diff overlay only carries
    // changed paths); the file returns on its next edit.
    commitOnLocal(env1, { ".shadowignore": "**/CLAUDE.md\n" }, "Drop the *.mid ignore pattern");
    const r6a = runPush(env1);
    assertEqual(r6a.status, 0, "[shadowignore 6: unignore] pattern-removal push should succeed");
    assertEqual(
      readExternalShadowFile(env1, "secret.mid"),
      "should not sync later\n",
      "[shadowignore 6] pattern removal alone does NOT resurrect blocked content",
    );

    commitOnLocal(env1, { "secret.mid": "now public\n" }, "Update secret.mid post-unignore");
    const r6b = runPush(env1);
    assertEqual(r6b.status, 0, "[shadowignore 6] post-unignore push should succeed");
    assertEqual(readExternalShadowFile(env1, "secret.mid"), "now public\n", "[shadowignore 6] edit after pattern removal syncs");
  }
}

// Never-in-tree audit needs CLEAN history to walk.
function runShadowignoreNeverInTree(): void {
  const env2 = createTestEnv("push-ignore-never-in-tree");
  try {
    commitOnLocal(env2, {
      ".shadowignore": "secret.env\n",
      "app.ts": "export const app = true;\n",
      "secret.env": "API_KEY=supersecret\n",
    }, "Add app.ts, secret.env, and .shadowignore");
    const r4a = runPush(env2, "First export");
    assertEqual(r4a.status, 0, "[shadowignore 4: never-in-tree] first push should succeed");
    assertEqual(readExternalShadowFile(env2, "secret.env"), null, "[shadowignore 4] secret.env NOT on shadow (HEAD tree)");
    assertEqual(readExternalShadowFile(env2, "app.ts"), "export const app = true;\n", "[shadowignore 4] app.ts on shadow");

    commitOnLocal(env2, { "utils.ts": "export const util = true;\n" }, "Add utils.ts");
    const r4b = runPush(env2, "Second export");
    assertEqual(r4b.status, 0, "[shadowignore 4] second push should succeed");

    git(`fetch ${env2.remoteName} shadow/${env2.subdir}/main`, env2.localRepo);
    const commits = git(`log ${env2.remoteName}/shadow/${env2.subdir}/main --format=%H`, env2.localRepo)
      .split("\n").filter(Boolean);
    for (const hash of commits) {
      const tree = git(`ls-tree -r --name-only ${hash}`, env2.localRepo);
      const files = tree.split("\n").filter(Boolean);
      const hasSecret = files.some(f => f.endsWith("secret.env"));
      assertEqual(hasSecret, false, `[shadowignore 4] secret.env in tree of ${hash.slice(0, 8)}`);
    }
  } finally {
    env2.cleanup();
  }
}

// ── E. multi-level .shadowignore + implicit self-strip ─────────────────────
// .shadowignore at the source repo root cascades into the pair's sourceDir.
// .shadowignore files themselves are never replayed onto the target.
function runShadowignoreMultiLevel(): void {
  const env = createTestEnv("shadowignore-multilevel", "backend");
  try {
    // Mono root .shadowignore: basename-anywhere → strips *.tmp at any depth.
    // Pair-level .shadowignore (under "backend/"): "build/" → strips that dir.
    // app.ts, sub/keep.ts are kept; the .tmp + build/ files are dropped.
    const writeAt = (rel: string, content: string) => {
      const full = path.join(env.localRepo, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    };
    writeAt(".shadowignore",          "*.tmp\n");
    writeAt("backend/.shadowignore",  "build/\n");
    writeAt("backend/app.ts",         "app v1\n");
    writeAt("backend/temp.tmp",       "tmp at root\n");
    writeAt("backend/sub/inner.tmp",  "tmp deep\n");
    writeAt("backend/sub/keep.ts",    "kept\n");
    writeAt("backend/build/output.o", "binary\n");
    git("add -A", env.localRepo);
    git('commit -m "multi-level shadowignore setup"', env.localRepo);

    const r = runPush(env, "multi-level push");
    assertEqual(r.status, 0, "[shadowignore multi-level] push should succeed");

    assertEqual(readExternalShadowFile(env, "app.ts"),     "app v1\n", "[multi-level] app.ts kept");
    assertEqual(readExternalShadowFile(env, "sub/keep.ts"), "kept\n",  "[multi-level] sub/keep.ts kept");
    assertEqual(readExternalShadowFile(env, "temp.tmp"),       null, "[multi-level] *.tmp at root dropped via mono-root .shadowignore");
    assertEqual(readExternalShadowFile(env, "sub/inner.tmp"),  null, "[multi-level] *.tmp deep dropped (basename-anywhere)");
    assertEqual(readExternalShadowFile(env, "build/output.o"), null, "[multi-level] build/ dropped via pair-level .shadowignore");
    // Implicit self-strip: neither root nor pair-level .shadowignore reaches target.
    assertEqual(readExternalShadowFile(env, ".shadowignore"),  null, "[multi-level] .shadowignore file itself NOT replayed");
  } finally {
    env.cleanup();
  }
}

// ── F. multi-pair root .shadowignore — root cascades into every pair ────────
// One mono, two pairs on separate external remotes. The mono-root
// .shadowignore applies to both pairs' exports; a pair-level .shadowignore
// stays scoped to its own pair.
function runShadowignoreMultiPairRoot(): void {
  const env = createTestEnv("shadowignore-multipair", "frontend");
  try {
    const backend = addRemote(env, "backend-team", "backend");

    const writeAt = (rel: string, content: string) => {
      const full = path.join(env.localRepo, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    };
    writeAt(".shadowignore",          "*.tmp\n");
    writeAt("frontend/.shadowignore", "private/\n");
    writeAt("frontend/app.ts",        "fe app\n");
    writeAt("frontend/scratch.tmp",   "fe tmp\n");
    writeAt("frontend/private/x.ts",  "fe private\n");
    writeAt("backend/api.ts",         "be api\n");
    writeAt("backend/cache.tmp",      "be tmp\n");
    writeAt("backend/private/y.ts",   "be private\n");
    git("add -A", env.localRepo);
    git('commit -m "multi-pair shadowignore setup"', env.localRepo);

    const rf = runPush(env, "frontend pair push");
    assertEqual(rf.status, 0, "[multi-pair] frontend push should succeed");
    const rb = runPush(env, "backend pair push", [], backend);
    assertEqual(rb.status, 0, "[multi-pair] backend push should succeed");

    // Root *.tmp cascades into BOTH pairs.
    assertEqual(readExternalShadowFile(env, "app.ts"),             "fe app\n", "[multi-pair] frontend app.ts kept");
    assertEqual(readExternalShadowFile(env, "scratch.tmp"),        null,       "[multi-pair] frontend *.tmp dropped via root ignore");
    assertEqual(readExternalShadowFile(env, "api.ts", backend),    "be api\n", "[multi-pair] backend api.ts kept");
    assertEqual(readExternalShadowFile(env, "cache.tmp", backend), null,       "[multi-pair] backend *.tmp dropped via root ignore");
    // Pair-level ignore stays scoped: frontend/private/ blocked, backend's syncs.
    assertEqual(readExternalShadowFile(env, "private/x.ts"),          null,           "[multi-pair] frontend pair-level private/ dropped");
    assertEqual(readExternalShadowFile(env, "private/y.ts", backend), "be private\n", "[multi-pair] backend private/ unaffected by frontend's pair-level ignore");
    // Self-strip holds on both targets.
    assertEqual(readExternalShadowFile(env, ".shadowignore"),          null, "[multi-pair] .shadowignore not on frontend shadow");
    assertEqual(readExternalShadowFile(env, ".shadowignore", backend), null, "[multi-pair] .shadowignore not on backend shadow");
  } finally {
    env.cleanup();
  }
}

export default function run(): void {
  // Not a filter test — wildcard.
  setTestBranchAllowlist({ origin: ["**"], team: ["**"], "backend-team": ["**"] });
  try {

  // env1: shared across branches-default, shadowignore-behavior, and paths.
  // Order matters: paths runs last because phase 6 (case-conflict) is terminal —
  // it commits a poisonous tree that blocks any subsequent sync.
  const env1 = createTestEnv("paths-shared");
  try {
    runBranchesDefault(env1);
    runShadowignoreBehavior(env1);
    runPullPaths(env1);
  } finally {
    env1.cleanup();
  }

  // Separate envs for tests that genuinely need fresh state.
  runWarnings();
  runBranchesCustomPrefix();
  runShadowignoreNeverInTree();
  runShadowignoreMultiLevel();
  runShadowignoreMultiPairRoot();

  } finally {
    setTestBranchAllowlist();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-paths");
}
