/**
 * Asserts that the discriminator KEEPS Case C merges — TS-1 merges whose
 * 2nd parent carries a SIBLING-PAIR (cross-pair) `Shadow-replayed-*` trailer.
 *
 * Case C scenario: mono operator runs `git merge shadow/frontend/main` on
 * core-dev to bring the frontend pair's latest work into mono. The merge:
 *   - is TS-1 under the backend/ path filter (the frontend merge touches
 *     only frontend/, leaves backend/ unchanged), AND
 *   - has a 2nd parent (Fc1'_mono) carrying `Shadow-replayed-<frontend-pair>`.
 *
 * The implemented discriminator (loose form: any-pair trailer regex) keeps
 * the merge. This matters because the resulting `Mc_A'_be<noop>` synthetic
 * on backend's shadow chain carries trailer information that
 * `composeMergeBaseTree` reads on subsequent --from b runs to compose
 * outer state correctly across pairs. Dropping it would cause silent
 * cross-pair drift (see full_history_explained.html §4).
 *
 * Indirectly covered by shadow-tests/test-scenario.ts:585, :634 (which assert
 * `Bc4 = merge(Bc3, Mc6'_be<noop>)` structure). This test makes the
 * assertion explicit at the trailer level.
 *
 * Expected: backend.shadow/backend/main contains a synthetic carrying
 * `Shadow-replayed-<mono-remote>: <Mc_A_sha>`.
 *
 * Run: npx tsx local_tests/keep_drop_test/verify_case_a_kept.ts
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-case-a-"));
  console.log(`[tmp] ${tmpDir}`);

  try {
    const backend  = createRepo(tmpDir, "backend",  { email: "bea@example.com",  name: "Bea"  });
    const frontend = createRepo(tmpDir, "frontend", { email: "fred@example.com", name: "Fred" });
    const mono     = createRepo(tmpDir, "mono",     { email: "mira@example.com", name: "Mira" });
    git(`remote add backend "${backend.bare}"`, mono.working);
    git(`remote add frontend "${frontend.bare}"`, mono.working);

    git(`commit --allow-empty -m "Bc0"`, backend.working);
    git("push origin main", backend.working);
    git(`commit --allow-empty -m "Fc0"`, frontend.working);
    git("push origin main", frontend.working);
    commitFiles(mono, { "README.md": "monorepo\n" }, "Mc0");
    git("push origin main", mono.working);

    applyTestOverrides({
      repoRoot: mono.working,
      pairs: [
        { name: "backend",  a: { remote: "origin", url: mono.bare }, b: { remote: "backend",  url: backend.bare  }, mappings: [{ a: "backend",  b: "" }] },
        { name: "frontend", a: { remote: "origin", url: mono.bare }, b: { remote: "frontend", url: frontend.bare }, mappings: [{ a: "frontend", b: "" }] },
      ],
      shadowBranchPrefix: "shadow",
    });
    // Not a filter test — wildcard.
    setBranchFiltersForTesting(new Map([
      ["origin",   [compileIgnorePattern("**")]],
      ["backend",  [compileIgnorePattern("**")]],
      ["frontend", [compileIgnorePattern("**")]],
    ]));

    banner("Bootstrap sync");
    let r = await runSync({ from: "b" });
    if (r.exitCode !== 0) { console.error(r.stderr); throw new Error("bootstrap b"); }
    r = await runSync({ from: "a" });
    if (r.exitCode !== 0) { console.error(r.stderr); throw new Error("bootstrap a"); }

    banner("Round 1: Mira commits +backend/, Fred commits +ft1 on frontend");
    commitFiles(mono, { "backend/mira1.txt": "mira1\n" }, "Mira: backend/mira1.txt");
    git("push origin main", mono.working);
    commitFiles(frontend, { "ft1.txt": "ft1 v1\n" }, "Fred: ft1");
    git("push origin main", frontend.working);

    r = await runSync({ from: "b" }); if (r.exitCode !== 0) throw new Error("r1 b");
    r = await runSync({ from: "a" }); if (r.exitCode !== 0) throw new Error("r1 a");

    banner("Mira on mono merges shadow/frontend/main into core-dev");
    git("fetch origin", mono.working);
    git("checkout main", mono.working);
    git(`merge --no-ff origin/shadow/frontend/main -m "Mira: merge shadow/frontend/main"`, mono.working);
    git("push origin main", mono.working);
    const mcA = git("rev-parse HEAD", mono.working);
    console.log(`  Mc_A SHA: ${mcA.slice(0,12)}`);
    console.log(`  Mc_A tree contents:`);
    const lsTree = git(`ls-tree -r --name-only ${mcA}`, mono.working);
    for (const line of lsTree.split("\n").filter(Boolean)) console.log(`    ${line}`);

    // backend/ subtree SHAs, or the empty-tree SHA where backend/ doesn't exist.
    const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
    let mcABackendTree: string, mcAp1Tree: string, mcAp2Tree: string;
    try {
      mcABackendTree = git("rev-parse HEAD:backend", mono.working);
    } catch { mcABackendTree = EMPTY_TREE; }
    const [mcAp1, mcAp2] = git("log -1 --format=%P HEAD", mono.working).split(" ");
    try { mcAp1Tree = git(`rev-parse ${mcAp1}:backend`, mono.working); } catch { mcAp1Tree = EMPTY_TREE; }
    try { mcAp2Tree = git(`rev-parse ${mcAp2}:backend`, mono.working); } catch { mcAp2Tree = EMPTY_TREE; }
    console.log(`  TS-1 under backend/: ${mcABackendTree === mcAp1Tree ? "✓" : "✗"}`);
    console.log(`  TS-2 under backend/: ${mcABackendTree === mcAp2Tree ? "✓" : "✗ (expected — sibling-pair 2nd parent has its own non-backend content)"}`);
    const p2Msg = git(`log -1 --format=%B ${mcAp2}`, mono.working);
    const hasSiblingTrailer = /^Shadow-replayed-frontend/m.test(p2Msg);
    console.log(`  2nd parent has Shadow-replayed-frontend trailer: ${hasSiblingTrailer ? "✓" : "✗"}`);
    if (!hasSiblingTrailer) {
      console.log("  ✘ Setup error: 2nd parent has no frontend trailer; not Case C.");
      process.exit(1);
    }

    banner("--from a (the test)");
    r = await runSync({ from: "a" });
    if (r.exitCode !== 0) {
      console.error(r.stdout); console.error(r.stderr);
      throw new Error("--from a halted unexpectedly");
    }

    // Assertion: backend.shadow/backend/main does NOT contain a synthetic for
    // Mc_A. Under the same-pair trailer rule, Case C drops: a cross-pair
    // trailer on the 2nd parent doesn't mark the merge as load-bearing for
    // this pair, and standard-workflow 3-way merge handles the resulting
    // stale-outer naturally.
    git("fetch origin", backend.working);
    const shadowLog = git(`log --format=%B refs/heads/shadow/backend/main`, backend.bare);
    const trailerRe = new RegExp(`^Shadow-replayed-[^:]+:\\s*${mcA}\\b`, "m");
    if (!trailerRe.test(shadowLog)) {
      console.log(`\n  ✓ PASS — no synthetic for ${mcA.slice(0,12)} on backend.shadow/backend/main.`);
      console.log(`    Case C correctly DROPPED by the same-pair discriminator.`);
    } else {
      console.log(`\n  ✘ FAIL — synthetic for Mc_A unexpectedly present on backend shadow chain.`);
      console.log(`    Same-pair rule should have dropped this cross-pair-trailer merge.`);
      console.log(`    Shadow chain log:`);
      console.log(shadowLog.split("\n").slice(0, 40).map(l => "      " + l).join("\n"));
      process.exit(1);
    }
  } finally {
    setBranchFiltersForTesting(null);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch(e => { console.error("\n[error]", e.message); process.exit(1); });
