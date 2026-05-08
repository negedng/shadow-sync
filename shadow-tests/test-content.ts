/**
 * Consolidated content test. Four sub-tests:
 *
 *   A. pull-content — replay content roundtrip: basic, empty-patch, diff-clean,
 *      crlf, binary, large file, filemode, author preservation
 *      (formerly test-pull-content.ts)
 *   B. push-content — push-side content roundtrip: basic, crlf, binary,
 *      diff-clean, literal trailer, deep dirs, dir-flag
 *      (formerly test-push-content.ts)
 *   C. push-ops — file ops: rename, deletion, no-changes, uncommitted edits
 *      (formerly test-push-ops.ts)
 *   D. special-modes — submodule gitlinks, symlinks, LFS pointers round-trip
 *      (formerly test-pull-special-modes.ts)
 */
import * as fs from "fs";
import * as path from "path";
import { execSync, spawnSync } from "child_process";
import {
  createTestEnv, commitOnRemote, commitOnLocal,
  runCiSync, mergeShadow, runPush,
  readShadowFile, readExternalShadowFile,
  getShadowLogFull, getShadowDiffFiles, getShadowAuthors,
  getExternalShadowLogFull, getExternalShadowDiffFiles,
} from "./harness";
import { assertEqual, assertIncludes } from "./assert";

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
  0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xDE,
  0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41, 0x54,
  0x08, 0xD7, 0x63, 0xF8, 0xCF, 0xC0, 0x00, 0x00,
  0x00, 0x02, 0x00, 0x01, 0xE2, 0x21, 0xBC, 0x33,
  0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44,
  0xAE, 0x42, 0x60, 0x82,
]);

