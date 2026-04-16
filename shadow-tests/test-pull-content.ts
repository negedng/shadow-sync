import { createTestEnv, commitOnRemote, runCiSync, readShadowFile, getShadowLogFull, getShadowDiffFiles, getShadowAuthors } from "./harness";
import { assertEqual, assertIncludes } from "./assert";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/**
 * Consolidated pull-content test. Covers, in phases on a single env:
 *   1. basic — replay content, trailer, no-op re-run
 *   2. empty-patch — commit that ends up at same state as previous
 *   3. diff-clean — each replayed commit touches only the files it changed
 *   4. crlf — remote commits with CRLF line endings
 *   5. binary-file — PNG bytes preserved exactly
 *   6. large-file — >1MB file (exercises maxBuffer)
 *   7. filemode — chmod +x and content+mode change
 *   8. author — Alice/Bob authorship preserved across replay
 */
export default function run() {
  const env = createTestEnv("pull-content");
  try {
    // ── phase 1: basic ─────────────────────────────────────────────────
    commitOnRemote(env, { "app.ts": "console.log('hello');\n" }, "Add app.ts");
    commitOnRemote(env, { "utils.ts": "export const x = 1;\n" }, "Add utils.ts");
    const r1 = runCiSync(env);
    assertEqual(r1.status, 0, "[phase 1: basic] ci-sync should succeed");
    assertIncludes(r1.stdout, "Replayed", "[phase 1] should replay commits");
    assertEqual(readShadowFile(env, "app.ts"), "console.log('hello');\n", "[phase 1] app.ts content");
    assertEqual(readShadowFile(env, "utils.ts"), "export const x = 1;\n", "[phase 1] utils.ts content");
    assertIncludes(getShadowLogFull(env), "Shadow-replayed-", "[phase 1] trailer present");

    const r1b = runCiSync(env);
    assertEqual(r1b.status, 0, "[phase 1] re-run should succeed");
    assertIncludes(r1b.stdout, "up to date", "[phase 1] re-run is no-op");

    // ── phase 2: empty-patch (commit with no net change) ───────────────
    commitOnRemote(env, { "app.ts": "console.log('changed');\n" }, "Modify app.ts");
    commitOnRemote(env, { "app.ts": "console.log('hello');\n" }, "Revert app.ts");
    const r2 = runCiSync(env);
    assertEqual(r2.status, 0, "[phase 2: empty-patch] ci-sync should succeed");
    assertIncludes(getShadowLogFull(env), "Revert app.ts", "[phase 2] revert commit tracked");

    // ── phase 3: diff-clean ────────────────────────────────────────────
    commitOnRemote(env, { "feature.ts": "export const f = 1;\n" }, "Add feature.ts");
    const r3 = runCiSync(env);
    assertEqual(r3.status, 0, "[phase 3: diff-clean] ci-sync should succeed");
    const files = getShadowDiffFiles(env);
    assertEqual(files.length, 1, `[phase 3] expected 1 changed file, got: ${files.join(", ")}`);
    assertEqual(files[0], `${env.subdir}/feature.ts`, "[phase 3] diff shows only the added file");

    commitOnRemote(env, { "feature.ts": "export const f = 2;\n" }, "Update feature.ts");
    const r3b = runCiSync(env);
    assertEqual(r3b.status, 0, "[phase 3] update should succeed");
    const files2 = getShadowDiffFiles(env);
    assertEqual(files2.length, 1, `[phase 3] expected 1 changed file on update, got: ${files2.join(", ")}`);

    // ── phase 4: crlf ──────────────────────────────────────────────────
    git("config core.autocrlf false", env.remoteWorking);
    const crlf = "line one\r\nline two\r\nline three\r\n";
    fs.writeFileSync(path.join(env.remoteWorking, "crlf.txt"), crlf);
    git("add crlf.txt", env.remoteWorking);
    git('commit -m "Add CRLF file"', env.remoteWorking);
    git("push origin main", env.remoteWorking);
    const r4 = runCiSync(env);
    assertEqual(r4.status, 0, `[phase 4: crlf] ci-sync should succeed: ${r4.stderr.slice(0, 200)}`);
    assertEqual(readShadowFile(env, "crlf.txt") !== null, true, "[phase 4] CRLF file exists");

    fs.writeFileSync(path.join(env.remoteWorking, "crlf.txt"), "line one\r\nline two modified\r\nline three\r\n");
    git("add crlf.txt", env.remoteWorking);
    git('commit -m "Modify CRLF file"', env.remoteWorking);
    git("push origin main", env.remoteWorking);
    const r4b = runCiSync(env);
    assertEqual(r4b.status, 0, `[phase 4] modified CRLF pull should succeed: ${r4b.stderr.slice(0, 200)}`);

    // ── phase 5: binary-file ───────────────────────────────────────────
    const pngBytes = Buffer.from([
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
    fs.writeFileSync(path.join(env.remoteWorking, "icon.png"), pngBytes);
    git("add icon.png", env.remoteWorking);
    git('commit -m "Add binary PNG"', env.remoteWorking);
    git("push origin main", env.remoteWorking);
    const r5 = runCiSync(env);
    assertEqual(r5.status, 0, "[phase 5: binary] ci-sync should succeed");
    git(`fetch origin shadow/${env.subdir}/main`, env.localRepo);
    const binOut = execSync(`git show origin/shadow/${env.subdir}/main:${env.subdir}/icon.png`, {
      cwd: env.localRepo, stdio: ["pipe", "pipe", "pipe"],
    });
    assertEqual(binOut.length, pngBytes.length, "[phase 5] binary file size matches");
    assertEqual(Buffer.compare(binOut, pngBytes) === 0, true, "[phase 5] binary content matches exactly");

    // ── phase 6: large-file (>1MB) ─────────────────────────────────────
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
    assertEqual(r6.status, 0, `[phase 6: large-file] ci-sync should succeed: ${r6.stderr.slice(0, 200)}`);
    const large = readShadowFile(env, "large.txt");
    assertEqual(large !== null, true, "[phase 6] large file exists");
    assertEqual(large!.length, largeContent.length, `[phase 6] size match (got ${large!.length})`);
    assertEqual(large!.startsWith("line 0:"), true, "[phase 6] first line intact");
    assertEqual(large!.includes(`line ${lineCount - 1}:`), true, "[phase 6] last line intact");

    // ── phase 7: filemode (chmod +x then content+mode) ─────────────────
    git("config core.filemode true", env.remoteWorking);
    fs.writeFileSync(path.join(env.remoteWorking, "script.sh"), "#!/bin/bash\necho hello\n");
    git("add script.sh", env.remoteWorking);
    git('commit -m "Add script.sh"', env.remoteWorking);
    git("push origin main", env.remoteWorking);
    const r7 = runCiSync(env);
    assertEqual(r7.status, 0, "[phase 7: filemode] initial pull should succeed");

    git("update-index --chmod=+x script.sh", env.remoteWorking);
    git('commit -m "chmod +x script.sh"', env.remoteWorking);
    git("push origin main", env.remoteWorking);
    const r7b = runCiSync(env);
    assertEqual(r7b.status, 0, `[phase 7] chmod sync should succeed: ${r7b.stderr.slice(0, 200)}`);
    assertEqual(readShadowFile(env, "script.sh"), "#!/bin/bash\necho hello\n", "[phase 7] content unchanged");

    fs.writeFileSync(path.join(env.remoteWorking, "script.sh"), "#!/bin/bash\necho hello world\n");
    git("add script.sh", env.remoteWorking);
    git('commit -m "Update script content"', env.remoteWorking);
    git("push origin main", env.remoteWorking);
    const r7c = runCiSync(env);
    assertEqual(r7c.status, 0, `[phase 7] content+mode sync should succeed: ${r7c.stderr.slice(0, 200)}`);
    assertEqual(readShadowFile(env, "script.sh"), "#!/bin/bash\necho hello world\n", "[phase 7] updated content");

    // ── phase 8: author preservation ───────────────────────────────────
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
    assertEqual(r8.status, 0, "[phase 8: author] ci-sync should succeed");
    const authors = getShadowAuthors(env);
    assertIncludes(authors, "Alice External <alice@external.com>", "[phase 8] Alice preserved");
    assertIncludes(authors, "Bob Contributor <bob@contributor.org>", "[phase 8] Bob preserved");
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-pull-content");
}
