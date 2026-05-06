import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execSync, spawnSync } from "child_process";
import { assertEqual, assertIncludes, assertNotIncludes } from "./assert";

const SCRIPT = path.resolve(__dirname, "..", "copy-paths.ts");

interface CopyGroup { paths: string[]; }

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function makeRepo(name: string, copyPaths: CopyGroup[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `copy-paths-${name}-`));
  git("init", dir);
  fs.appendFileSync(
    path.join(dir, ".git", "config"),
    `[user]\n\temail = probe@test.com\n\tname = Probe\n[core]\n\tautocrlf = false\n`,
  );
  fs.writeFileSync(
    path.join(dir, "shadow-config.json"),
    JSON.stringify({ copyPaths }, null, 2),
  );
  return dir;
}

function writeFile(dir: string, rel: string, content: string | Buffer): void {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function readFile(dir: string, rel: string): string | null {
  const full = path.join(dir, rel);
  if (!fs.existsSync(full)) return null;
  return fs.readFileSync(full, "utf8").replace(/\r\n/g, "\n");
}

function exists(dir: string, rel: string): boolean {
  return fs.existsSync(path.join(dir, rel));
}

interface RunResult { status: number; stdout: string; stderr: string; }

function runScript(dir: string, mode: "check" | "rebuild" | string): RunResult {
  const r = spawnSync("npx", ["tsx", SCRIPT, mode], {
    cwd: dir, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function commitInitial(dir: string, files: Record<string, string>, msg = "init"): void {
  for (const [rel, content] of Object.entries(files)) writeFile(dir, rel, content);
  git("add -A", dir);
  git(`commit -m "${msg}"`, dir);
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function diffNamesFromIndex(dir: string): string[] {
  // Files with staged changes vs HEAD (or all staged if no HEAD).
  const r = spawnSync("git", ["diff", "--cached", "--name-only"], {
    cwd: dir, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
  });
  return (r.stdout ?? "").trim().split("\n").filter(Boolean).map(s => s.replace(/\\/g, "/"));
}

// ── Phases ───────────────────────────────────────────────────────────────────

function phaseA_editOnePropagatesToOther(): void {
  const groups = [{ paths: ["frontend/common", "backend/common"] }];
  const dir = makeRepo("A-edit-one", groups);
  try {
    commitInitial(dir, {
      "frontend/common/foo.ts": "v1\n",
      "backend/common/foo.ts": "v1\n",
    });

    writeFile(dir, "backend/common/foo.ts", "v2 from backend\n");

    const c = runScript(dir, "check");
    assertEqual(c.status, 1, "[A] check should fail when paths diverge");
    assertIncludes(c.stderr, "divergence detected", "[A] check explains divergence");

    const r = runScript(dir, "rebuild");
    assertEqual(r.status, 0, "[A] rebuild should succeed");
    assertEqual(readFile(dir, "frontend/common/foo.ts"), "v2 from backend\n", "[A] frontend got new content");
    assertEqual(readFile(dir, "backend/common/foo.ts"), "v2 from backend\n", "[A] backend unchanged");

    const staged = diffNamesFromIndex(dir);
    assertEqual(
      staged.includes("frontend/common/foo.ts"), true,
      "[A] propagated frontend/common/foo.ts is staged",
    );

    const c2 = runScript(dir, "check");
    assertEqual(c2.status, 0, "[A] check passes after rebuild");
  } finally { cleanup(dir); }
}

function phaseB_editBothIdenticallyIsNoOp(): void {
  const groups = [{ paths: ["frontend/common", "backend/common"] }];
  const dir = makeRepo("B-edit-both-same", groups);
  try {
    commitInitial(dir, {
      "frontend/common/foo.ts": "v1\n",
      "backend/common/foo.ts": "v1\n",
    });

    writeFile(dir, "frontend/common/foo.ts", "v2\n");
    writeFile(dir, "backend/common/foo.ts", "v2\n");

    const c = runScript(dir, "check");
    assertEqual(c.status, 0, "[B] check passes when both edited identically");

    const r = runScript(dir, "rebuild");
    assertEqual(r.status, 0, "[B] rebuild succeeds");
    assertIncludes(r.stdout, "already in lockstep", "[B] rebuild reports no-op");
  } finally { cleanup(dir); }
}

function phaseC_editBothDifferentlyIsRefused(): void {
  const groups = [{ paths: ["frontend/common", "backend/common"] }];
  const dir = makeRepo("C-edit-both-diff", groups);
  try {
    commitInitial(dir, {
      "frontend/common/foo.ts": "v1\n",
      "backend/common/foo.ts": "v1\n",
    });

    writeFile(dir, "frontend/common/foo.ts", "from frontend\n");
    writeFile(dir, "backend/common/foo.ts", "from backend\n");

    const r = runScript(dir, "rebuild");
    assertEqual(r.status, 2, "[C] rebuild should refuse on differing edits");
    assertIncludes(r.stderr, "edited with different content", "[C] error explains the conflict");

    // Working tree should NOT have been modified.
    assertEqual(readFile(dir, "frontend/common/foo.ts"), "from frontend\n", "[C] frontend untouched");
    assertEqual(readFile(dir, "backend/common/foo.ts"), "from backend\n", "[C] backend untouched");
  } finally { cleanup(dir); }
}

function phaseD_addNewFilePropagates(): void {
  const groups = [{ paths: ["frontend/common", "backend/common"] }];
  const dir = makeRepo("D-add-file", groups);
  try {
    commitInitial(dir, {
      "frontend/common/foo.ts": "foo\n",
      "backend/common/foo.ts": "foo\n",
    });

    writeFile(dir, "backend/common/bar.ts", "bar\n");

    const c = runScript(dir, "check");
    assertEqual(c.status, 1, "[D] check fails when new file is in one path only");
    assertIncludes(c.stderr, "bar.ts", "[D] missing file is named");

    const r = runScript(dir, "rebuild");
    assertEqual(r.status, 0, "[D] rebuild succeeds");
    assertEqual(readFile(dir, "frontend/common/bar.ts"), "bar\n", "[D] new file propagated to frontend");
    assertEqual(readFile(dir, "backend/common/bar.ts"), "bar\n", "[D] new file kept on backend");
  } finally { cleanup(dir); }
}

function phaseE_deletePropagates(): void {
  const groups = [{ paths: ["frontend/common", "backend/common"] }];
  const dir = makeRepo("E-delete", groups);
  try {
    commitInitial(dir, {
      "frontend/common/foo.ts": "foo\n",
      "frontend/common/bar.ts": "bar\n",
      "backend/common/foo.ts": "foo\n",
      "backend/common/bar.ts": "bar\n",
    });

    fs.unlinkSync(path.join(dir, "frontend/common/bar.ts"));

    const r = runScript(dir, "rebuild");
    assertEqual(r.status, 0, "[E] rebuild succeeds");
    assertEqual(exists(dir, "frontend/common/bar.ts"), false, "[E] bar.ts gone from frontend");
    assertEqual(exists(dir, "backend/common/bar.ts"), false, "[E] deletion propagated to backend");
    // foo.ts stays
    assertEqual(readFile(dir, "frontend/common/foo.ts"), "foo\n", "[E] foo.ts kept on frontend");
    assertEqual(readFile(dir, "backend/common/foo.ts"), "foo\n", "[E] foo.ts kept on backend");
  } finally { cleanup(dir); }
}

function phaseF_idempotency(): void {
  const groups = [{ paths: ["frontend/common", "backend/common"] }];
  const dir = makeRepo("F-idempotency", groups);
  try {
    commitInitial(dir, {
      "frontend/common/foo.ts": "v1\n",
      "backend/common/foo.ts": "v1\n",
    });

    writeFile(dir, "backend/common/foo.ts", "v2\n");
    const r1 = runScript(dir, "rebuild");
    assertEqual(r1.status, 0, "[F] first rebuild succeeds");

    const r2 = runScript(dir, "rebuild");
    assertEqual(r2.status, 0, "[F] second rebuild succeeds");
    assertIncludes(r2.stdout, "already in lockstep", "[F] second rebuild is a no-op");
  } finally { cleanup(dir); }
}

function phaseG_threePathsInGroup(): void {
  const groups = [{ paths: ["a/common", "b/common", "c/common"] }];
  const dir = makeRepo("G-three-paths", groups);
  try {
    commitInitial(dir, {
      "a/common/foo.ts": "v1\n",
      "b/common/foo.ts": "v1\n",
      "c/common/foo.ts": "v1\n",
    });

    writeFile(dir, "b/common/foo.ts", "v2 from b\n");

    const r = runScript(dir, "rebuild");
    assertEqual(r.status, 0, "[G] rebuild succeeds with 3 paths");
    assertEqual(readFile(dir, "a/common/foo.ts"), "v2 from b\n", "[G] a got it");
    assertEqual(readFile(dir, "c/common/foo.ts"), "v2 from b\n", "[G] c got it");
    assertEqual(readFile(dir, "b/common/foo.ts"), "v2 from b\n", "[G] b unchanged");
  } finally { cleanup(dir); }
}

function phaseH_noHeadInitialCommit(): void {
  // No HEAD yet — only one path is populated; rebuild should treat it as
  // source and create the others.
  const groups = [{ paths: ["frontend/common", "backend/common"] }];
  const dir = makeRepo("H-no-head", groups);
  try {
    writeFile(dir, "frontend/common/foo.ts", "initial\n");

    const r = runScript(dir, "rebuild");
    assertEqual(r.status, 0, "[H] rebuild succeeds with no HEAD and one populated path");
    assertEqual(readFile(dir, "backend/common/foo.ts"), "initial\n", "[H] backend populated from frontend");
    assertIncludes(r.stderr, "no HEAD", "[H] warning mentions missing HEAD");
  } finally { cleanup(dir); }
}

function phaseH2_noHeadBothPopulatedDifferently(): void {
  // No HEAD AND both paths have differing content — script must refuse.
  const groups = [{ paths: ["frontend/common", "backend/common"] }];
  const dir = makeRepo("H2-no-head-both", groups);
  try {
    writeFile(dir, "frontend/common/foo.ts", "from frontend\n");
    writeFile(dir, "backend/common/foo.ts", "from backend\n");

    const r = runScript(dir, "rebuild");
    assertEqual(r.status, 2, "[H2] rebuild refuses with no HEAD and divergent paths");
    assertIncludes(r.stderr, "no HEAD", "[H2] error mentions missing HEAD");
  } finally { cleanup(dir); }
}

function phaseI_validationNestedPaths(): void {
  const groups = [{ paths: ["common", "common/sub"] }];
  const dir = makeRepo("I-nested", groups);
  try {
    const r = runScript(dir, "check");
    assertEqual(r.status, 2, "[I] nested paths should fail validation");
    assertIncludes(r.stderr, "ancestor", "[I] error explains the ancestor relationship");
  } finally { cleanup(dir); }
}

function phaseJ_validationDuplicatePaths(): void {
  const groups = [
    { paths: ["a/common", "b/common"] },
    { paths: ["b/common", "c/common"] },  // b/common appears twice
  ];
  const dir = makeRepo("J-dup", groups);
  try {
    const r = runScript(dir, "check");
    assertEqual(r.status, 2, "[J] duplicate paths across groups should fail validation");
    assertIncludes(r.stderr, "appears in more than one place", "[J] error explains duplication");
  } finally { cleanup(dir); }
}

function phaseK_validationSinglePathGroup(): void {
  const groups = [{ paths: ["only/path"] }];
  const dir = makeRepo("K-single-path", groups);
  try {
    const r = runScript(dir, "check");
    assertEqual(r.status, 2, "[K] single-path group should fail validation");
    assertIncludes(r.stderr, "at least two paths", "[K] error explains the constraint");
  } finally { cleanup(dir); }
}

function phaseL_validationAbsoluteOrEscaping(): void {
  for (const bad of ["/abs/path", "../escape", "."]) {
    const dir = makeRepo("L-bad-" + bad.replace(/[^a-z]/g, "_"), [{ paths: [bad, "ok/path"] }]);
    try {
      const r = runScript(dir, "check");
      assertEqual(r.status, 2, `[L] '${bad}' should fail validation`);
      assertIncludes(r.stderr, "safe relative path", `[L] '${bad}' error mentions the safety check`);
    } finally { cleanup(dir); }
  }
}

function phaseM_symlinkRefused(): void {
  // Windows symlink creation requires elevated privileges or dev mode; skip.
  if (process.platform === "win32") {
    console.log("  [M] skipped on Windows");
    return;
  }
  const groups = [{ paths: ["frontend/common", "backend/common"] }];
  const dir = makeRepo("M-symlink", groups);
  try {
    fs.mkdirSync(path.join(dir, "frontend/common"), { recursive: true });
    fs.mkdirSync(path.join(dir, "backend/common"), { recursive: true });
    writeFile(dir, "frontend/common/regular.ts", "x\n");
    writeFile(dir, "backend/common/regular.ts", "x\n");
    fs.symlinkSync("regular.ts", path.join(dir, "backend/common/link.ts"));

    const r = runScript(dir, "check");
    assertEqual(r.status, 2, "[M] symlink should be refused");
    assertIncludes(r.stderr, "symlink", "[M] error mentions symlink");
  } finally { cleanup(dir); }
}

function phaseN_divergingInHeadIsRefused(): void {
  // Both paths committed with different content; nothing modified vs HEAD.
  // Script can't pick a side without a working-tree edit.
  const groups = [{ paths: ["frontend/common", "backend/common"] }];
  const dir = makeRepo("N-head-divergent", groups);
  try {
    commitInitial(dir, {
      "frontend/common/foo.ts": "from frontend\n",
      "backend/common/foo.ts": "from backend\n",
    });

    const c = runScript(dir, "check");
    assertEqual(c.status, 1, "[N] check fails when HEAD itself diverges");

    const r = runScript(dir, "rebuild");
    assertEqual(r.status, 2, "[N] rebuild refuses when nothing was edited");
    assertIncludes(r.stderr, "match HEAD individually", "[N] error explains HEAD divergence");
  } finally { cleanup(dir); }
}

function phaseO_emptyVsMissingFolder(): void {
  // An empty folder counts as "no entries", same as a missing folder.
  const groups = [{ paths: ["frontend/common", "backend/common"] }];
  const dir = makeRepo("O-empty-vs-missing", groups);
  try {
    fs.mkdirSync(path.join(dir, "frontend/common"), { recursive: true });
    // backend/common doesn't exist at all; frontend/common is empty.
    // Both fingerprint to the same empty hash, so no-op.
    commitInitial(dir, { "placeholder.txt": "x\n" });

    const r = runScript(dir, "rebuild");
    assertEqual(r.status, 0, "[O] empty + missing rebuild is a no-op");
    assertIncludes(r.stdout, "lockstep", "[O] reports no-op");
  } finally { cleanup(dir); }
}

function phaseP_binaryAndUnicodeContent(): void {
  const groups = [{ paths: ["frontend/common", "backend/common"] }];
  const dir = makeRepo("P-binary", groups);
  try {
    const binary = Buffer.from([0x00, 0x01, 0xFF, 0xFE, 0x42, 0x00]);
    const unicode = "日本語\nемодзі: 🎯\n";

    commitInitial(dir, {
      "frontend/common/text.txt": "init\n",
      "backend/common/text.txt": "init\n",
    });

    writeFile(dir, "frontend/common/blob.bin", binary);
    writeFile(dir, "frontend/common/text.txt", unicode);

    const r = runScript(dir, "rebuild");
    assertEqual(r.status, 0, "[P] rebuild handles binary + unicode");
    const propBinary = fs.readFileSync(path.join(dir, "backend/common/blob.bin"));
    assertEqual(propBinary.equals(binary), true, "[P] binary bytes preserved");
    assertEqual(readFile(dir, "backend/common/text.txt"), unicode, "[P] unicode preserved");
  } finally { cleanup(dir); }
}

function phaseQ_pathsWithSpaces(): void {
  const groups = [{ paths: ["frontend/common", "backend/common"] }];
  const dir = makeRepo("Q-spaces", groups);
  try {
    commitInitial(dir, {
      "frontend/common/with space.ts": "v1\n",
      "frontend/common/sub dir/nested.ts": "n1\n",
      "backend/common/with space.ts": "v1\n",
      "backend/common/sub dir/nested.ts": "n1\n",
    });

    writeFile(dir, "frontend/common/with space.ts", "v2\n");
    writeFile(dir, "frontend/common/sub dir/nested.ts", "n2\n");

    const r = runScript(dir, "rebuild");
    assertEqual(r.status, 0, "[Q] rebuild handles paths with spaces");
    assertEqual(readFile(dir, "backend/common/with space.ts"), "v2\n", "[Q] spaced filename propagated");
    assertEqual(readFile(dir, "backend/common/sub dir/nested.ts"), "n2\n", "[Q] nested spaced dir propagated");

    const staged = diffNamesFromIndex(dir);
    assertEqual(
      staged.includes("backend/common/with space.ts"), true,
      "[Q] file with space is staged",
    );
  } finally { cleanup(dir); }
}

function phaseR_emptyConfigIsNoOp(): void {
  const dir = makeRepo("R-empty-cfg", []);
  try {
    const c = runScript(dir, "check");
    assertEqual(c.status, 0, "[R] empty config check is no-op");
    assertIncludes(c.stdout, "no groups configured", "[R] message mentions empty config");

    const r = runScript(dir, "rebuild");
    assertEqual(r.status, 0, "[R] empty config rebuild is no-op");
  } finally { cleanup(dir); }
}

function phaseS_unknownModeRefused(): void {
  const groups = [{ paths: ["a/common", "b/common"] }];
  const dir = makeRepo("S-unknown-mode", groups);
  try {
    const r = runScript(dir, "frobnicate");
    assertEqual(r.status, 2, "[S] unknown mode should fail");
    assertIncludes(r.stderr, "unknown mode", "[S] error names the bad mode");
  } finally { cleanup(dir); }
}

function phaseT_modifiedTwiceWithMatchingContentPropagatesToOthers(): void {
  // Three paths. Dev edits two of them identically; the third is unchanged.
  // Script should detect both as source (matching), propagate to the third.
  const groups = [{ paths: ["a/common", "b/common", "c/common"] }];
  const dir = makeRepo("T-multi-modified-same", groups);
  try {
    commitInitial(dir, {
      "a/common/foo.ts": "v1\n",
      "b/common/foo.ts": "v1\n",
      "c/common/foo.ts": "v1\n",
    });

    writeFile(dir, "a/common/foo.ts", "v2\n");
    writeFile(dir, "b/common/foo.ts", "v2\n");
    // c unchanged

    const r = runScript(dir, "rebuild");
    assertEqual(r.status, 0, "[T] rebuild handles multiple matching edits");
    assertEqual(readFile(dir, "c/common/foo.ts"), "v2\n", "[T] c got the agreed edit");
  } finally { cleanup(dir); }
}

function phaseU_multipleGroupsIndependent(): void {
  const groups = [
    { paths: ["alpha/x", "beta/x"] },
    { paths: ["gamma/y", "delta/y"] },
  ];
  const dir = makeRepo("U-multi-group", groups);
  try {
    commitInitial(dir, {
      "alpha/x/a.ts": "g1\n",
      "beta/x/a.ts":  "g1\n",
      "gamma/y/b.ts": "g2\n",
      "delta/y/b.ts": "g2\n",
    });

    // Edit one file in group 1, leave group 2 alone.
    writeFile(dir, "alpha/x/a.ts", "g1 v2\n");

    const r = runScript(dir, "rebuild");
    assertEqual(r.status, 0, "[U] rebuild succeeds across groups");
    assertEqual(readFile(dir, "beta/x/a.ts"), "g1 v2\n", "[U] group 1 propagated");
    assertEqual(readFile(dir, "gamma/y/b.ts"), "g2\n", "[U] group 2 untouched");
    assertEqual(readFile(dir, "delta/y/b.ts"), "g2\n", "[U] group 2 untouched");
  } finally { cleanup(dir); }
}

function phaseV_executableBitPropagates(): void {
  if (process.platform === "win32") {
    console.log("  [V] skipped on Windows (chmod is a no-op)");
    return;
  }
  const groups = [{ paths: ["frontend/common", "backend/common"] }];
  const dir = makeRepo("V-exec-bit", groups);
  try {
    commitInitial(dir, {
      "frontend/common/script.sh": "#!/bin/sh\necho hi\n",
      "backend/common/script.sh":  "#!/bin/sh\necho hi\n",
    });
    fs.chmodSync(path.join(dir, "frontend/common/script.sh"), 0o755);

    // Touch backend's working copy so it differs (otherwise the file alone
    // doesn't surface — exec bit on Linux flips fingerprint already, but
    // double-tap with a content edit makes the test independent of any
    // mode-only edge cases).
    writeFile(dir, "frontend/common/script.sh", "#!/bin/sh\necho updated\n");
    fs.chmodSync(path.join(dir, "frontend/common/script.sh"), 0o755);

    const r = runScript(dir, "rebuild");
    assertEqual(r.status, 0, "[V] rebuild succeeds");
    const backendStat = fs.statSync(path.join(dir, "backend/common/script.sh"));
    assertEqual((backendStat.mode & 0o100) !== 0, true, "[V] exec bit propagated to backend");
  } finally { cleanup(dir); }
}

function phaseW_rebuildOverwritesUnstageEdit(): void {
  // Confirms the destructive direction is documented: if a dev edits a path
  // intending it to be the source, but ALSO accidentally has stale modifs in
  // another path that disagree, rebuild refuses (Phase C). This phase
  // exercises the simpler case: dev edits exactly one path, rebuild
  // overwrites the others. Already covered by Phase A — included here as a
  // regression marker for "rebuild deletes target content not in source".
  const groups = [{ paths: ["frontend/common", "backend/common"] }];
  const dir = makeRepo("W-overwrite-stale", groups);
  try {
    commitInitial(dir, {
      "frontend/common/keep.ts": "k\n",
      "frontend/common/stale.ts": "s\n",
      "backend/common/keep.ts": "k\n",
      "backend/common/stale.ts": "s\n",
    });

    // Source edit removes stale.ts and modifies keep.ts.
    fs.unlinkSync(path.join(dir, "frontend/common/stale.ts"));
    writeFile(dir, "frontend/common/keep.ts", "k v2\n");

    const r = runScript(dir, "rebuild");
    assertEqual(r.status, 0, "[W] rebuild succeeds");
    assertEqual(readFile(dir, "backend/common/keep.ts"), "k v2\n", "[W] modify propagated");
    assertEqual(exists(dir, "backend/common/stale.ts"), false, "[W] stale file removed from backend");
  } finally { cleanup(dir); }
}

// ── Driver ───────────────────────────────────────────────────────────────────

const phases: Array<[string, () => void]> = [
  ["A: edit one propagates to other",                    phaseA_editOnePropagatesToOther],
  ["B: identical edits is no-op",                        phaseB_editBothIdenticallyIsNoOp],
  ["C: divergent edits refused",                         phaseC_editBothDifferentlyIsRefused],
  ["D: new file propagates",                             phaseD_addNewFilePropagates],
  ["E: deletion propagates",                             phaseE_deletePropagates],
  ["F: rebuild is idempotent",                           phaseF_idempotency],
  ["G: three paths in a group",                          phaseG_threePathsInGroup],
  ["H: no HEAD, single populated path",                  phaseH_noHeadInitialCommit],
  ["H2: no HEAD, divergent populated paths refused",     phaseH2_noHeadBothPopulatedDifferently],
  ["I: nested paths refused",                            phaseI_validationNestedPaths],
  ["J: duplicate paths refused",                         phaseJ_validationDuplicatePaths],
  ["K: single-path group refused",                       phaseK_validationSinglePathGroup],
  ["L: unsafe relative paths refused",                   phaseL_validationAbsoluteOrEscaping],
  ["M: symlink refused (Unix)",                          phaseM_symlinkRefused],
  ["N: HEAD itself divergent — refused",                 phaseN_divergingInHeadIsRefused],
  ["O: empty folder ≡ missing folder",                   phaseO_emptyVsMissingFolder],
  ["P: binary + unicode preserved",                      phaseP_binaryAndUnicodeContent],
  ["Q: paths with spaces and nested dirs",               phaseQ_pathsWithSpaces],
  ["R: empty config no-op",                              phaseR_emptyConfigIsNoOp],
  ["S: unknown mode rejected",                           phaseS_unknownModeRefused],
  ["T: multiple paths edited identically propagate",     phaseT_modifiedTwiceWithMatchingContentPropagatesToOthers],
  ["U: multiple groups are independent",                 phaseU_multipleGroupsIndependent],
  ["V: exec bit propagates (Unix)",                      phaseV_executableBitPropagates],
  ["W: rebuild removes stale target files",              phaseW_rebuildOverwritesUnstageEdit],
];

export default function run() {
  for (const [label, fn] of phases) {
    try {
      fn();
      console.log(`  PASS  ${label}`);
    } catch (e) {
      console.log(`  FAIL  ${label}`);
      console.log(`        ${(e as Error).message}`);
      throw e;
    }
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-copy-paths");
}