// ── A. pull-content: pull-side content roundtrip ────────────────────────────
function runPullContent(env: ReturnType<typeof createTestEnv>): void {
  {
    // phase 1: basic
    commitOnRemote(env, { "app.ts": "console.log('hello');\n" }, "Add app.ts");
    commitOnRemote(env, { "utils.ts": "export const x = 1;\n" }, "Add utils.ts");
    const r1 = runCiSync(env);
    assertEqual(r1.status, 0, "[pull-content 1: basic] ci-sync should succeed");
    assertIncludes(r1.stdout, "Replayed", "[pull-content 1] should replay commits");
    assertEqual(readShadowFile(env, "app.ts"), "console.log('hello');\n", "[pull-content 1] app.ts content");
    assertEqual(readShadowFile(env, "utils.ts"), "export const x = 1;\n", "[pull-content 1] utils.ts content");
    assertIncludes(getShadowLogFull(env), "Shadow-replayed-", "[pull-content 1] trailer present");

    const r1b = runCiSync(env);
    assertEqual(r1b.status, 0, "[pull-content 1] re-run should succeed");
    assertIncludes(r1b.stdout, "up to date", "[pull-content 1] re-run is no-op");

    // phase 2: empty-patch
    commitOnRemote(env, { "app.ts": "console.log('changed');\n" }, "Modify app.ts");
    commitOnRemote(env, { "app.ts": "console.log('hello');\n" }, "Revert app.ts");
    const r2 = runCiSync(env);
    assertEqual(r2.status, 0, "[pull-content 2: empty-patch] ci-sync should succeed");
    assertIncludes(getShadowLogFull(env), "Revert app.ts", "[pull-content 2] revert commit tracked");

    // phase 3: diff-clean
    commitOnRemote(env, { "feature.ts": "export const f = 1;\n" }, "Add feature.ts");
    const r3 = runCiSync(env);
    assertEqual(r3.status, 0, "[pull-content 3: diff-clean] ci-sync should succeed");
    const files = getShadowDiffFiles(env);
    assertEqual(files.length, 1, `[pull-content 3] expected 1 changed file, got: ${files.join(", ")}`);
    assertEqual(files[0], `${env.subdir}/feature.ts`, "[pull-content 3] diff shows only the added file");

    commitOnRemote(env, { "feature.ts": "export const f = 2;\n" }, "Update feature.ts");
    const r3b = runCiSync(env);
    assertEqual(r3b.status, 0, "[pull-content 3] update should succeed");
    const files2 = getShadowDiffFiles(env);
    assertEqual(files2.length, 1, `[pull-content 3] expected 1 changed file on update, got: ${files2.join(", ")}`);

    // phase 4: crlf
    git("config core.autocrlf false", env.remoteWorking);
    fs.writeFileSync(path.join(env.remoteWorking, "crlf.txt"), "line one\r\nline two\r\nline three\r\n");
    git("add crlf.txt", env.remoteWorking);
    git('commit -m "Add CRLF file"', env.remoteWorking);
    git("push origin main", env.remoteWorking);
    const r4 = runCiSync(env);
    assertEqual(r4.status, 0, `[pull-content 4: crlf] ci-sync should succeed: ${r4.stderr.slice(0, 200)}`);
    assertEqual(readShadowFile(env, "crlf.txt") !== null, true, "[pull-content 4] CRLF file exists");

    fs.writeFileSync(path.join(env.remoteWorking, "crlf.txt"), "line one\r\nline two modified\r\nline three\r\n");
    git("add crlf.txt", env.remoteWorking);
    git('commit -m "Modify CRLF file"', env.remoteWorking);
    git("push origin main", env.remoteWorking);
    const r4b = runCiSync(env);
    assertEqual(r4b.status, 0, `[pull-content 4] modified CRLF pull should succeed: ${r4b.stderr.slice(0, 200)}`);

    // phase 5: binary
    fs.writeFileSync(path.join(env.remoteWorking, "icon.png"), PNG_BYTES);
    git("add icon.png", env.remoteWorking);
    git('commit -m "Add binary PNG"', env.remoteWorking);
    git("push origin main", env.remoteWorking);
    const r5 = runCiSync(env);
    assertEqual(r5.status, 0, "[pull-content 5: binary] ci-sync should succeed");
    git(`fetch origin shadow/${env.subdir}/main`, env.localRepo);
    const binOut = execSync(`git show origin/shadow/${env.subdir}/main:${env.subdir}/icon.png`, {
      cwd: env.localRepo, stdio: ["pipe", "pipe", "pipe"],
    });
    assertEqual(binOut.length, PNG_BYTES.length, "[pull-content 5] binary file size matches");
    assertEqual(Buffer.compare(binOut, PNG_BYTES) === 0, true, "[pull-content 5] binary content matches exactly");

    // phase 6: large-file (>1MB)
    const lineCount = 30000;
    const lines: string[] = [];
    for (let i = 0; i < lineCount; i++) {
      lines.push(`line ${i}: ${"x".repeat(40)} padding to make this file large enough\n`);
    }
    const largeContent = lines.join("");
    fs.writeFileSync(path.join(env.remoteWorking, "large.txt"), largeContent);
    git("add large.txt", env.remoteWorking);
    git('commit -m "Add large file"', env.remoteWorking);
    git("push origin main", env.remoteWorking);
    const r6 = runCiSync(env);
    assertEqual(r6.status, 0, `[pull-content 6: large-file] ci-sync should succeed: ${r6.stderr.slice(0, 200)}`);
    const large = readShadowFile(env, "large.txt");
    assertEqual(large !== null, true, "[pull-content 6] large file exists");
    assertEqual(large!.length, largeContent.length, `[pull-content 6] size match (got ${large!.length})`);
    assertEqual(large!.startsWith("line 0:"), true, "[pull-content 6] first line intact");
    assertEqual(large!.includes(`line ${lineCount - 1}:`), true, "[pull-content 6] last line intact");

    // phase 7: filemode (chmod +x)
    git("config core.filemode true", env.remoteWorking);
    fs.writeFileSync(path.join(env.remoteWorking, "script.sh"), "#!/bin/bash\necho hello\n");
    git("add script.sh", env.remoteWorking);
    git('commit -m "Add script.sh"', env.remoteWorking);
    git("push origin main", env.remoteWorking);
    const r7 = runCiSync(env);
    assertEqual(r7.status, 0, "[pull-content 7: filemode] initial pull should succeed");

    git("update-index --chmod=+x script.sh", env.remoteWorking);
    git('commit -m "chmod +x script.sh"', env.remoteWorking);
    git("push origin main", env.remoteWorking);
    const r7b = runCiSync(env);
    assertEqual(r7b.status, 0, `[pull-content 7] chmod sync should succeed: ${r7b.stderr.slice(0, 200)}`);
    assertEqual(readShadowFile(env, "script.sh"), "#!/bin/bash\necho hello\n", "[pull-content 7] content unchanged");

    fs.writeFileSync(path.join(env.remoteWorking, "script.sh"), "#!/bin/bash\necho hello world\n");
    git("add script.sh", env.remoteWorking);
    git('commit -m "Update script content"', env.remoteWorking);
    git("push origin main", env.remoteWorking);
    const r7c = runCiSync(env);
    assertEqual(r7c.status, 0, `[pull-content 7] content+mode sync should succeed: ${r7c.stderr.slice(0, 200)}`);
    assertEqual(readShadowFile(env, "script.sh"), "#!/bin/bash\necho hello world\n", "[pull-content 7] updated content");

    // phase 8: author preservation
    fs.writeFileSync(path.join(env.remoteWorking, "alice.ts"), "// Alice's file\n");
    git("add alice.ts", env.remoteWorking);
    execSync('git commit --author="Alice External <alice@external.com>" -m "Alice commit"', {
      cwd: env.remoteWorking, stdio: "pipe",
    });
    fs.writeFileSync(path.join(env.remoteWorking, "bob.ts"), "// Bob's file\n");
    git("add bob.ts", env.remoteWorking);
    execSync('git commit --author="Bob Contributor <bob@contributor.org>" -m "Bob commit"', {
      cwd: env.remoteWorking, stdio: "pipe",
    });
    git("push origin main", env.remoteWorking);
    const r8 = runCiSync(env);
    assertEqual(r8.status, 0, "[pull-content 8: author] ci-sync should succeed");
    const authors = getShadowAuthors(env);
    assertIncludes(authors, "Alice External <alice@external.com>", "[pull-content 8] Alice preserved");
    assertIncludes(authors, "Bob Contributor <bob@contributor.org>", "[pull-content 8] Bob preserved");
  }
}

