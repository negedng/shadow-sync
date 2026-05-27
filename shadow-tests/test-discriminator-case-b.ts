/**
 * Regression test for Case B (§3 in full_history_explained.html): confirms
 * the discriminator keeps a TS-1st merge whose 2nd parent lives on this
 * pair's own shadow chain and contributes a kept commit above the
 * merge-base with the 1st parent.
 *
 * Mirror image of test-discriminator-case-a.ts: same shape (mono operator
 * merges shadow/backend/main), but Mira resolves the conflict by KEEPING
 * MONO'S version (-X ours). The resulting Mira_merge is TREESAME under
 * backend/ to its 1st parent — and yet must be kept, because the 2nd
 * parent (B1'_mono on the shadow chain) is a kept exclusive ancestor that
 * anchors cross-repo state into the target chain.
 *
 * Why the ancestry rule keeps it: with parents (mira1, B1'_mono),
 * `git rev-list B1'_mono ^mira1` contains B1'_mono itself — a kept commit
 * (the bea1.txt copy under backend/). One kept non-first-parent-exclusive
 * commit is enough; the merge stays.
 *
 * Expected: --from a exits 0; backend.shadow/backend/main contains a
 * synthetic carrying Shadow-replayed-<mono-remote>: <Mira_merge_sha>.
 *
 * Run: npx tsx shadow-tests/test-discriminator-case-b.ts
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-ts1-"));
  console.log(`[tmp] ${tmpDir}`);

  try {
    const backend  = createRepo(tmpDir, "backend",  { email: "bea@example.com",  name: "Bea"  });
    const frontend = createRepo(tmpDir, "frontend", { email: "fred@example.com", name: "Fred" });
    const mono     = createRepo(tmpDir, "mono",     { email: "mira@example.com", name: "Mira" });
    git(`remote add backend "${backend.bare}"`, mono.working);
    git(`remote add frontend "${frontend.bare}"`, mono.working);

    // Empty bootstrap on backend/frontend so they have no init.txt — keeps
    // the merge tree clean enough that the merged result equals Mira's own
    // pre-merge backend slice (TREESAME-1).
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
    if (r.exitCode !== 0) { console.error(r.stderr); throw new Error("init b"); }
    r = await runSync({ from: "a" });
    if (r.exitCode !== 0) { console.error(r.stderr); throw new Error("init a"); }

    banner("Round 1: conflicting commits — bea1 on backend, mira1 on mono");
    // Both sides touch the SAME path with different content. After --from b
    // and --from a, the shadow refs will carry the opposite side's content.
    commitFiles(backend, { "shared.txt": "bea's version\n" }, "Bea: shared.txt = bea");
    git("push origin main", backend.working);
    commitFiles(mono, { "backend/shared.txt": "mira's version\n" }, "Mira: backend/shared.txt = mira");
    git("push origin main", mono.working);

    r = await runSync({ from: "b" }); if (r.exitCode !== 0) throw new Error("r1 b");
    r = await runSync({ from: "a" }); if (r.exitCode !== 0) throw new Error("r1 a");

    banner("Round 2: Mira merges shadow/backend/main on mono with -X ours");
    git("fetch origin", mono.working);
    git("checkout main", mono.working);
    git(`merge --no-ff -X ours origin/shadow/backend/main -m "Mira: merge shadow (took mono's)"`, mono.working);
    git("push origin main", mono.working);

    // Verify the resulting merge is actually TS-1 (took mono's tree).
    const mergeBackendTree = git("rev-parse HEAD:backend", mono.working);
    const mira1Sha = git("log -1 --format=%P HEAD", mono.working).split(" ")[0];
    const mira1BackendTree = git(`rev-parse ${mira1Sha}:backend`, mono.working);
    console.log(`  Merge backend/ tree: ${mergeBackendTree}`);
    console.log(`  1st parent (Mira1) backend/ tree: ${mira1BackendTree}`);
    console.log(`  TREESAME-1st: ${mergeBackendTree === mira1BackendTree ? "✓" : "✗"}`);
    if (mergeBackendTree !== mira1BackendTree) {
      console.log("  ✘ Setup error: merge was not TS-1; can't reproduce the variant.");
      return;
    }

    banner("Round 3: Mira adds a non-TREESAME backend commit");
    commitFiles(mono, { "backend/foo.txt": "Mira foo\n" }, "Mira: +backend/foo.txt");
    git("push origin main", mono.working);

    // Capture the Mira_merge SHA so we can verify its synthetic later.
    const miraMergeSha = git(`rev-parse HEAD~1`, mono.working);

    banner("Final --from a (expected to succeed under the discriminator)");
    r = await runSync({ from: "a" });
    console.log(`  exit: ${r.exitCode}`);
    if (r.exitCode !== 0) {
      console.error("STDOUT:", r.stdout);
      console.error("STDERR:", r.stderr);
      console.log("\n  ✘ FAIL — engine halted; discriminator should have kept Mira_merge.");
      process.exit(1);
    }

    // Assertion: backend.shadow/backend/main contains a synthetic with
    // Shadow-replayed-<mono-remote>: <Mira_merge_sha>.
    git("fetch origin", backend.working);
    const shadowLog = git(`log --format=%B refs/heads/shadow/backend/main`, backend.bare);
    const trailerRe = new RegExp(`^Shadow-replayed-[^:]+:\\s*${miraMergeSha}\\b`, "m");
    if (trailerRe.test(shadowLog)) {
      console.log(`  ✓ PASS — synthetic for Mira_merge (${miraMergeSha.slice(0,12)}) exists on backend.shadow/backend/main.`);
    } else {
      console.log(`  ✘ FAIL — no synthetic found for Mira_merge ${miraMergeSha.slice(0,12)} on shadow chain.`);
      console.log(`    Shadow chain log:`);
      console.log(shadowLog.split("\n").slice(0, 30).map(l => "      " + l).join("\n"));
      process.exit(1);
    }

  } finally {
    setBranchFiltersForTesting(null);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch(e => { console.error("\n[error]", e.message); process.exit(1); });
