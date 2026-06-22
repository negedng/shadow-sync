/**
 * Sequential echo-outer reconciliation (regression for the resolveEcho rewrite).
 *
 * When a source branch merges two echoes (each a replay from the target side)
 * across consecutive commits, the replay base's OUTER must be ADOPTED from a
 * real mapped parent — never synthesized so that the second echo silently
 * clobbers the first's outer files. Cases:
 *
 *   A. conflict   — echoes' outers diverge on a shared file → HALT (no loss):
 *                   the shadow tip stays at M1', which still carries E_P's outer.
 *   B. disjoint   — echoes add different outer files, no shared conflict →
 *                   SUCCESS via a clean outer-only union; both files on the tip.
 *   C. octopus    — both echoes merged in ONE commit with divergent outers →
 *                   HALT (outer-divergence).
 *
 * Full round-trip recovery from the halt is covered by test-halt-recovery-variants
 * (multi-echo-octopus-recovery rides the same absorption path).
 *
 * Direction: pull (from b). Target = a (mono), label a-frontend; the OUTER is
 * the mono content outside frontend/. Echo trailer key = a-frontend-to-b-frontend.
 */
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { createTestEnv, runCiSync, setTestBranchAllowlist, shadowBranchOf, TestEnv } from "./harness";
import { assertEqual, assertNotEqual } from "./assert";

const ECHO_TRAILER = "a-frontend-to-b-frontend";

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/** Read a root-level path from the shadow ref on origin. null if absent. */
function showShadow(env: TestEnv, relPath: string): string | null {
  git(`fetch origin ${shadowBranchOf(env)}`, env.localRepo);
  try {
    return execSync(`git show origin/${shadowBranchOf(env)}:${relPath}`,
      { cwd: env.localRepo, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).replace(/\r\n/g, "\n");
  } catch { return null; }
}

function writeMono(env: TestEnv, rel: string, content: string): void {
  const full = path.join(env.localRepo, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

/** Two divergent mono (target) commits the echoes point at. `outer` maps a root
 *  file → its content per line. Returns full SHAs. */
function makeEchoTargets(env: TestEnv, p: Record<string, string>, q: Record<string, string>): { t1: string; t2: string } {
  const repo = env.localRepo;
  const commit = (branch: string, files: Record<string, string>, msg: string): string => {
    git(`checkout -b ${branch} origin/main`, repo);
    writeMono(env, "frontend/app.ts", `${branch}-inner\n`);
    for (const [rel, content] of Object.entries(files)) writeMono(env, rel, content);
    git("add -A", repo);
    git(`commit -m "${msg}"`, repo);
    const sha = git("rev-parse HEAD", repo);
    git(`push origin ${branch}`, repo);
    return sha;
  };
  const t1 = commit("lineP", p, "T1: mono lineP");
  const t2 = commit("lineQ", q, "T2: mono lineQ");
  git("checkout main", repo);
  return { t1, t2 };
}

/** An echo on the ext (source/b) side: a branch off main whose tip carries the
 *  opposite-direction trailer pointing at mono commit `target`. */
function makeEcho(env: TestEnv, branch: string, file: string, target: string, label: string): string {
  const ext = env.remoteWorking;
  git("checkout main", ext);
  git(`checkout -b ${branch}`, ext);
  fs.writeFileSync(path.join(ext, file), `${label}\n`);
  git("add -A", ext);
  git(`commit -m "${label}: echo of ${target.slice(0, 7)}" -m "${ECHO_TRAILER}: ${target}"`, ext);
  git("checkout main", ext);
  return branch;
}

// ── A. conflict: sequential merges, divergent shared outer → HALT, no loss ──
function runConflict(): void {
  const env = createTestEnv("echo-seq-conflict", "frontend", "shadow", "");
  try {
    const { t1, t2 } = makeEchoTargets(env,
      { "shared.txt": "from-P\n", "only-P.txt": "P\n" },
      { "shared.txt": "from-Q\n", "only-Q.txt": "Q\n" });
    const ep = makeEcho(env, "ep", "p.ts", t1, "EP");
    const eq = makeEcho(env, "eq", "q.ts", t2, "EQ");
    git(`merge --no-ff ${ep} -m "M1: merge echo P"`, env.remoteWorking);
    git(`merge --no-ff ${eq} -m "M2: merge echo Q"`, env.remoteWorking);
    git("push origin main", env.remoteWorking);

    const r = runCiSync(env);
    assertNotEqual(r.status, 0, "[conflict] divergent shared outer must HALT, not silently merge");
    // Tip stays at M1' (E_P's outer) — the engine never lost or clobbered it.
    assertEqual(showShadow(env, "only-P.txt"), "P\n", "[conflict] only-P.txt preserved on shadow tip (no loss)");
    assertEqual(showShadow(env, "shared.txt"), "from-P\n", "[conflict] shared.txt NOT regressed to E_Q's value");
    assertEqual(showShadow(env, "only-Q.txt"), null, "[conflict] M2 not replayed past the halt");
  } finally {
    env.cleanup();
  }
}

// ── B. disjoint: sequential merges, disjoint outers → clean union, SUCCESS ──
function runDisjoint(): void {
  const env = createTestEnv("echo-seq-disjoint", "frontend", "shadow", "");
  try {
    const { t1, t2 } = makeEchoTargets(env, { "only-P.txt": "P\n" }, { "only-Q.txt": "Q\n" });
    const ep = makeEcho(env, "ep", "p.ts", t1, "EP");
    const eq = makeEcho(env, "eq", "q.ts", t2, "EQ");
    git(`merge --no-ff ${ep} -m "M1: merge echo P"`, env.remoteWorking);
    git(`merge --no-ff ${eq} -m "M2: merge echo Q"`, env.remoteWorking);
    git("push origin main", env.remoteWorking);

    const r = runCiSync(env);
    assertEqual(r.status, 0, `[disjoint] disjoint outers must auto-union, not halt: ${r.stderr}`);
    assertEqual(showShadow(env, "only-P.txt"), "P\n", "[disjoint] only-P.txt on shadow tip");
    assertEqual(showShadow(env, "only-Q.txt"), "Q\n", "[disjoint] only-Q.txt on shadow tip (union, not clobbered)");
  } finally {
    env.cleanup();
  }
}

// ── C. octopus: both echoes in one commit, divergent outers → HALT ──────────
function runOctopus(): void {
  const env = createTestEnv("echo-octopus", "frontend", "shadow", "");
  try {
    const { t1, t2 } = makeEchoTargets(env,
      { "shared.txt": "from-P\n", "only-P.txt": "P\n" },
      { "shared.txt": "from-Q\n", "only-Q.txt": "Q\n" });
    const ep = makeEcho(env, "ep", "p.ts", t1, "EP");
    const eq = makeEcho(env, "eq", "q.ts", t2, "EQ");
    git(`merge --no-ff ${ep} ${eq} -m "M: octopus merges echoes P and Q"`, env.remoteWorking);
    git("push origin main", env.remoteWorking);

    const r = runCiSync(env);
    assertNotEqual(r.status, 0, "[octopus] concurrent divergent echoes must HALT");
    assertEqual(showShadow(env, "only-Q.txt"), null, "[octopus] octopus merge not replayed past the halt");
  } finally {
    env.cleanup();
  }
}

export default function run(): void {
  setTestBranchAllowlist({ team: ["main"], origin: ["main"] });
  try {
    runConflict();
    runDisjoint();
    runOctopus();
  } finally {
    setTestBranchAllowlist();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-echo-sequential-outer");
}
