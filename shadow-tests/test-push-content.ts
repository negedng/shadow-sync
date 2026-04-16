import { createTestEnv, commitOnRemote, commitOnLocal, runCiSync, mergeShadow, runPush, readExternalShadowFile, getExternalShadowLogFull, getExternalShadowDiffFiles } from "./harness";
import { assertEqual, assertIncludes } from "./assert";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/**
 * Consolidated push-content test. Uses two envs (second for dir-flag which
 * needs a different subdir at env setup time).
 *
 *   env1 (subdir "frontend"):
 *     1. basic — local commit → push → visible on external shadow
 *     2. crlf — local CRLF file pushes cleanly
 *     3. binary — PNG bytes preserved exactly
 *     4. diff-clean — each push shows only the file it touched
 *     5. literal-trailer — "Shadow-replayed-<remote>:" in subject is NOT
 *        treated as a real trailer and the commit reaches shadow
 *     6. deep-dirs — nested paths push cleanly
 *   env2 (subdir "custom-dir"): dir-flag — arbitrary subdir name works
 */
export default function run() {
  // ── env1: default subdir, six push-content phases ────────────────────
  const env1 = createTestEnv("push-content-default");
  try {
    // bootstrap with an initial pull so shadow/feature branch exists
    commitOnRemote(env1, { "base.txt": "base content\n" }, "Add base.txt");
    const bootstrap = runCiSync(env1);
    assertEqual(bootstrap.status, 0, "[bootstrap] initial pull should succeed");
    mergeShadow(env1);

    // phase 1: basic
    commitOnLocal(env1, { "new-feature.ts": "export function feat() {}\n" }, "Add new feature");
    const r1 = runPush(env1, "Add new feature from internal repo");
    assertEqual(r1.status, 0, "[phase 1: basic] push should succeed");
    assertIncludes(r1.stdout, "Done", "[phase 1] reports done");
    assertEqual(readExternalShadowFile(env1, "new-feature.ts"), "export function feat() {}\n", "[phase 1] new-feature.ts on shadow");
    assertIncludes(getExternalShadowLogFull(env1), "Add new feature", "[phase 1] commit message preserved");
    const diff1 = getExternalShadowDiffFiles(env1);
    assertEqual(diff1.length, 1, `[phase 1] diff-clean: 1 file, got ${diff1.join(",")}`);
    assertEqual(diff1[0], "new-feature.ts", "[phase 1] diff shows only new-feature.ts");

    // phase 2: crlf
    git("config core.autocrlf false", env1.localRepo);
    fs.writeFileSync(path.join(env1.localRepo, env1.subdir, "crlf-local.txt"), "line one\r\nline two\r\n");
    git(`add ${env1.subdir}/crlf-local.txt`, env1.localRepo);
    git('commit -m "Add CRLF file"', env1.localRepo);
    const r2 = runPush(env1, "Push CRLF file");
    assertEqual(r2.status, 0, `[phase 2: crlf] push should succeed: ${r2.stderr.slice(0, 200)}`);
    assertEqual(readExternalShadowFile(env1, "crlf-local.txt") !== null, true, "[phase 2] CRLF file on shadow");

    // phase 3: binary
    const pngBytes = Buffer.from([
      0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
      0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xDE,
    ]);
    fs.writeFileSync(path.join(env1.localRepo, env1.subdir, "image.png"), pngBytes);
    git(`add ${env1.subdir}/image.png`, env1.localRepo);
    git('commit -m "Add binary image"', env1.localRepo);
    const r3 = runPush(env1, "Push binary");
    assertEqual(r3.status, 0, "[phase 3: binary] push should succeed");
    git(`fetch ${env1.remoteName} shadow/${env1.subdir}/main`, env1.localRepo);
    const binOut = execSync(`git show ${env1.remoteName}/shadow/${env1.subdir}/main:image.png`, {
      cwd: env1.localRepo, stdio: ["pipe", "pipe", "pipe"],
    });
    assertEqual(binOut.length, pngBytes.length, "[phase 3] binary size matches");
    assertEqual(Buffer.compare(binOut, pngBytes) === 0, true, "[phase 3] binary content matches exactly");

    // phase 4: diff-clean on an UPDATE (vs. the add in phase 1)
    commitOnLocal(env1, { "base.txt": "updated base\n" }, "Update base.txt");
    const r4 = runPush(env1);
    assertEqual(r4.status, 0, "[phase 4: diff-clean update] push should succeed");
    const diff4 = getExternalShadowDiffFiles(env1);
    assertEqual(diff4.length, 1, `[phase 4] 1 file, got ${diff4.join(",")}`);
    assertEqual(diff4[0], "base.txt", "[phase 4] diff shows only updated file");

    // phase 5: literal-trailer in body
    commitOnLocal(
      env1,
      { "lit-trailer.ts": "export const lit = 1;\n" },
      `Refactor referencing Shadow-replayed-${env1.remoteName}: abc1234`,
    );
    const r5 = runPush(env1);
    assertEqual(r5.status, 0, "[phase 5: literal-trailer] push should succeed");
    assertEqual(
      readExternalShadowFile(env1, "lit-trailer.ts"), "export const lit = 1;\n",
      "[phase 5] file reaches shadow despite literal trailer text",
    );

    // phase 6: deep-dirs
    commitOnLocal(env1, {
      "src/components/Button.tsx": "export const Button = () => {};\n",
      "src/utils/helpers/format.ts": "export function format() {}\n",
    }, "Add nested files");
    const r6 = runPush(env1, "Push nested structure");
    assertEqual(r6.status, 0, "[phase 6: deep-dirs] push should succeed");
    assertEqual(readExternalShadowFile(env1, "src/components/Button.tsx"), "export const Button = () => {};\n", "[phase 6] nested tsx on shadow");
    assertEqual(readExternalShadowFile(env1, "src/utils/helpers/format.ts"), "export function format() {}\n", "[phase 6] triple-nested on shadow");
  } finally {
    env1.cleanup();
  }

  // ── env2: subdir "custom-dir" — dir-flag sanity check ───────────────
  const env2 = createTestEnv("push-content-dir-flag", "custom-dir");
  try {
    commitOnRemote(env2, { "base.txt": "base\n" }, "Add base");
    const r7a = runCiSync(env2);
    assertEqual(r7a.status, 0, "[phase 7a: dir-flag bootstrap] pull should succeed");
    mergeShadow(env2);

    const filePath = path.join(env2.localRepo, "custom-dir", "local-file.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "export const local = true;\n");
    git("add custom-dir/local-file.ts", env2.localRepo);
    git('commit -m "Add local file"', env2.localRepo);

    const r7 = runPush(env2, "Push with custom dir");
    assertEqual(r7.status, 0, "[phase 7: dir-flag] push should succeed");
    assertEqual(readExternalShadowFile(env2, "local-file.ts"), "export const local = true;\n", "[phase 7] file on shadow via custom subdir");
  } finally {
    env2.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-push-content");
}