// ── B. push-content: push-side content roundtrip ────────────────────────────
function runPushContent(env1: ReturnType<typeof createTestEnv>): void {
  {
    commitOnRemote(env1, { "base.txt": "base content\n" }, "Add base.txt");
    const bootstrap = runCiSync(env1);
    assertEqual(bootstrap.status, 0, "[push-content bootstrap] initial pull should succeed");
    mergeShadow(env1);

    // phase 1: basic
    commitOnLocal(env1, { "new-feature.ts": "export function feat() {}\n" }, "Add new feature");
    const r1 = runPush(env1, "Add new feature from internal repo");
    assertEqual(r1.status, 0, "[push-content 1: basic] push should succeed");
    assertIncludes(r1.stdout, "Done", "[push-content 1] reports done");
    assertEqual(readExternalShadowFile(env1, "new-feature.ts"), "export function feat() {}\n", "[push-content 1] new-feature.ts on shadow");
    assertIncludes(getExternalShadowLogFull(env1), "Add new feature", "[push-content 1] commit message preserved");
    const diff1 = getExternalShadowDiffFiles(env1);
    assertEqual(diff1.length, 1, `[push-content 1] diff-clean: 1 file, got ${diff1.join(",")}`);
    assertEqual(diff1[0], "new-feature.ts", "[push-content 1] diff shows only new-feature.ts");

    // phase 2: crlf
    git("config core.autocrlf false", env1.localRepo);
    fs.writeFileSync(path.join(env1.localRepo, env1.subdir, "crlf-local.txt"), "line one\r\nline two\r\n");
    git(`add ${env1.subdir}/crlf-local.txt`, env1.localRepo);
    git('commit -m "Add CRLF file"', env1.localRepo);
    const r2 = runPush(env1, "Push CRLF file");
    assertEqual(r2.status, 0, `[push-content 2: crlf] push should succeed: ${r2.stderr.slice(0, 200)}`);
    assertEqual(readExternalShadowFile(env1, "crlf-local.txt") !== null, true, "[push-content 2] CRLF file on shadow");

    // phase 3: binary
    fs.writeFileSync(path.join(env1.localRepo, env1.subdir, "image.png"), PNG_BYTES.slice(0, 32));
    git(`add ${env1.subdir}/image.png`, env1.localRepo);
    git('commit -m "Add binary image"', env1.localRepo);
    const r3 = runPush(env1, "Push binary");
    assertEqual(r3.status, 0, "[push-content 3: binary] push should succeed");
    git(`fetch ${env1.remoteName} shadow/${env1.subdir}/main`, env1.localRepo);
    const binOut = execSync(`git show ${env1.remoteName}/shadow/${env1.subdir}/main:image.png`, {
      cwd: env1.localRepo, stdio: ["pipe", "pipe", "pipe"],
    });
    assertEqual(binOut.length, 32, "[push-content 3] binary size matches");
    assertEqual(Buffer.compare(binOut, PNG_BYTES.slice(0, 32)) === 0, true, "[push-content 3] binary content matches");

    // phase 4: diff-clean on UPDATE
    commitOnLocal(env1, { "base.txt": "updated base\n" }, "Update base.txt");
    const r4 = runPush(env1);
    assertEqual(r4.status, 0, "[push-content 4: diff-clean update] push should succeed");
    const diff4 = getExternalShadowDiffFiles(env1);
    assertEqual(diff4.length, 1, `[push-content 4] 1 file, got ${diff4.join(",")}`);
    assertEqual(diff4[0], "base.txt", "[push-content 4] diff shows only updated file");

    // phase 5: literal-trailer in body
    commitOnLocal(
      env1,
      { "lit-trailer.ts": "export const lit = 1;\n" },
      `Refactor referencing Shadow-replayed-${env1.remoteName}: abc1234`,
    );
    const r5 = runPush(env1);
    assertEqual(r5.status, 0, "[push-content 5: literal-trailer] push should succeed");
    assertEqual(
      readExternalShadowFile(env1, "lit-trailer.ts"), "export const lit = 1;\n",
      "[push-content 5] file reaches shadow despite literal trailer text",
    );

    // phase 6: deep-dirs
    commitOnLocal(env1, {
      "src/components/Button.tsx": "export const Button = () => {};\n",
      "src/utils/helpers/format.ts": "export function format() {}\n",
    }, "Add nested files");
    const r6 = runPush(env1, "Push nested structure");
    assertEqual(r6.status, 0, "[push-content 6: deep-dirs] push should succeed");
    assertEqual(readExternalShadowFile(env1, "src/components/Button.tsx"), "export const Button = () => {};\n", "[push-content 6] nested tsx on shadow");
    assertEqual(readExternalShadowFile(env1, "src/utils/helpers/format.ts"), "export function format() {}\n", "[push-content 6] triple-nested on shadow");
  }
}

