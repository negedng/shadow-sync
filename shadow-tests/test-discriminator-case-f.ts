/**
 * Asserts that the unified discriminator DROPS Case F commits — non-merges
 * whose source-side diff under sourceDir/ is entirely inside the effective
 * ignore filter (autoIgnorePatterns + this commit's .shadowignore). Two
 * sub-tests:
 *
 *   E.1 (autoIgnore): pair "backend" maps backend (dir="") ↔ mono "backend".
 *       Sibling pair "common-backend" owns "src/common" on the backend
 *       side, so the "backend" pair gets autoIgnorePatterns = ["src/common",
 *       "src/common/**"]. Backend commits a change touching
 *       ONLY that ignored subtree. The "backend" pair must drop it; the
 *       "common-backend" pair (whose filter doesn't ignore common/) keeps it.
 *
 *   E.2 (.shadowignore): single-pair, source has .shadowignore="*.local".
 *       Source commits ONLY a *.local file. Effective tree (with *.local
 *       stripped) equals the parent's → drop.
 *
 * The implemented discriminator computes effective trees via
 * `effectiveSourceTree` (read-tree → rm --cached ignored paths → write-tree)
 * and finds the commit's effective tree equals its parent's. Non-merge, so the
 * trailer carve-out doesn't apply: dropped at the source walk.
 *
 * Expected on each sub-test:
 *   1. NO `Shadow-replayed-<source-remote>: <sha>` trailer for the ignore-only
 *      commit on the relevant shadow chain.
 *   2. Idempotent: a second sync (same direction) emits NO `Replaying ...`
 *      log line for that commit — the predicate is deterministic from source
 *      state alone, no side cache needed.
 *
 * Counterexample (what dropping prevents):
 *   Under the old `isLoadBearingMerge` (merges only, raw trees), the commit
 *   was kept by the post-filter. `buildReplayedTree` at replay would strip
 *   every changed path via the ignore filter, producing a target tree equal
 *   to the parent's; `commit-tree` would then emit a trailer-only synthetic
 *   on the shadow chain. Subsequent syncs would re-process the same source
 *   SHA each time (no trailer ever lands), triggering idempotence failures
 *   and clutter on the shadow chain (e.g. b558090-shaped commits in the
 *   user's production sht repos).
 *
 * Run: npx tsx shadow-tests/test-discriminator-case-f.ts
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

function checkTrailerAbsent(repoLogSource: { bare: string }, ref: string, sha: string, label: string) {
  const log = git(`log --format=%B ${ref}`, repoLogSource.bare);
  const re = new RegExp(`^Shadow-replayed-[^:]+:\\s*${sha}\\b`, "m");
  if (re.test(log)) {
    console.log(`  ✘ FAIL [${label}] — trailer for ${sha.slice(0, 12)} found on ${ref}`);
    process.exit(1);
  }
  console.log(`  ✓ [${label}] no trailer for ${sha.slice(0, 12)} on ${ref}`);
}

function checkTrailerPresent(repoLogSource: { bare: string }, ref: string, sha: string, label: string) {
  const log = git(`log --format=%B ${ref}`, repoLogSource.bare);
  const re = new RegExp(`^Shadow-replayed-[^:]+:\\s*${sha}\\b`, "m");
  if (!re.test(log)) {
    console.log(`  ✘ FAIL [${label}] — trailer for ${sha.slice(0, 12)} expected on ${ref} but missing`);
    process.exit(1);
  }
  console.log(`  ✓ [${label}] trailer for ${sha.slice(0, 12)} present on ${ref}`);
}

function assertIdempotent(syncResult: { stdout: string }, sha: string, label: string) {
  const lines = syncResult.stdout.split("\n").filter(l => /^\s*Replaying /.test(l));
  const offender = lines.find(l => l.includes(sha.slice(0, 7)));
  if (offender) {
    console.log(`  ✘ FAIL [${label}] — re-replay of ${sha.slice(0, 12)} on idempotent sync:`);
    console.log(`      ${offender}`);
    process.exit(1);
  }
  console.log(`  ✓ [${label}] idempotent — no Replaying line for ${sha.slice(0, 12)}`);
}

async function runE1AutoIgnore(tmpDir: string) {
  banner("E.1 — autoIgnore-only non-merge");
  const backend  = createRepo(tmpDir, "e1-backend",  { email: "bea@example.com",  name: "Bea"  });
  const mono     = createRepo(tmpDir, "e1-mono",     { email: "mira@example.com", name: "Mira" });
  git(`remote add backend "${backend.bare}"`, mono.working);

  commitFiles(backend, { "init.txt": "init\n", "src/common/util.ts": "util v1\n" }, "Bc0");
  git("push origin main", backend.working);
  commitFiles(mono, { "README.md": "monorepo\n" }, "Mc0");
  git("push origin main", mono.working);

  applyTestOverrides({
    repoRoot: mono.working,
    pairs: [
      // Sibling overlap: "backend" pair's source (dir="") contains
      // "common-backend"'s source dir "src/common". The "backend"
      // pair gets autoIgnorePatterns covering that nested subtree.
      { name: "backend",        a: { remote: "origin", url: mono.bare }, b: { remote: "backend", url: backend.bare }, mappings: [{ a: "backend", b: "" }] },
      { name: "common-backend", a: { remote: "origin", url: mono.bare }, b: { remote: "backend", url: backend.bare }, mappings: [{ a: "common",  b: "src/common" }] },
    ],
    shadowBranchPrefix: "shadow",
  });
  setBranchFiltersForTesting(new Map([
    ["origin",  [compileIgnorePattern("**")]],
    ["backend", [compileIgnorePattern("**")]],
  ]));

  let r = await runSync({ from: "b" }); if (r.exitCode !== 0) { console.error(r.stderr); throw new Error("E1 bootstrap b"); }
  r = await runSync({ from: "a" }); if (r.exitCode !== 0) { console.error(r.stderr); throw new Error("E1 bootstrap a"); }

  // The ignore-only commit: changes ONLY a path under src/common/
  // which the "backend" pair's autoIgnore covers.
  const bcm5 = commitFiles(backend, { "src/common/util.ts": "util v2 (common-only edit)\n" }, "Bcm5: common-only edit");
  git("push origin main", backend.working);
  console.log(`  Bcm5 SHA: ${bcm5.slice(0, 12)}`);

  r = await runSync({ from: "b" });
  if (r.exitCode !== 0) { console.error(r.stdout); console.error(r.stderr); throw new Error("E1 --from b halted"); }

  git("fetch origin", mono.working);
  // (1) "backend" pair must drop Bcm5 — its filter eats the only changed path.
  checkTrailerAbsent({ bare: mono.bare }, "refs/heads/shadow/backend/main", bcm5, "E1.backend-pair");
  // (2) "common-backend" pair owns that subtree — its filter doesn't ignore it.
  checkTrailerPresent({ bare: mono.bare }, "refs/heads/shadow/common-backend/main", bcm5, "E1.common-pair");
  // (3) Idempotence: a second --from b emits no Replaying line for Bcm5.
  r = await runSync({ from: "b" });
  if (r.exitCode !== 0) { console.error(r.stdout); console.error(r.stderr); throw new Error("E1 idempotent --from b halted"); }
  assertIdempotent(r, bcm5, "E1.idempotent");

  setBranchFiltersForTesting(null);
}

async function runE2ShadowIgnore(tmpDir: string) {
  banner("E.2 — .shadowignore-only non-merge");
  const leaf = createRepo(tmpDir, "e2-leaf", { email: "lea@example.com",  name: "Lea"  });
  const mono = createRepo(tmpDir, "e2-mono", { email: "mira@example.com", name: "Mira" });
  git(`remote add leaf "${leaf.bare}"`, mono.working);

  // Seed both sides with a .shadowignore so subsequent edits to ignored
  // paths are dropped at the source walk by isLoadBearing.
  commitFiles(leaf, { "init.txt": "init\n", ".shadowignore": "*.local\n" }, "Lc0");
  git("push origin main", leaf.working);
  commitFiles(mono, { "README.md": "monorepo\n" }, "Mc0");
  git("push origin main", mono.working);

  applyTestOverrides({
    repoRoot: mono.working,
    pairs: [
      { name: "leaf", a: { remote: "origin", url: mono.bare }, b: { remote: "leaf", url: leaf.bare }, mappings: [{ a: "leaf", b: "" }] },
    ],
    shadowBranchPrefix: "shadow",
  });
  setBranchFiltersForTesting(new Map([
    ["origin", [compileIgnorePattern("**")]],
    ["leaf",   [compileIgnorePattern("**")]],
  ]));

  let r = await runSync({ from: "b" }); if (r.exitCode !== 0) { console.error(r.stderr); throw new Error("E2 bootstrap b"); }
  r = await runSync({ from: "a" }); if (r.exitCode !== 0) { console.error(r.stderr); throw new Error("E2 bootstrap a"); }

  // The ignore-only commit: edits ONLY a *.local file (covered by Lc0's
  // .shadowignore which is in effect at this commit's tree).
  const lc1 = commitFiles(leaf, { "config.local": "secret stuff\n" }, "Lc1: config.local-only edit");
  git("push origin main", leaf.working);
  console.log(`  Lc1 SHA: ${lc1.slice(0, 12)}`);

  r = await runSync({ from: "b" });
  if (r.exitCode !== 0) { console.error(r.stdout); console.error(r.stderr); throw new Error("E2 --from b halted"); }

  git("fetch origin", mono.working);
  // The pair filter drops Lc1 entirely.
  checkTrailerAbsent({ bare: mono.bare }, "refs/heads/shadow/leaf/main", lc1, "E2.leaf-pair");
  r = await runSync({ from: "b" });
  if (r.exitCode !== 0) { console.error(r.stdout); console.error(r.stderr); throw new Error("E2 idempotent --from b halted"); }
  assertIdempotent(r, lc1, "E2.idempotent");

  setBranchFiltersForTesting(null);
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-case-e-"));
  console.log(`[tmp] ${tmpDir}`);
  try {
    await runE1AutoIgnore(tmpDir);
    await runE2ShadowIgnore(tmpDir);
    console.log("\n  ✓ PASS — Case F commits dropped, idempotent, no trailer-only synthetics.");
  } finally {
    setBranchFiltersForTesting(null);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch(e => { console.error("\n[error]", e.message); process.exit(1); });
