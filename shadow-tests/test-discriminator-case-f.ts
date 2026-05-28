/**
 * Asserts that the unified discriminator DROPS Case F commits — non-merges
 * whose source-side diff is entirely inside the .shadowignore filter.
 *
 * Single-pair, source has .shadowignore="*.local". Source commits ONLY a
 * *.local file. Effective tree (with *.local stripped) equals the parent's
 * → drop.
 *
 * The implemented discriminator computes effective trees via
 * `effectiveSourceTree` (read-tree → rm --cached ignored paths → write-tree)
 * and finds the commit's effective tree equals its parent's. Non-merge, so the
 * trailer carve-out doesn't apply: dropped at the source walk.
 *
 * Expected:
 *   1. NO `Shadow-replayed-<source-remote>: <sha>` trailer for the ignore-only
 *      commit on the pair's shadow chain.
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

async function runShadowIgnoreDrop(tmpDir: string) {
  banner(".shadowignore-only non-merge");
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

  let r = await runSync({ from: "b" }); if (r.exitCode !== 0) { console.error(r.stderr); throw new Error("bootstrap b"); }
  r = await runSync({ from: "a" }); if (r.exitCode !== 0) { console.error(r.stderr); throw new Error("bootstrap a"); }

  // The ignore-only commit: edits ONLY a *.local file (covered by Lc0's
  // .shadowignore which is in effect at this commit's tree).
  const lc1 = commitFiles(leaf, { "config.local": "secret stuff\n" }, "Lc1: config.local-only edit");
  git("push origin main", leaf.working);
  console.log(`  Lc1 SHA: ${lc1.slice(0, 12)}`);

  r = await runSync({ from: "b" });
  if (r.exitCode !== 0) { console.error(r.stdout); console.error(r.stderr); throw new Error("--from b halted"); }

  git("fetch origin", mono.working);
  // The pair filter drops Lc1 entirely.
  checkTrailerAbsent({ bare: mono.bare }, "refs/heads/shadow/leaf/main", lc1, "leaf-pair");
  r = await runSync({ from: "b" });
  if (r.exitCode !== 0) { console.error(r.stdout); console.error(r.stderr); throw new Error("idempotent --from b halted"); }
  assertIdempotent(r, lc1, "idempotent");

  setBranchFiltersForTesting(null);
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-case-f-"));
  console.log(`[tmp] ${tmpDir}`);
  try {
    await runShadowIgnoreDrop(tmpDir);
    console.log("\n  ✓ PASS — Case F commit dropped, idempotent, no trailer-only synthetics.");
  } finally {
    setBranchFiltersForTesting(null);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch(e => { console.error("\n[error]", e.message); process.exit(1); });