// ── B2. push-content custom-dir: dir-flag sanity check (separate env) ──────
function runPushContentCustomDir(): void {
  const env2 = createTestEnv("push-content-dir-flag", "custom-dir");
  try {
    commitOnRemote(env2, { "base.txt": "base\n" }, "Add base");
    const r7a = runCiSync(env2);
    assertEqual(r7a.status, 0, "[push-content 7a: dir-flag bootstrap] pull should succeed");
    mergeShadow(env2);

    const filePath = path.join(env2.localRepo, "custom-dir", "local-file.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "export const local = true;\n");
    git("add custom-dir/local-file.ts", env2.localRepo);
    git('commit -m "Add local file"', env2.localRepo);

    const r7 = runPush(env2, "Push with custom dir");
    assertEqual(r7.status, 0, "[push-content 7: dir-flag] push should succeed");
    assertEqual(readExternalShadowFile(env2, "local-file.ts"), "export const local = true;\n", "[push-content 7] file on shadow via custom subdir");
  } finally {
    env2.cleanup();
  }
}

// ── C. push-ops: file ops (rename, delete, no-changes, uncommitted) ────────
// Files are name-spaced ("ops-*") so this can run on an env already populated
// by other sub-tests without collisions.
function runPushOps(env: ReturnType<typeof createTestEnv>): void {
  {
    // Bootstrap: add ops-* files via remote+pull (so they exist locally for the rename/delete).
    commitOnRemote(env, {
      "ops-base.txt": "base content\n",
      "ops-old-name.ts": "content to rename\n",
      "ops-to-remove.txt": "remove me\n",
    }, "push-ops: bootstrap files");
    const b = runCiSync(env);
    assertEqual(b.status, 0, "[push-ops bootstrap] pull should succeed");
    mergeShadow(env);

    // phase 1: basic add
    commitOnLocal(env, { "ops-feature.ts": "export const x = 1;\n" }, "push-ops: add feature");
    const r1 = runPush(env, "Add feature");
    assertEqual(r1.status, 0, "[push-ops 1: basic add] push should succeed");
    assertEqual(readExternalShadowFile(env, "ops-feature.ts"), "export const x = 1;\n", "[push-ops 1] feature on shadow");

    // phase 2: rename
    git(`mv ${env.subdir}/ops-old-name.ts ${env.subdir}/ops-new-name.ts`, env.localRepo);
    git('commit -m "push-ops: rename ops-old-name.ts to ops-new-name.ts"', env.localRepo);
    const r2 = runPush(env);
    assertEqual(r2.status, 0, "[push-ops 2: rename] push should succeed");
    assertEqual(readExternalShadowFile(env, "ops-new-name.ts"), "content to rename\n", "[push-ops 2] new name on shadow");
    assertEqual(readExternalShadowFile(env, "ops-old-name.ts"), null, "[push-ops 2] old name gone on shadow");

    // phase 3: deletion
    commitOnLocal(env, { "ops-to-remove.txt": null }, "push-ops: delete ops-to-remove.txt");
    const r3 = runPush(env, "Remove ops-to-remove.txt");
    assertEqual(r3.status, 0, "[push-ops 3: deletion] push should succeed");
    assertEqual(readExternalShadowFile(env, "ops-to-remove.txt"), null, "[push-ops 3] file gone on shadow");
    assertEqual(readExternalShadowFile(env, "ops-base.txt"), "base content\n", "[push-ops 3] other files still present");

    // phase 4: no-changes
    const r4 = runPush(env, "Nothing changed");
    assertEqual(r4.status, 0, "[push-ops 4: no-changes] push should exit cleanly");
    assertIncludes(r4.stdout, "up to date", "[push-ops 4] stdout reports up-to-date");

    // phase 5: uncommitted edits invisible to orchestrator
    const untrackedPath = path.join(env.localRepo, env.subdir, "ops-local-notes.txt");
    fs.writeFileSync(untrackedPath, "my personal notes\n");
    commitOnLocal(env, { "ops-feature2.ts": "export const y = 2;\n" }, "push-ops: add feature2");
    const r5a = runPush(env, "Push with untracked file present");
    assertEqual(r5a.status, 0, "[push-ops 5a] push succeeds even with untracked file");
    assertEqual(readExternalShadowFile(env, "ops-feature2.ts"), "export const y = 2;\n", "[push-ops 5a] tracked file on shadow");
    assertEqual(readExternalShadowFile(env, "ops-local-notes.txt"), null, "[push-ops 5a] untracked file NOT on shadow");

    const basePath = path.join(env.localRepo, env.subdir, "ops-base.txt");
    fs.writeFileSync(basePath, "base content\nlocal WIP modification\n");
    const r5b = runPush(env, "Push with dirty working tree");
    assertEqual(r5b.status, 0, "[push-ops 5b] push succeeds; uncommitted edits are invisible");
    assertEqual(readExternalShadowFile(env, "ops-base.txt"), "base content\n", "[push-ops 5b] shadow unchanged by uncommitted edit");

    git(`add ${env.subdir}/ops-base.txt`, env.localRepo);
    const r5c = runPush(env, "Push with staged but uncommitted");
    assertEqual(r5c.status, 0, "[push-ops 5c] push succeeds; staged-uncommitted edits are invisible");
    assertEqual(readExternalShadowFile(env, "ops-base.txt"), "base content\n", "[push-ops 5c] shadow still unchanged");

    git('commit -m "push-ops: commit the WIP edit"', env.localRepo);
    fs.unlinkSync(untrackedPath);
    const r5d = runPush(env, "Push after committing");
    assertEqual(r5d.status, 0, "[push-ops 5d] push should succeed after committing");
    assertEqual(
      readExternalShadowFile(env, "ops-base.txt"),
      "base content\nlocal WIP modification\n",
      "[push-ops 5d] WIP edit propagated to shadow",
    );
  }
}

// ── D. special-modes: gitlinks, symlinks, LFS pointers ─────────────────────
// Special tree-entry kinds. Runs on the shared env after the other sub-tests;
// uses cacheinfo paths that don't collide with prior content.
function runSpecialModes(env: ReturnType<typeof createTestEnv>): void {
  const shadowRef = `${env.branchPrefix}/${env.subdir}/main`;

  function lsTree(targetPath: string): string {
    git(`fetch origin ${shadowRef}`, env.localRepo);
    return git(`ls-tree origin/${shadowRef} -- ${targetPath}`, env.localRepo);
  }
  function showOnShadow(targetPath: string): string {
    return git(`show origin/${shadowRef}:${targetPath}`, env.localRepo);
  }

  {
    // phase 1: submodule
    const fakeSubmoduleSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    git(`update-index --add --cacheinfo 160000,${fakeSubmoduleSha},vendor/lib`, env.remoteWorking);
    fs.writeFileSync(
      path.join(env.remoteWorking, ".gitmodules"),
      '[submodule "vendor/lib"]\n\tpath = vendor/lib\n\turl = https://example.com/lib.git\n',
    );
    git("add .gitmodules", env.remoteWorking);
    git('commit -m "Add submodule"', env.remoteWorking);
    git("push origin main", env.remoteWorking);

    const r1 = runCiSync(env);
    assertEqual(r1.status, 0, "[special-modes 1: submodule] sync should succeed");

    const submoduleEntry = lsTree(`${env.subdir}/vendor/lib`);
    assertEqual(
      submoduleEntry.startsWith(`160000 commit ${fakeSubmoduleSha}`),
      true,
      `[special-modes 1] submodule gitlink preserved (got: ${submoduleEntry})`,
    );

    // phase 2: symlink
    const linkTarget = "../config/settings.json";
    const blobResult = spawnSync("git", ["hash-object", "-w", "--stdin"], {
      input: linkTarget, cwd: env.remoteWorking, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    });
    const blobHash = blobResult.stdout.trim();
    git(`update-index --add --cacheinfo 120000,${blobHash},config-link`, env.remoteWorking);
    git('commit -m "Add symlink"', env.remoteWorking);
    git("push origin main", env.remoteWorking);

    const r2 = runCiSync(env);
    assertEqual(r2.status, 0, "[special-modes 2: symlink] sync should succeed");

    const symlinkEntry = lsTree(`${env.subdir}/config-link`);
    assertEqual(
      symlinkEntry.startsWith(`120000 blob ${blobHash}`),
      true,
      `[special-modes 2] symlink blob preserved (got: ${symlinkEntry})`,
    );
    assertEqual(
      showOnShadow(`${env.subdir}/config-link`).replace(/\r\n/g, "\n"),
      linkTarget,
      "[special-modes 2] symlink target text round-trips",
    );

    // phase 3: lfs pointer
    fs.appendFileSync(path.join(env.remoteWorking, ".git", "config"), "[lfs]\n\tallowincompletepush = true\n");
    fs.appendFileSync(path.join(env.localRepo,    ".git", "config"), "[lfs]\n\tallowincompletepush = true\n");

    const pointer =
      "version https://git-lfs.github.com/spec/v1\n" +
      "oid sha256:abc123def456abc123def456abc123def456abc123def456abc123def456abcd\n" +
      "size 12345\n";
    const pointerBlob = spawnSync("git", ["hash-object", "-w", "--stdin"], {
      input: pointer, cwd: env.remoteWorking, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    }).stdout.trim();
    fs.writeFileSync(path.join(env.remoteWorking, ".gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs -text\n");
    git("add .gitattributes", env.remoteWorking);
    git(`update-index --add --cacheinfo 100644,${pointerBlob},data.bin`, env.remoteWorking);
    git('commit -m "Add LFS pointer"', env.remoteWorking);
    git("push origin main", env.remoteWorking);

    const r3 = runCiSync(env);
    assertEqual(r3.status, 0, "[special-modes 3: lfs] sync should succeed");

    const pointerOnShadow = showOnShadow(`${env.subdir}/data.bin`).replace(/\r\n/g, "\n");
    assertEqual(
      pointerOnShadow.trimEnd(),
      pointer.trimEnd(),
      "[special-modes 3] LFS pointer content round-trips byte-for-byte",
    );
  }
}

export default function run(): void {
  // env1: shared across pull-content, push-content (default subdir), push-ops, special-modes.
  // All four use frontend subdir + shadow prefix. Sub-tests use disjoint file paths so
  // they don't collide. Order matters: pull-content seeds shadow refs, then push-content
  // pushes more, push-ops uses ops-* paths, special-modes adds gitlink/symlink/LFS entries last.
  const env1 = createTestEnv("content-shared");
  try {
    runPullContent(env1);
    runPushContent(env1);
    runPushOps(env1);
    runSpecialModes(env1);
  } finally {
    env1.cleanup();
  }

  // env2: separate env for the dir-flag custom-dir test (different subdir).
  runPushContentCustomDir();
}

if (require.main === module) {
  run();
  console.log("PASS  test-content");
}
