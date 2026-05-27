/**
 * Multi-pair faithful reproduction of the C6 sequence from
 * shadow-tests/test-divergence.ts (runConcurrentMerges).
 *
 * Sequence matches the harness exactly:
 *   Round 1: concurrent commits — Bea on backend, Mira on mono.
 *   --from b + --from a.
 *   Round 2: BOTH sides merge shadow/<pair>/main concurrently.
 *   Round 3: --from a (engine creates parent-swap synthetic).
 *   Rounds 4-6: Bea linear commits + --from b + Mira mergeShadow each round.
 *   Final --from a (this is where harness's C6 halts in DROP).
 *
 * Multi-pair config: backend + frontend pairs. Backend is the active side
 * (gets the C6 pattern); frontend stays passive.
 *
 * Run: npx tsx local_tests/keep_drop_test/verify_mp_c6.ts
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-mp-c6-"));
  console.log(`[tmp] ${tmpDir}`);

  try {
    const backend  = createRepo(tmpDir, "backend",  { email: "bea@example.com",  name: "Bea"  });
    const frontend = createRepo(tmpDir, "frontend", { email: "fred@example.com", name: "Fred" });
    const mono     = createRepo(tmpDir, "mono",     { email: "mira@example.com", name: "Mira" });
    git(`remote add backend "${backend.bare}"`, mono.working);
    git(`remote add frontend "${frontend.bare}"`, mono.working);

    commitFiles(backend,  { "init.txt": "init\n" }, "Bc0");
    git("push origin main", backend.working);
    commitFiles(frontend, { "init.txt": "init\n" }, "Fc0");
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

    banner("Round 1: concurrent commits — bea1 on backend, mira1 on mono (backend slice)");
    commitFiles(backend, { "bea1.txt": "Bea round 1\n" }, "Bea: bea1");
    git("push origin main", backend.working);
    // Mira's commit goes UNDER backend/ on mono (mirrors the backend pair's subdir).
    commitFiles(mono, { "backend/mira1.txt": "Mira round 1\n" }, "Mira: mira1");
    git("push origin main", mono.working);

    r = await runSync({ from: "b" }); if (r.exitCode !== 0) throw new Error("r1 b");
    r = await runSync({ from: "a" }); if (r.exitCode !== 0) throw new Error("r1 a");

    banner("Round 2: BOTH sides merge shadow/backend/main concurrently");
    // Backend side: Bea merges shadow/backend/main into backend/main
    git("fetch origin", backend.working);
    git("checkout main", backend.working);
    git(`merge --no-ff origin/shadow/backend/main -m "Bea: merge shadow r1"`, backend.working);
    git("push origin main", backend.working);

    // Mono side: Mira merges (the MISTAKE / unintended step)
    git("fetch origin", mono.working);
    git("checkout main", mono.working);
    git(`merge --no-ff origin/shadow/backend/main -m "Mira: merge shadow r1 (mistake on mono)"`, mono.working);
    git("push origin main", mono.working);

    banner("Round 3: --from a");
    r = await runSync({ from: "a" });
    console.log(`  exit: ${r.exitCode}`);
    if (r.exitCode !== 0) {
      console.error(r.stdout); console.error(r.stderr);
      console.log("\n  ✘ HALT at Round 3 --from a"); return;
    }

    banner("Rounds 4-6: Bea linear commits, --from b, Mira mergeShadow each round");
    for (let i = 2; i <= 5; i++) {
      git("checkout main", backend.working);
      commitFiles(backend, { [`bea${i}.txt`]: `Bea ${i}\n` }, `Bea: bea${i}`);
      git("push origin main", backend.working);

      r = await runSync({ from: "b" });
      if (r.exitCode !== 0) { console.error(r.stderr); console.log(`✘ round ${i} b`); return; }

      git("fetch origin", mono.working);
      git("checkout main", mono.working);
      try {
        git(`merge --no-ff origin/shadow/backend/main -m "Mira mergeShadow r${i}"`, mono.working);
        git("push origin main", mono.working);
      } catch (e: any) {
        console.log(`  round ${i} mergeShadow: ${e.message.split("\\n")[0]}`);
      }
      console.log(`  ✓ round ${i} completed`);
    }

    banner("Final --from a (must succeed under the discriminator)");
    r = await runSync({ from: "a" });
    if (r.exitCode !== 0) {
      console.error("STDOUT:", r.stdout);
      console.error("STDERR:", r.stderr);
      console.log("\n  ✘ FAIL — engine halted; discriminator should have kept Mira_merge_n (TS-2 with same-pair echo).");
      process.exit(1);
    }
    console.log("  ✓ PASS — --from a succeeded; Case A merges replayed correctly.");

  } finally {
    setBranchFiltersForTesting(null);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch(e => { console.error("\n[error]", e.message); process.exit(1); });
