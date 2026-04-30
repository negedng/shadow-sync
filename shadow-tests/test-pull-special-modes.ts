import { createTestEnv, runCiSync } from "./harness";
import { assertEqual } from "./assert";
import { execSync, spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/**
 * Round-trip the tree-entry kinds preflight intentionally doesn't gate:
 * submodule gitlinks (mode 160000), symlinks (mode 120000), and LFS pointer
 * files (regular blobs that look like pointers). The engine treats them as
 * opaque tree entries — replay should land them on the shadow branch with
 * the same mode and same blob/commit hash as the source.
 *
 * Phases:
 *   1. submodule — gitlink (160000) preserved at the prefixed path
 *   2. symlink — symlink blob (120000) preserved with target text intact
 *   3. lfs-pointer — pointer text round-trips byte-for-byte under .gitattributes
 */
export default function run() {
  const env = createTestEnv("pull-special-modes");
  const shadowRef = `${env.branchPrefix}/${env.subdir}/main`;

  function lsTree(targetPath: string): string {
    git(`fetch origin ${shadowRef}`, env.localRepo);
    return git(`ls-tree origin/${shadowRef} -- ${targetPath}`, env.localRepo);
  }
  function showOnShadow(targetPath: string): string {
    return git(`show origin/${shadowRef}:${targetPath}`, env.localRepo);
  }

  try {
    // ── phase 1: submodule (mode 160000) ───────────────────────────────
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
    assertEqual(r1.status, 0, "[phase 1: submodule] sync should succeed");

    const submoduleEntry = lsTree(`${env.subdir}/vendor/lib`);
    assertEqual(
      submoduleEntry.startsWith(`160000 commit ${fakeSubmoduleSha}`),
      true,
      `[phase 1] submodule gitlink preserved on shadow tree (got: ${submoduleEntry})`,
    );

    // ── phase 2: symlink (mode 120000) ─────────────────────────────────
    const linkTarget = "../config/settings.json";
    const blobResult = spawnSync("git", ["hash-object", "-w", "--stdin"], {
      input: linkTarget, cwd: env.remoteWorking, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    });
    const blobHash = blobResult.stdout.trim();
    git(`update-index --add --cacheinfo 120000,${blobHash},config-link`, env.remoteWorking);
    git('commit -m "Add symlink"', env.remoteWorking);
    git("push origin main", env.remoteWorking);

    const r2 = runCiSync(env);
    assertEqual(r2.status, 0, "[phase 2: symlink] sync should succeed");

    const symlinkEntry = lsTree(`${env.subdir}/config-link`);
    assertEqual(
      symlinkEntry.startsWith(`120000 blob ${blobHash}`),
      true,
      `[phase 2] symlink blob preserved on shadow tree (got: ${symlinkEntry})`,
    );
    assertEqual(
      showOnShadow(`${env.subdir}/config-link`).replace(/\r\n/g, "\n"),
      linkTarget,
      "[phase 2] symlink target text round-trips",
    );

    // ── phase 3: lfs pointer ───────────────────────────────────────────
    // If git-lfs is installed globally its pre-push hook fires here and
    // tries to upload the missing LFS object. We're verifying tree-entry
    // round-trip, not LFS transport — let pushes proceed without it.
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
    // --cacheinfo bypasses the LFS clean filter, so the literal pointer text
    // (not a re-cleaned version) is what lands in the tree.
    git(`update-index --add --cacheinfo 100644,${pointerBlob},data.bin`, env.remoteWorking);
    git('commit -m "Add LFS pointer"', env.remoteWorking);
    git("push origin main", env.remoteWorking);

    const r3 = runCiSync(env);
    assertEqual(r3.status, 0, "[phase 3: lfs] sync should succeed");

    const pointerOnShadow = showOnShadow(`${env.subdir}/data.bin`).replace(/\r\n/g, "\n");
    assertEqual(
      pointerOnShadow.trimEnd(),
      pointer.trimEnd(),
      "[phase 3] LFS pointer content round-trips byte-for-byte",
    );
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-pull-special-modes");
}
