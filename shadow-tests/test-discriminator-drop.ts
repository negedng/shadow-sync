/**
 * Asserts that the discriminator drops TREESAME merges whose non-first
 * parents contribute nothing kept in scope above their merge-base with the
 * 1st parent — i.e. vacuous merges with no load-bearing side content.
 *
 * Under the ancestry-based rule, a merge is droppable iff every non-first
 * parent's `git rev-list Pi ^P1` set is empty of kept commits. The "kept"
 * universe is itself path-filtered: commits whose effective tree at the
 * synced path matches their 1st parent's drop out (and a side branch built
 * entirely of such commits leaves no kept exclusive ancestor).
 *
 * Two sub-cases here exercise that property:
 *
 *   "did-then-undid" (was Case D-variant in older builds): mono creates
 *     `stale-feature` off main, adds `+backend/stale.txt` (touches the
 *     backend slice → kept), then merges with `-s ours` discarding the
 *     change. The side branch holds a KEPT commit, so the merge is
 *     load-bearing and IS replayed — even though the merge's tree at
 *     backend/ equals the 1st parent's. The synthetic on the shadow chain
 *     records "merged then discarded" and keeps the side-branch commit's
 *     synthetic anchored.
 *
 *   "frontend-only stale": mono creates `frontend-stale`, modifies only
 *     `frontend/stale.txt`, switches back, adds another frontend change to
 *     main, then `git merge --no-ff frontend-stale`. From the backend
 *     pair's perspective, the side branch contributed nothing in scope —
 *     all its commits drop on path filtering — so the merge is vacuous and
 *     IS DROPPED.
 *
 * Run: npx tsx shadow-tests/test-discriminator-drop.ts
 */
import { execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runSync } from "../shadow-sync";
import { applyTestOverrides, compileIgnorePattern, setBranchFiltersForTesting } from "../shadow-common";

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}
function writeRepoConfig(workDir: string, identity: { email: string; name: string }) {
  fs.appendFileSync(path.join(workDir, ".git", "config"),
    `[user]\n\temail = ${identity.email}\n\tname = ${identity.name}\n[core]\n\tautocrlf = false\n`);
}
interface Repo { bare: string; working: string; }
function createRepo(tmpDir: string, name: string, identity: { email: string; name: string }): Repo {
  const bare = path.join(tmpDir, `${name}-bare`).replace(/\\/g, "/");
  const working = path.join(tmpDir, `${name}-working`).replace(/\\/g, "/");
  fs.mkdirSync(bare);
  git("init --bare --initial-branch=main", bare);
  execSync(`git clone "${bare}" "${working}"`, { encoding: "utf8", stdio: "pipe" });
  writeRepoConfig(working, identity);
  git("symbolic-ref HEAD refs/heads/main", working);
  return { bare, working };
}
function commitFiles(repo: Repo, files: Record<string, string>, msg: string): string {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(repo.working, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  git("add -A", repo.working);
  git(`commit -m "${msg}"`, repo.working);
  return git("rev-parse HEAD", repo.working);
}
function banner(s: string) { console.log("\n" + "─".repeat(70) + "\n  " + s + "\n" + "─".repeat(70)); }

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-no-vacuous-"));
  console.log(`[tmp] ${tmpDir}`);

  try {
    const backend = createRepo(tmpDir, "backend", { email: "bea@example.com", name: "Bea" });
    const mono    = createRepo(tmpDir, "mono",    { email: "mira@example.com", name: "Mira" });
    git(`remote add backend "${backend.bare}"`, mono.working);

    git(`commit --allow-empty -m "Bc0"`, backend.working);
    git("push origin main", backend.working);
    commitFiles(mono, { "README.md": "monorepo\n" }, "Mc0");
    git("push origin main", mono.working);

    applyTestOverrides({
      repoRoot: mono.working,
      pairs: [
        { name: "backend", a: { remote: "origin", url: mono.bare, label: "a-backend" }, b: { remote: "backend", url: backend.bare, label: "b-backend" }, mappings: [{ a: "backend", b: "" }] },
      ],
      shadowBranchPrefix: "shadow",
    });
    // Not a filter test — wildcard.
    setBranchFiltersForTesting(new Map([
      ["origin",  [compileIgnorePattern("**")]],
      ["backend", [compileIgnorePattern("**")]],
    ]));

    banner("Bootstrap sync");
    let r = await runSync({ from: "b" });
    if (r.exitCode !== 0) { console.error(r.stderr); throw new Error("bootstrap b"); }
    r = await runSync({ from: "a" });
    if (r.exitCode !== 0) { console.error(r.stderr); throw new Error("bootstrap a"); }

    banner("Round 1: concurrent commits (bea1 on backend, mira1 on mono backend/)");
    commitFiles(backend, { "bea1.txt": "bea1\n" }, "Bea: bea1");
    git("push origin main", backend.working);
    commitFiles(mono, { "backend/mira1.txt": "mira1\n" }, "Mira: backend/mira1.txt");
    git("push origin main", mono.working);

    r = await runSync({ from: "b" }); if (r.exitCode !== 0) throw new Error("r1 b");
    r = await runSync({ from: "a" }); if (r.exitCode !== 0) throw new Error("r1 a");

    // Capture shadow tip BEFORE the operator merges.
    const preSHA = git("rev-parse refs/heads/a-backend/main", backend.bare);
    const preCount = parseInt(git("rev-list --count refs/heads/a-backend/main", backend.bare), 10);
    console.log(`  Pre-merge shadow tip: ${preSHA.slice(0,12)} (commit count: ${preCount})`);

    banner("did-then-undid: TS-1 -s ours merge, side branch HAS a kept commit (load-bearing)");
    git("checkout -b stale-feature", mono.working);
    commitFiles(mono, { "backend/stale.txt": "stale branch's backend work\n" }, "Mira: stale backend work");
    git("checkout main", mono.working);
    git(`merge --no-ff -s ours stale-feature -m "Mira: integrate stale-feature with -s ours"`, mono.working);
    const mergeC = git("rev-parse HEAD", mono.working);
    const mergeCBackendTree = git("rev-parse HEAD:backend", mono.working);
    const [pC1, pC2] = git("log -1 --format=%P HEAD", mono.working).split(" ");
    const pC1Tree = git(`rev-parse ${pC1}:backend`, mono.working);
    const pC2Tree = git(`rev-parse ${pC2}:backend`, mono.working);
    console.log(`  Merge SHA: ${mergeC.slice(0,12)}`);
    console.log(`  TS-1: ${mergeCBackendTree === pC1Tree ? "✓" : "✗"}  TS-2: ${mergeCBackendTree === pC2Tree ? "✓ (unexpected)" : "✗ (expected)"}`);

    banner("Case E: TS-both, no shadow trailer (frontend-only stale branch)");
    // Stale branch with only frontend changes. After branching, mono.main also
    // accumulates frontend changes. Merge --no-ff: both parents' backend trees
    // are unchanged from the merge base, so the merge is TS-both under backend/.
    git("checkout -b frontend-stale", mono.working);
    commitFiles(mono, { "frontend/stale.txt": "stale frontend\n" }, "Mira: stale frontend");
    git("checkout main", mono.working);
    commitFiles(mono, { "frontend/active.txt": "active frontend\n" }, "Mira: active frontend on main");
    git(`merge --no-ff frontend-stale -m "Mira: merge frontend-stale (TS-both under backend/)"`, mono.working);
    const mergeD = git("rev-parse HEAD", mono.working);
    const mergeDBackendTree = git("rev-parse HEAD:backend", mono.working);
    const [pD1, pD2] = git("log -1 --format=%P HEAD", mono.working).split(" ");
    const pD1Tree = git(`rev-parse ${pD1}:backend`, mono.working);
    const pD2Tree = git(`rev-parse ${pD2}:backend`, mono.working);
    console.log(`  Merge SHA: ${mergeD.slice(0,12)}`);
    console.log(`  TS-1: ${mergeDBackendTree === pD1Tree ? "✓" : "✗"}  TS-2: ${mergeDBackendTree === pD2Tree ? "✓" : "✗"} (both expected)`);

    git("push origin main", mono.working);

    banner("--from a (the test)");
    r = await runSync({ from: "a" });
    if (r.exitCode !== 0) {
      console.error(r.stdout); console.error(r.stderr);
      throw new Error("--from a halted unexpectedly");
    }

    // Assertions:
    //   did-then-undid (mergeC): side branch had a backend-touching commit, so
    //     the merge is load-bearing and SHOULD appear on the shadow chain.
    //   frontend-only stale (mergeD): side branch contributed nothing in scope,
    //     so the merge is vacuous and SHOULD NOT appear.
    const shadowLog = git(`log --format=%B refs/heads/a-backend/main`, backend.bare);
    const shadowCount = parseInt(git("rev-list --count refs/heads/a-backend/main", backend.bare), 10);
    console.log(`  Shadow chain commit count: ${shadowCount} (was ${preCount})`);

    const mergeHasSynthetic = (sha: string): boolean => {
      const re = new RegExp(`^a-backend-to-b-backend:\\s*${sha}\\b`, "m");
      return re.test(shadowLog);
    };
    const undidPresent = mergeHasSynthetic(mergeC);
    const stalePresent = mergeHasSynthetic(mergeD);
    console.log(`  did-then-undid (${mergeC.slice(0,12)}) appears on shadow chain: ${undidPresent ? "YES (expected — kept)" : "NO (regression)"}`);
    console.log(`  frontend-only stale (${mergeD.slice(0,12)}) appears on shadow chain: ${stalePresent ? "YES (regression)" : "NO (expected — dropped)"}`);
    if (undidPresent && !stalePresent) {
      console.log("\n  ✓ PASS — did-then-undid kept; vacuous frontend-only merge dropped.");
    } else {
      console.log("\n  ✘ FAIL — assertion mismatch (see line above).");
      process.exit(1);
    }
  } finally {
    setBranchFiltersForTesting(null);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch(e => { console.error("\n[error]", e.message); process.exit(1); });
