// Minimal repro for Issue 2 — orphaned load-bearing commit via a parallel
// same-change diamond.
//
// Real trigger (realogic backend export): two commits "bk refresh token window"
// made the IDENTICAL change to common/rest-definition-bk-refresh-tokens.ts on
// parallel branches (local kl-core-dev `65350450` and remote `b849b4fb`), joined
// by a pull-merge `48e6135f`. Both sides are load-bearing → both replayed, but
// the joining merge is DROPPED. Result: the remote side's replay chains into the
// tip while the local side's replay (`e79836aa`) is ORPHANED — its only
// structural connector to the tip was the dropped merge. The commit's history
// (author, message) is lost from the backend repo even though the content
// survives via the parallel commit.
//
// ROOT CAUSE (validated): collectSourceCommits lists commits with
//   `git log --topo-order --full-history -- <sourceDirs>/`.
// A merge that is TREESAME to ALL its parents in the synced path is PRUNED even
// under --full-history (confirmed directly: such a merge never appears in the
// log). So the joining merge never enters the replay pipeline. Its descendants
// (e.g. L2, whose first parent is the pruned merge) then resolve that parent via
// resolveHaltAwareParents → findEchoAnchor, which returns the NEWEST mapped
// ancestor (`git log --topo-order`, first mapped) = the later parallel commit
// Xb' — never Xa'. Nothing references Xa' → it is orphaned. The fix belongs in
// collectSourceCommits (keep treesame merges that join two kept lines) and/or
// findEchoAnchor (don't collapse a dropped merge's first-parent line away).
//
// Topology reproduced here (single pair, confined common/ <-> src/common):
//   S0 ─ Xa(common=v1) ───────────────┐ (first parent of M)
//    └─ Xb(common=v1, same content) ──┤ (second parent of M)
//                                   M(merge, treesame) ─ L2(common=v2) ─ ... tip
// Xa is expected to ORPHAN on the buggy engine.
import { execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runSync } from "../shadow-sync";
import { applyTestOverrides, setBranchFiltersForTesting, compileIgnorePattern } from "../shadow-common";
import { assertEqual } from "./assert";

function git(cmd: string, cwd: string, dateISO?: string): string {
  const env = dateISO ? { ...process.env, GIT_AUTHOR_DATE: dateISO, GIT_COMMITTER_DATE: dateISO } : process.env;
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], env }).trim();
}
function cfg(workDir: string, id: { email: string; name: string }) {
  fs.appendFileSync(path.join(workDir, ".git", "config"),
    `[user]\n\temail = ${id.email}\n\tname = ${id.name}\n[core]\n\tautocrlf = false\n`);
}
interface Repo { bare: string; working: string }
function createRepo(tmp: string, name: string, id: { email: string; name: string }): Repo {
  const bare = path.join(tmp, `${name}-bare`).replace(/\\/g, "/");
  const working = path.join(tmp, `${name}-working`).replace(/\\/g, "/");
  fs.mkdirSync(bare);
  git("init --bare --initial-branch=main", bare);
  execSync(`git clone "${bare}" "${working}"`, { stdio: "pipe" });
  cfg(working, id);
  git("symbolic-ref HEAD refs/heads/main", working);
  return { bare, working };
}
function commit(repo: Repo, files: Record<string, string | null>, msg: string, dateISO?: string): string {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(repo.working, rel);
    if (content === null) { if (fs.existsSync(full)) fs.unlinkSync(full); }
    else { fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, content); }
  }
  git("add -A", repo.working);
  git(`commit -m "${msg}"`, repo.working, dateISO);
  return git("rev-parse HEAD", repo.working);
}
function merge(repo: Repo, ref: string, msg: string, dateISO?: string): string {
  git(`merge --no-ff ${ref} -m "${msg}"`, repo.working, dateISO);
  return git("rev-parse HEAD", repo.working);
}
function isAncestor(repo: Repo, anc: string, desc: string): boolean {
  try { execSync(`git merge-base --is-ancestor ${anc} ${desc}`, { cwd: repo.working, stdio: "pipe" }); return true; }
  catch { return false; }
}
/** Search the WHOLE object DB (reachable + dangling) for a replay carrying the
 *  given source trailer — needed because an orphaned replay isn't on any ref. */
function replayAnywhere(repo: Repo, trailerKey: string, sourceSha: string): string | null {
  // Absorbed SHAs now ride the single replay trailer as extra space-separated
  // values (`<key>: <direct> <absorbed...>`), so match the sha anywhere on a
  // line that carries this key — not just immediately after the colon.
  const line = new RegExp(`^${trailerKey}:(?:\\s+\\S+)*\\s+${sourceSha}(?:\\s|$)`, "m");
  const reachable = execSync("git rev-list --all", { cwd: repo.working, encoding: "utf8", maxBuffer: 50 * 1024 * 1024 }).split("\n").filter(Boolean);
  const dangling = execSync("git fsck --no-reflogs", { cwd: repo.working, encoding: "utf8", maxBuffer: 50 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] })
    .split("\n").filter(l => l.includes("dangling commit")).map(l => l.trim().split(/\s+/)[2]);
  for (const c of [...reachable, ...dangling]) {
    try {
      const b = execSync(`git log -1 --format=%B ${c}`, { cwd: repo.working, encoding: "utf8" });
      if (line.test(b)) return c;
    } catch { /* skip */ }
  }
  return null;
}

