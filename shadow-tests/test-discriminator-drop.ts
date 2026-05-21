/**
 * Asserts that the §5 discriminator drops TREESAME merges whose non-first
 * parents carry NO Shadow-replayed-* trailer, so they don't produce vacuous
 * synthetics on the shadow chain.
 *
 * Note on rev-list: `--full-history` already drops merges TREESAME to
 * ALL parents (no "interesting" parent under the path filter). The cases
 * the discriminator removes ON TOP of --full-history are merges that are
 * TREESAME to SOME but not all parents AND lack a shadow trailer on any
 * non-first parent. The simplest such shape is a `-s ours` merge of a
 * feature branch that touched the path's slice: 1st parent wins the slice
 * (TS-1), 2nd parent has different content (non-TS-2), no trailer anywhere.
 *
 * Scenario:
 *   Bootstrap → Round 1 → --from b + --from a.
 *   Capture pre-SHA of backend.shadow/backend/main, the set of merge SHAs
 *   on mono.main BEFORE the operator merges.
 *
 *   Case "ours": mono creates `stale-feature` off main, adds +backend/stale.txt
 *     (modifies backend slice), switches back to main, runs
 *     `git merge --no-ff -s ours stale-feature` — takes main's backend slice.
 *     Result: TS-1 merge whose 2nd parent has its own backend content but no
 *     shadow trailer.
 *
 *   Run --from a.
 *
 * Assertion: NO commit on backend.shadow/backend/main carries
 * `Shadow-replayed-<monorepo>: <merge_sha>` for the -s ours merge. The
 * linear stale-feature commit (+backend/stale.txt) IS expected to be replayed
 * since it's non-TS; we just don't want the vacuous merge synthetic.
 *
 * Against current --full-history-only code: this test FAILS (the merge IS
 * replayed; trailer for it appears).
 * Against the §5 discriminator: this test PASSES.
 *
 * Run: npx tsx local_tests/keep_drop_test/verify_no_vacuous_commits.ts
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
        { name: "backend", a: { remote: "origin", url: mono.bare, dir: "backend" }, b: { remote: "backend", url: backend.bare, dir: "" } },
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
    const preSHA = git("rev-parse refs/heads/shadow/backend/main", backend.bare);
    const preCount = parseInt(git("rev-list --count refs/heads/shadow/backend/main", backend.bare), 10);
    console.log(`  Pre-merge shadow tip: ${preSHA.slice(0,12)} (commit count: ${preCount})`);

    banner("Case C-variant: TS-1, non-TS-2, no shadow trailer (-s ours merge)");
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

    banner("Case D: TS-both, no shadow trailer (frontend-only stale branch)");
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

    // Assertion: NEITHER merge appears as a Shadow-replayed-<monorepo>: trailer
    // on the backend shadow chain.
    const shadowLog = git(`log --format=%B refs/heads/shadow/backend/main`, backend.bare);
    const shadowCount = parseInt(git("rev-list --count refs/heads/shadow/backend/main", backend.bare), 10);
    console.log(`  Shadow chain commit count: ${shadowCount} (was ${preCount})`);

    const checkMerge = (label: string, sha: string): boolean => {
      const re = new RegExp(`^Shadow-replayed-[^:]+:\\s*${sha}\\b`, "m");
      const found = re.test(shadowLog);
      console.log(`  ${label} (${sha.slice(0,12)}) appears on shadow chain: ${found ? "YES (vacuous)" : "no"}`);
      return !found;
    };
    const okC = checkMerge("Case C-variant", mergeC);
    const okD = checkMerge("Case D       ", mergeD);
    if (okC && okD) {
      console.log("\n  ✓ PASS — no vacuous synthetic created for either dropped merge.");
    } else {
      console.log("\n  ✘ FAIL — vacuous synthetic(s) created. Discriminator should drop both.");
      process.exit(1);
    }
  } finally {
    setBranchFiltersForTesting(null);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch(e => { console.error("\n[error]", e.message); process.exit(1); });
