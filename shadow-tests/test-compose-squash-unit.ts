/**
 * test-compose-squash-unit.ts — unit tests for B' composition.
 *
 * Focuses on composeSquashedMergeTree's argument order (an argument-swap bug
 * would silently produce a wrong tree). Most of findResolutionCandidate is
 * exercised end-to-end in test-conflict-squash-b-prime.ts; this file covers
 * just the wrong-shape rejection path that the integration test cannot easily
 * isolate.
 */
import { execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { composeSquashedMergeTree, findResolutionCandidate, applyTestOverrides } from "../shadow-common";

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}
function gitVoid(cmd: string, cwd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: "pipe" });
}
function writeFile(dir: string, rel: string, content: string): void {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}
function assertEqual<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function mkRepo(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `b-prime-unit-${name}-`));
  gitVoid("init", dir);
  fs.appendFileSync(path.join(dir, ".git", "config"),
    "[user]\n\temail = u@t.com\n\tname = U\n[core]\n\tautocrlf = false\n");
  applyTestOverrides({ repoRoot: dir, pairs: [], shadowBranchPrefix: "shadow" });
  return dir;
}

/**
 * Build Mm with a known outer (frontend.txt, README.md) + dummy backend/ inner,
 * and Bm with completely different backend/ inner. Compose, then verify:
 *   - outer (non-backend/) entries come from Mm
 *   - backend/ entries equal Bm.tree exactly (NOT Mm's backend/)
 */
function runComposeArgumentOrder(): void {
  const dir = mkRepo("compose");

  // Mm-like tree: outer files + a placeholder backend/
  writeFile(dir, "frontend.txt", "fe\n");
  writeFile(dir, "README.md", "readme\n");
  writeFile(dir, "backend/placeholder.ts", "MM_PLACEHOLDER\n");
  gitVoid("add -A", dir);
  gitVoid('commit -m "mm"', dir);
  const mm = git("rev-parse HEAD", dir);

  // Bm-like tree on an orphan branch: ONLY backend/ files
  gitVoid("checkout --orphan bm-branch", dir);
  gitVoid("rm -rf --cached .", dir);
  fs.rmSync(path.join(dir, "frontend.txt"));
  fs.rmSync(path.join(dir, "README.md"));
  fs.rmSync(path.join(dir, "backend/placeholder.ts"));
  writeFile(dir, "api.ts", "v_be_initial + v_be_project\n");
  writeFile(dir, "feature.ts", "be feature added in Bcx\n");
  gitVoid("add -A", dir);
  gitVoid('commit -m "bm"', dir);
  const bm = git("rev-parse HEAD", dir);

  const composed = composeSquashedMergeTree({ mm, bm, targetDir: "backend" });
  const entries = git(`ls-tree -r ${composed}`, dir);

  // Outer: README.md and frontend.txt from Mm
  assert(/\tREADME\.md$/m.test(entries), `composed tree missing README.md (Mm outer):\n${entries}`);
  assert(/\tfrontend\.txt$/m.test(entries), `composed tree missing frontend.txt (Mm outer):\n${entries}`);

  // Inner: backend/ entries should be Bm's tree files (api.ts, feature.ts), not Mm's placeholder
  assert(/\tbackend\/api\.ts$/m.test(entries), `composed tree missing backend/api.ts (Bm inner):\n${entries}`);
  assert(/\tbackend\/feature\.ts$/m.test(entries), `composed tree missing backend/feature.ts (Bm inner):\n${entries}`);
  assert(!/\tbackend\/placeholder\.ts$/m.test(entries), `composed tree should NOT have Mm's backend/placeholder.ts:\n${entries}`);

  // Content check: api.ts on composed = api.ts on Bm.tree
  const composedApi = git(`show ${composed}:backend/api.ts`, dir).trim();
  const bmApi = git(`show ${bm}:api.ts`, dir).trim();
  assertEqual(composedApi, bmApi, "composed backend/api.ts must equal Bm api.ts");

  fs.rmSync(dir, { recursive: true, force: true });
}

