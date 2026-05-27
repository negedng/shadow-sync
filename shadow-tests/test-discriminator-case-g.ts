/**
 * Asserts that the unified discriminator DROPS Case G commits — merges whose
 * source-side diff under sourceDir/ is non-TREESAME to every parent (the old
 * `isLoadBearingMerge` would have kept them) but becomes effective-TREESAME
 * to some parent once the ignore filter strips every changed path, AND no
 * non-first parent carries a `Shadow-replayed-*` trailer.
 *
 * Case G scenario: pair "backend" (source dir="") with sibling pair
 * "common-backend" overlapping at "src/common/". The "backend" pair
 * gets autoIgnorePatterns = ["src/common", "src/common/**"].
 * On backend, build a merge whose two parents introduce DIFFERENT
 * common/-subtree files (so the merge's raw tree differs from both parents
 * — non-TS-raw to either), but every changed path is inside the autoIgnore
 * set. Effective trees collapse to the same content on all three (merge +
 * both parents). The 2nd parent has no `Shadow-replayed-*` trailer (regular
 * feature branch), so the merge trailer carve-out doesn't apply: dropped.
 *
 * Expected:
 *   1. NO `Shadow-replayed-<backend-remote>: <merge_sha>` trailer on
 *      monorepo's shadow/backend/main (the "backend" pair filtered the
 *      merge — would have been a Case G trailer-only synthetic).
 *   2. The sibling "common-backend" pair DOES carry the trailer (no
 *      autoIgnore there; the merge is a real cross-branch composition under
 *      "src/common/").
 *   3. Idempotent: a second --from b emits no `Replaying ...` log line for
 *      the merge SHA.
 *
 * Counterexample (what dropping prevents):
 *   Under the old `isLoadBearingMerge` (raw-tree comparison only), the merge
 *   was non-TS-raw to every parent, so the post-filter kept it. The "backend"
 *   pair's buildReplayedTree would have stripped every changed path via
 *   autoIgnore, producing a target tree equal to the merge's first mapped
 *   parent's tree; `commit-tree` would then emit a trailer-only merge
 *   synthetic on shadow/backend/main. The shadow chain would accumulate a
 *   noop merge marker per cross-pair operator merge — exactly the clutter
 *   the discriminator is supposed to prevent.
 *
 * Run: npx tsx shadow-tests/test-discriminator-case-g.ts
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-case-f-"));
  console.log(`[tmp] ${tmpDir}`);

  try {
    const backend = createRepo(tmpDir, "backend", { email: "bea@example.com",  name: "Bea"  });
    const mono    = createRepo(tmpDir, "mono",    { email: "mira@example.com", name: "Mira" });
    git(`remote add backend "${backend.bare}"`, mono.working);

    commitFiles(backend, { "init.txt": "init\n", "src/common/util.ts": "util v1\n" }, "Bc0");
    git("push origin main", backend.working);
    commitFiles(mono, { "README.md": "monorepo\n" }, "Mc0");
    git("push origin main", mono.working);

    applyTestOverrides({
      repoRoot: mono.working,
      pairs: [
        { name: "backend",        a: { remote: "origin", url: mono.bare }, b: { remote: "backend", url: backend.bare }, mappings: [{ a: "backend", b: "" }] },
        { name: "common-backend", a: { remote: "origin", url: mono.bare }, b: { remote: "backend", url: backend.bare }, mappings: [{ a: "common",  b: "src/common" }] },
      ],
      shadowBranchPrefix: "shadow",
    });
    setBranchFiltersForTesting(new Map([
      ["origin",  [compileIgnorePattern("**")]],
      ["backend", [compileIgnorePattern("**")]],
    ]));

    banner("Bootstrap sync");
    let r = await runSync({ from: "b" }); if (r.exitCode !== 0) { console.error(r.stderr); throw new Error("bootstrap b"); }
    r = await runSync({ from: "a" }); if (r.exitCode !== 0) { console.error(r.stderr); throw new Error("bootstrap a"); }

    banner("Construct Case-F merge on backend: feat + main both add common/ files");
    // feat branch adds common/x.ts only.
    git("checkout -b feat", backend.working);
    commitFiles(backend, { "src/common/x.ts": "x branch content\n" }, "feat: add common/x");
    // main adds common/y.ts only.
    git("checkout main", backend.working);
    commitFiles(backend, { "src/common/y.ts": "y main content\n" }, "main: add common/y");
    // Merge feat back. The merge tree has init.txt + util.ts + x.ts + y.ts.
    // Its raw tree differs from both parents (non-TS-raw to either), but every
    // diff path lives inside src/common/* — fully inside the
    // "backend" pair's autoIgnore.
    git(`merge --no-ff feat -m "Merge feat (Case G: all changes under autoIgnore)"`, backend.working);
    const mergeF = git("rev-parse HEAD", backend.working);
    git("push origin main", backend.working);
    console.log(`  Merge SHA: ${mergeF.slice(0, 12)}`);

    // Sanity-check the shape — non-TS-raw to both parents, no shadow trailer on 2nd parent.
    const mergeFullTree = git("log -1 --format=%T HEAD", backend.working);
    const [p1, p2] = git("log -1 --format=%P HEAD", backend.working).split(" ");
    const p1Tree = git(`log -1 --format=%T ${p1}`, backend.working);
    const p2Tree = git(`log -1 --format=%T ${p2}`, backend.working);
    console.log(`  Raw TS-1: ${mergeFullTree === p1Tree ? "✓ (unexpected)" : "✗ (expected — non-TS-raw)"}`);
    console.log(`  Raw TS-2: ${mergeFullTree === p2Tree ? "✓ (unexpected)" : "✗ (expected — non-TS-raw)"}`);
    const p2Msg = git(`log -1 --format=%B ${p2}`, backend.working);
    const hasShadowTrailer = /^Shadow-replayed-/m.test(p2Msg);
    console.log(`  2nd parent has Shadow-replayed-* trailer: ${hasShadowTrailer ? "✓ (unexpected)" : "✗ (expected — no trailer carve-out)"}`);
    if (hasShadowTrailer) { console.error("setup error: 2nd parent unexpectedly has trailer"); process.exit(1); }

    banner("--from b (the test)");
    r = await runSync({ from: "b" });
    if (r.exitCode !== 0) { console.error(r.stdout); console.error(r.stderr); throw new Error("--from b halted"); }

    git("fetch origin", mono.working);
    const backendShadowLog = git(`log --format=%B refs/heads/shadow/backend/main`, mono.bare);
    const commonShadowLog  = git(`log --format=%B refs/heads/shadow/common-backend/main`, mono.bare);
    const trailerRe = new RegExp(`^Shadow-replayed-[^:]+:\\s*${mergeF}\\b`, "m");

    if (trailerRe.test(backendShadowLog)) {
      console.log(`  ✘ FAIL — trailer for ${mergeF.slice(0, 12)} found on shadow/backend/main`);
      console.log(`    Case G merge should have been dropped (effective-TS + no trailer carve-out).`);
      process.exit(1);
    }
    console.log(`  ✓ trailer for ${mergeF.slice(0, 12)} ABSENT from shadow/backend/main (Case G drop confirmed)`);

    if (!trailerRe.test(commonShadowLog)) {
      console.log(`  ✘ FAIL — trailer for ${mergeF.slice(0, 12)} missing from shadow/common-backend/main`);
      console.log(`    The common-backend pair has no autoIgnore over common/ and should keep the merge.`);
      process.exit(1);
    }
    console.log(`  ✓ trailer for ${mergeF.slice(0, 12)} PRESENT on shadow/common-backend/main (drop is pair-scoped)`);

    banner("Idempotence: second --from b");
    r = await runSync({ from: "b" });
    if (r.exitCode !== 0) { console.error(r.stdout); console.error(r.stderr); throw new Error("idempotent --from b halted"); }
    const replayLines = r.stdout.split("\n").filter(l => /^\s*Replaying /.test(l) && l.includes(mergeF.slice(0, 7)));
    if (replayLines.length > 0) {
      console.log(`  ✘ FAIL — re-replay of ${mergeF.slice(0, 12)} on idempotent sync:`);
      replayLines.forEach(l => console.log(`      ${l}`));
      process.exit(1);
    }
    console.log(`  ✓ idempotent — no Replaying line for ${mergeF.slice(0, 12)}`);

    console.log("\n  ✓ PASS — Case G merge dropped on the autoIgnore-covered pair, kept on the owning pair, idempotent.");
  } finally {
    setBranchFiltersForTesting(null);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch(e => { console.error("\n[error]", e.message); process.exit(1); });
