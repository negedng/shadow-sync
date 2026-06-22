/**
 * Regression: a dropped commit must not mask a halt on a merge's escaping
 * lineage and drop the halted ancestor's content.
 *
 * Topology (confined pull, team root -> origin frontend/):
 *   branch-a, branch-b: both edit shared.txt + add their own file. Their shadow
 *     tips get a CONFLICTING outer.txt injected, so a merge of them outer-
 *     diverges and halts.
 *   branchH:  branch-a -> H = merge(branch-a, branch-b)  [HALTS: outer divergence]
 *                       -> D = empty commit             [treesame -> DROPPED]
 *                       -> C = merge(D, branch-m)       [escapes the gate via branch-m]
 *
 * Before the fix C anchored its D-side to branch-a (below H), so H's merge
 * content (feat-b.txt, shared=RESOLVED) was silently dropped while C replayed
 * as a 2-parent merge — a corrupt tree pushed to the shadow. The fix makes
 * dropped commits transparent to halts in both parent resolution and
 * absorption, so C either replays faithfully or halts; it never lands a merge
 * carrying branch-m's content while missing H's.
 *
 * Invariant asserted: no commit on the branchH shadow may contain
 * frontend/feat-m.txt while missing frontend/feat-b.txt.
 */
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { createTestEnv, runCiSync, setTestBranchAllowlist } from "./harness";
import { assertEqual, assertIncludes } from "./assert";

function git(cmd: string, cwd: string, opts?: { env?: NodeJS.ProcessEnv; input?: string }): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], env: opts?.env, input: opts?.input }).trim();
}

// Add root-relative files to a shadow commit's tree, preserving its inner
// subtree + replay trailer; returns the rewritten commit SHA.
function injectOuterFiles(local: string, tmpDir: string, shadowSha: string, files: Record<string, string>): string {
  const idx = path.join(tmpDir, `idx-${shadowSha.slice(0, 7)}`);
  const idxEnv = { ...process.env, GIT_INDEX_FILE: idx };
  git(`read-tree "${shadowSha}^{tree}"`, local, { env: idxEnv });
  for (const [p, body] of Object.entries(files)) {
    const blob = git("hash-object -w --stdin", local, { input: body });
    git(`update-index --add --cacheinfo 100644,${blob},${p}`, local, { env: idxEnv });
  }
  const newTree = git("write-tree", local, { env: idxEnv });
  fs.rmSync(idx, { force: true });
  const parents = git(`log -1 --format=%P ${shadowSha}`, local).split(/\s+/).filter(Boolean);
  const msgFile = path.join(tmpDir, `msg-${shadowSha.slice(0, 7)}`);
  fs.writeFileSync(msgFile, git(`log -1 --format=%B ${shadowSha}`, local) + "\n");
  const newSha = git(`commit-tree ${newTree} ${parents.map(p => `-p ${p}`).join(" ")} -F "${msgFile}"`, local);
  fs.rmSync(msgFile, { force: true });
  return newSha;
}

// True iff the tree at `ref` contains `repoPath`.
function treeHas(local: string, ref: string, repoPath: string): boolean {
  try { git(`show ${ref}:${repoPath}`, local); return true; } catch { return false; }
}

export default function run(): void {
  setTestBranchAllowlist({ origin: ["**"], team: ["**"] });
  const env = createTestEnv("halt-dropped-mask");
  const local = env.localRepo, team = env.remoteWorking;
  const shadowPrefix = `b-${env.subdir}`;
  try {
    fs.writeFileSync(path.join(team, "shared.txt"), "base\n");
    git("add shared.txt", team); git('commit -m "Base"', team); git("push origin main", team);

    git("checkout -b branch-a", team);
    fs.writeFileSync(path.join(team, "shared.txt"), "A\n");
    fs.writeFileSync(path.join(team, "feat-a.txt"), "a\n");
    git("add -A", team); git('commit -m "feat A"', team); git("push origin branch-a", team);

    git("checkout main", team); git("checkout -b branch-b", team);
    fs.writeFileSync(path.join(team, "shared.txt"), "B\n");
    fs.writeFileSync(path.join(team, "feat-b.txt"), "b\n");
    git("add -A", team); git('commit -m "feat B"', team); git("push origin branch-b", team);

    git("checkout main", team); git("checkout -b branch-m", team);
    fs.writeFileSync(path.join(team, "feat-m.txt"), "m\n");
    git("add -A", team); git('commit -m "feat M"', team); git("push origin branch-m", team);

    assertEqual(runCiSync(env).status, 0, "[dropped-mask] initial fan-out sync");

    // Conflicting outer on each branch tip -> H (merge of a,b) outer-diverges.
    git("fetch origin", local);
    const newA = injectOuterFiles(local, env.tmpDir, git(`rev-parse origin/${shadowPrefix}/branch-a`, local), { "outer.txt": "from-A\n" });
    const newB = injectOuterFiles(local, env.tmpDir, git(`rev-parse origin/${shadowPrefix}/branch-b`, local), { "outer.txt": "from-B\n" });
    git(`push origin ${newA}:refs/heads/${shadowPrefix}/branch-a --force`, local);
    git(`push origin ${newB}:refs/heads/${shadowPrefix}/branch-b --force`, local);

    // branchH: H = merge(a,b) -> D = empty (dropped) -> C = merge(D, branch-m).
    git("checkout -b branchH branch-a", team);
    try { git("merge --no-ff --no-commit branch-b", team); } catch { /* inner conflict expected */ }
    fs.writeFileSync(path.join(team, "shared.txt"), "RESOLVED\n");
    git("add shared.txt", team);
    git('commit -m "H: merge branch-b"', team);
    const H = git("rev-parse HEAD", team);
    git('commit --allow-empty -m "D: empty (treesame -> dropped)"', team);
    git('merge --no-ff branch-m -m "C: merge branch-m"', team);
    git("push origin branchH", team);

    // H is a genuine outer-divergence halt -> the sync halts and surfaces it.
    const r = runCiSync(env);
    assertEqual(r.status, 1, "[dropped-mask] sync halts on the unresolvable outer divergence");
    assertIncludes(r.stdout + r.stderr, H.slice(0, 7), "[dropped-mask] halt names the source merge H");
    assertIncludes(r.stdout + r.stderr, "outer-state divergence", "[dropped-mask] halt cause is outer divergence");

    // Core invariant: no commit on the branchH shadow carries branch-m's content
    // (feat-m) while missing H's second-parent content (feat-b). The pre-fix bug
    // produced exactly such a commit (C replayed with feat-m, no feat-b).
    git(`fetch origin ${shadowPrefix}/branchH`, local);
    const ref = `origin/${shadowPrefix}/branchH`;
    let shas: string[] = [];
    try { shas = git(`log --format=%H ${ref}`, local).split("\n").filter(Boolean); } catch { shas = []; }
    for (const sha of shas) {
      const hasM = treeHas(local, sha, `${env.subdir}/feat-m.txt`);
      const hasB = treeHas(local, sha, `${env.subdir}/feat-b.txt`);
      assertEqual(hasM && !hasB, false,
        `[dropped-mask] commit ${sha.slice(0, 7)} must not carry feat-m while dropping H's feat-b`);
    }
  } finally {
    env.cleanup();
    setTestBranchAllowlist();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-halt-dropped-mask");
}