/** No targetDir: source and target share layout; composed = Mm.tree verbatim. */
function runComposeNoTargetDir(): void {
  const dir = mkRepo("compose-flat");
  writeFile(dir, "a.txt", "a\n");
  gitVoid("add -A", dir);
  gitVoid('commit -m "mm"', dir);
  const mm = git("rev-parse HEAD", dir);
  const mmTree = git(`rev-parse "${mm}^{tree}"`, dir);

  gitVoid("checkout --orphan bm", dir);
  gitVoid("rm -rf --cached .", dir);
  fs.rmSync(path.join(dir, "a.txt"));
  writeFile(dir, "b.txt", "b\n");
  gitVoid("add -A", dir);
  gitVoid('commit -m "bm"', dir);
  const bm = git("rev-parse HEAD", dir);

  const composed = composeSquashedMergeTree({ mm, bm, targetDir: "" });
  assertEqual(composed, mmTree, "no targetDir → composed must equal Mm.tree");

  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Wrong-shape Mm: parents[1] not reachable from the inferred from-branch.
 * Synthesizes a minimal scenario: source has core-dev (with Bm) and project;
 * target has core-dev (with a 2-parent merge whose parents[1] is unrelated)
 * and project. findResolutionCandidate must NOT return Mm.
 */
function runFindWrongShape(): void {
  const dir = mkRepo("find-wrong-shape");

  // Source (we'll point at "src" remote) — populated via local refs
  writeFile(dir, "f.txt", "1\n");
  gitVoid("add -A", dir);
  gitVoid('commit -m "init"', dir);
  const init = git("rev-parse HEAD", dir);

  // Source side: build core-dev and project, then Bm merging project into core-dev
  gitVoid("branch src-core-dev", dir);
  gitVoid("checkout -b src-project", dir);
  writeFile(dir, "f.txt", "project\n");
  gitVoid("add -A", dir);
  gitVoid('commit -m "src-Bp"', dir);
  gitVoid("checkout src-core-dev", dir);
  writeFile(dir, "f.txt", "core\n");
  gitVoid("add -A", dir);
  gitVoid('commit -m "src-Bc"', dir);
  try {
    gitVoid("merge --no-ff src-project -m src-Bm", dir);
  } catch {
    writeFile(dir, "f.txt", "merged\n");
    gitVoid("add -A", dir);
    gitVoid('commit --no-edit', dir);
  }
  const bm = git("rev-parse HEAD", dir);
  const bmParents = git(`log -1 --format=%P ${bm}`, dir).split(/\s+/);

  // Register src-core-dev / src-project as remote-tracking refs (synthetic
  // remote: copy refs into refs/remotes/src/)
  gitVoid(`update-ref refs/remotes/src/core-dev src-core-dev`, dir);
  gitVoid(`update-ref refs/remotes/src/project src-project`, dir);

  // Target side: a 2-parent merge on tgt-core-dev whose parents[1] is NOT on
  // tgt-project's history. We build an unrelated branch tgt-extra and merge
  // it instead — shape check should reject this.
  gitVoid(`checkout -b tgt-core-dev ${init}`, dir);
  writeFile(dir, "f.txt", "tgt-core\n");
  gitVoid("add -A", dir);
  gitVoid('commit -m "tgt-Mc"', dir);

  gitVoid(`checkout -b tgt-project ${init}`, dir);
  writeFile(dir, "f.txt", "tgt-project\n");
  gitVoid("add -A", dir);
  gitVoid('commit -m "tgt-Mp"', dir);

  gitVoid(`checkout -b tgt-extra ${init}`, dir);
  writeFile(dir, "f.txt", "tgt-extra\n");
  gitVoid("add -A", dir);
  gitVoid('commit -m "tgt-extra-tip"', dir);

  gitVoid("checkout tgt-core-dev", dir);
  try {
    gitVoid("merge --no-ff tgt-extra -m tgt-WrongMerge", dir);
  } catch {
    writeFile(dir, "f.txt", "tgt-merged-wrong\n");
    gitVoid("add -A", dir);
    gitVoid('commit --no-edit', dir);
  }

  gitVoid(`update-ref refs/remotes/tgt/core-dev tgt-core-dev`, dir);
  gitVoid(`update-ref refs/remotes/tgt/project tgt-project`, dir);

  // Build a TopoCommit for Bm
  const result = findResolutionCandidate({
    commit: { hash: bm, parents: bmParents },
    mappedParents: [init, init], // placeholder; not used by the shape check
    source: { remote: "src", url: "", dir: "" },
    target: { remote: "tgt", url: "", dir: "" },
    pair: { name: "test-pair", a: { remote: "tgt", url: "", dir: "" }, b: { remote: "src", url: "", dir: "" } },
    using: [],
  });

  assertEqual(result.mm, null, "wrong-shape merge must not be returned as Mm");
  assertEqual(result.ambiguous, false, "wrong-shape should not produce ambiguity");

  fs.rmSync(dir, { recursive: true, force: true });
}

async function main(): Promise<void> {
  const subs: Array<[string, () => void]> = [
    ["compose-argument-order", runComposeArgumentOrder],
    ["compose-no-target-dir", runComposeNoTargetDir],
    ["find-wrong-shape-rejected", runFindWrongShape],
  ];
  let failed = 0;
  for (const [name, fn] of subs) {
    try {
      fn();
      console.log(`  ✓ ${name}`);
    } catch (e: any) {
      console.error(`  ✘ ${name}: ${e.message}`);
      failed++;
    }
  }
  if (failed > 0) {
    console.log(`FAIL  test-compose-squash-unit (${failed}/${subs.length} sub-test(s) failed)`);
    process.exit(1);
  }
  console.log("PASS  test-compose-squash-unit");
}

main().catch(err => { console.error(err); process.exit(1); });