function run(): void {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-test-orphan-parallel-"));
  try {
    const ext = createRepo(tmp, "ext", { email: "ex@x.com", name: "Ex" });
    const mono = createRepo(tmp, "mono", { email: "mo@x.com", name: "Mo" });
    git(`remote add ext "${ext.bare}"`, mono.working);

    applyTestOverrides({
      repoRoot: mono.working,
      pairs: [{ name: "p", a: { remote: "origin", url: mono.bare, label: "a-p" }, b: { remote: "ext", url: ext.bare, label: "b-p" }, mappings: [{ a: "common", b: "src/common" }] }],
      shadowBranchPrefix: "shadow",
    });
    setBranchFiltersForTesting(new Map<string, RegExp[]>([
      ["origin", ["main"].map(compileIgnorePattern)],
      ["ext", ["main"].map(compileIgnorePattern)],
    ]));

    const D = (n: number) => `2021-03-${String(n).padStart(2, "0")}T00:00:00`;

    commit(ext, { "src/common/f.ts": "v0\n" }, "ext init", D(1));
    git("push origin main", ext.working);
    const S0 = commit(mono, { "common/f.ts": "v0\n", "app/k.ts": "0\n" }, "S0 seed", D(2));
    git("push origin main", mono.working);

    // bootstrap --from a maps S0 onto ext shadow.
    assertEqual(runSync({ from: "a" }).exitCode, 0, "bootstrap --from a failed");
    git("fetch ext", mono.working);

    // branch A: Xa changes the common file (load-bearing). This is the side we
    // expect to ORPHAN (mirrors local 65350450).
    git("checkout -b A", mono.working);
    const Xa = commit(mono, { "common/f.ts": "v1\n" }, "Xa: bk refresh token window (local)", D(3));

    // branch B off S0: Xb makes the IDENTICAL change, committed later (mirrors
    // remote b849b4fb). This is the side we expect to CHAIN.
    git("checkout -b B", mono.working);
    git(`reset --hard ${S0}`, mono.working);
    const Xb = commit(mono, { "common/f.ts": "v1\n" }, "Xb: bk refresh token window (remote)", D(4));

    // merge B into A: pull-merge. First parent Xa, second Xb. Both have common=v1
    // so the merge tree is TREESAME to the first parent.
    git("checkout A", mono.working);
    const M = merge(mono, "B", "M: Merge branch 'B' (pull) into A", D(5));

    // load-bearing commits ABOVE the merge (mirrors db92f112 / ddd5b5f7 being
    // mapped on the path between the merge and the integration point).
    const L2 = commit(mono, { "common/f.ts": "v2\n" }, "L2: another common bump", D(6));
    const L3 = commit(mono, { "common/f.ts": "v3\n" }, "L3: table escape fix", D(7));

    // integrate A into trunk (A joins as the second parent of the top merge).
    git("checkout main", mono.working);
    const MT = merge(mono, "A", "MT: integrate A into core-dev", D(8));
    git("push origin main", mono.working);
    console.log(`S0=${S0.slice(0,8)} Xa=${Xa.slice(0,8)} Xb=${Xb.slice(0,8)} M=${M.slice(0,8)} L2=${L2.slice(0,8)} L3=${L3.slice(0,8)} MT=${MT.slice(0,8)}`);

    assertEqual(runSync({ from: "a" }).exitCode, 0, "sync --from a failed");
    git("fetch ext", mono.working);

    const tip = git("rev-parse ext/a-p/main", mono.working);
    const XaRep = replayAnywhere(mono, "a-p-to-b-p", Xa);
    const XbRep = replayAnywhere(mono, "a-p-to-b-p", Xb);
    console.log(`tip=${tip.slice(0,8)} Xa.replay=${XaRep?.slice(0,8) ?? "—"} Xb.replay=${XbRep?.slice(0,8) ?? "—"}`);
    console.log("--- shadow tip history ---");
    console.log(git("log ext/a-p/main --format=%h_%s --max-count=25", mono.working));

    const XaReach = XaRep ? isAncestor(mono, XaRep, tip) : false;
    const XbReach = XbRep ? isAncestor(mono, XbRep, tip) : false;
    console.log(`Xa.replay reachable from tip: ${XaReach}; Xb.replay reachable: ${XbReach}`);

    if (XaRep && !XaReach)
      throw new Error(`REPRO: Xa's replay ${XaRep.slice(0,8)} is ORPHANED — parallel same-change merge dropped, stranding one side.`);
    if (!XaRep)
      throw new Error("Xa was not replayed at all (different failure mode than expected).");

    console.log("PASS — both parallel same-change commits reach the tip (no orphan).");
  } finally {
    setBranchFiltersForTesting(new Map());
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

run();
