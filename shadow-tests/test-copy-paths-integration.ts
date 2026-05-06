import * as fs from "fs";
import * as path from "path";
import { execSync, spawnSync } from "child_process";
import {
  createTestEnv, addRemote, commitOnLocal, commitOnRemote,
  runPush, runCiSync, readExternalShadowFile,
} from "./harness";
import { assertEqual, assertIncludes } from "./assert";

const SCRIPT = path.resolve(__dirname, "..", "copy-paths.ts");

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function writeShadowConfig(repoRoot: string, copyPaths: { paths: string[] }[]): void {
  fs.writeFileSync(
    path.join(repoRoot, "shadow-config.json"),
    JSON.stringify({ copyPaths }, null, 2),
  );
}

interface RunResult { status: number; stdout: string; stderr: string; }

function runCopyPaths(repoRoot: string, mode: "check" | "rebuild"): RunResult {
  const r = spawnSync("npx", ["tsx", SCRIPT, mode], {
    cwd: repoRoot, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/**
 * Integration tests: do copy-paths' edits play nicely with shadow-sync?
 *
 * Phase X — forward path. Monorepo dev edits one mirror, runs copy-paths
 *           rebuild, commits. shadow-sync push on each pair must land the
 *           same content on both externals. The cross-cutting commit
 *           (touches frontend/common AND backend/common) is the
 *           interesting shape — each pair sees its own slice.
 *
 * Phase Y — reverse path. Two external devs edit common concurrently with
 *           different content. ci-sync brings divergent commits into
 *           monorepo's two paths. copy-paths must refuse (HEAD itself
 *           diverges); human resolves; push fans the resolution out.
 *
 * Phase Z — discipline failure. Monorepo dev forgets copy-paths and edits
 *           one mirror only. shadow-sync happily pushes only that side
 *           and the externals diverge. Documents the script's value
 *           (without copy-paths, the engine doesn't auto-correct).
 */

function setupTwoPairsWithCopyPaths(name: string): {
  env: ReturnType<typeof createTestEnv>;
  backend: ReturnType<typeof addRemote>;
} {
  const env = createTestEnv(name, "frontend");
  const backend = addRemote(env, "backend-repo", "backend");

  // Initial common content in both mirrors. Frontend already has its
  // subdir from createTestEnv; backend's subdir was created by addRemote.
  fs.mkdirSync(path.join(env.localRepo, "frontend/common"), { recursive: true });
  fs.mkdirSync(path.join(env.localRepo, "backend/common"), { recursive: true });
  fs.writeFileSync(path.join(env.localRepo, "frontend/common/foo.ts"), "v1\n");
  fs.writeFileSync(path.join(env.localRepo, "backend/common/foo.ts"), "v1\n");
  writeShadowConfig(env.localRepo, [{ paths: ["frontend/common", "backend/common"] }]);
  git("add -A", env.localRepo);
  git('commit -m "Initial: common populated + copy-paths config"', env.localRepo);

  return { env, backend };
}

/**
 * Pull the monorepo's shadow ref into an external repo's main so the
 * external has the synced subdir's content available for editing.
 * Equivalent to a real consumer's `mergeShadow` step, run from the
 * external's working clone.
 */
function externalMergeShadow(
  env: ReturnType<typeof createTestEnv>,
  monorepoSubdir: string,
  remote?: ReturnType<typeof addRemote>,
): void {
  const workDir = remote?.remoteWorking ?? env.remoteWorking;
  const shadowBranch = `${env.branchPrefix}/${monorepoSubdir}/main`;
  git(`fetch origin ${shadowBranch}`, workDir);
  git(`merge --no-ff origin/${shadowBranch} -m "External: pull common from monorepo"`, workDir);
  git("push origin main", workDir);
}

function phaseX_forwardCrossCuttingPropagation(): void {
  const { env, backend } = setupTwoPairsWithCopyPaths("cp-int-X-forward");
  try {
    // Establish shadow chains on both pairs.
    const r0a = runPush(env);
    assertEqual(r0a.status, 0, "[X] initial frontend push should succeed");
    const r0b = runPush(env, undefined, [], backend);
    assertEqual(r0b.status, 0, "[X] initial backend push should succeed");

    // Both externals now hold v1 on their shadow refs.
    assertEqual(readExternalShadowFile(env, "common/foo.ts"), "v1\n", "[X] frontend external initial");
    assertEqual(readExternalShadowFile(env, "common/foo.ts", backend), "v1\n", "[X] backend external initial");

    // Dev edits one mirror. Run copy-paths rebuild — it stages both the
    // source (their edit) and the propagated target.
    fs.writeFileSync(path.join(env.localRepo, "backend/common/foo.ts"), "v2 from backend\n");

    const cp = runCopyPaths(env.localRepo, "rebuild");
    assertEqual(cp.status, 0, "[X] copy-paths rebuild should succeed");
    assertIncludes(cp.stdout, "frontend/common", "[X] rebuild reports propagation");

    git('commit -m "Update common to v2"', env.localRepo);

    // Resulting commit is cross-cutting — touches both frontend/common
    // and backend/common. shadow-sync push on each pair sees its own slice.
    const rPa = runPush(env);
    assertEqual(rPa.status, 0, "[X] frontend push after rebuild should succeed");
    const rPb = runPush(env, undefined, [], backend);
    assertEqual(rPb.status, 0, "[X] backend push after rebuild should succeed");

    // Both externals now hold the same v2 on their shadow refs.
    assertEqual(
      readExternalShadowFile(env, "common/foo.ts"), "v2 from backend\n",
      "[X] frontend external got new common via cross-cutting commit",
    );
    assertEqual(
      readExternalShadowFile(env, "common/foo.ts", backend), "v2 from backend\n",
      "[X] backend external got new common via cross-cutting commit",
    );
  } finally {
    env.cleanup();
  }
}

function phaseY_reverseDivergentCiSyncRefusedAndResolved(): void {
  const { env, backend } = setupTwoPairsWithCopyPaths("cp-int-Y-reverse");
  try {
    // Push monorepo's common to both externals' shadow refs.
    runPush(env);
    runPush(env, undefined, [], backend);

    // Externals merge shadow into their main so common/foo.ts is present
    // there at v1 before they edit it. Skipping this step would make the
    // divergent edits ADDs rather than MODIFYs and the engine's tree
    // composition would collide with monorepo's existing v1 content.
    externalMergeShadow(env, "frontend");
    externalMergeShadow(env, "backend", backend);

    // Two external devs edit common concurrently with different content.
    commitOnRemote(env, { "common/foo.ts": "from frontend\n" }, "Frontend dev: edit common");
    commitOnRemote(env, { "common/foo.ts": "from backend\n" },  "Backend dev: edit common",  backend);

    // ci-sync replays both into monorepo's shadow refs (origin/shadow/...).
    const ci = runCiSync(env);
    assertEqual(ci.status, 0, "[Y] ci-sync of divergent edits should succeed");

    // Bring the divergent shadow content into the monorepo's working tree
    // by merging both shadow refs into main.
    const frontendShadow = `${env.branchPrefix}/${env.subdir}/main`;
    const backendShadow = `${env.branchPrefix}/${backend.subdir}/main`;
    git(`fetch origin ${frontendShadow}`, env.localRepo);
    git(`merge --no-ff origin/${frontendShadow} -m "Pull frontend shadow"`, env.localRepo);
    git(`fetch origin ${backendShadow}`, env.localRepo);
    git(`merge --no-ff origin/${backendShadow} -m "Pull backend shadow"`, env.localRepo);

    // Now monorepo has the divergent edits in the two mirrors.
    const fc = fs.readFileSync(path.join(env.localRepo, "frontend/common/foo.ts"), "utf8").replace(/\r\n/g, "\n");
    const bc = fs.readFileSync(path.join(env.localRepo, "backend/common/foo.ts"), "utf8").replace(/\r\n/g, "\n");
    assertEqual(fc, "from frontend\n", "[Y] monorepo frontend mirror got frontend dev's edit");
    assertEqual(bc, "from backend\n",  "[Y] monorepo backend mirror got backend dev's edit");

    // copy-paths check: divergence detected.
    const c = runCopyPaths(env.localRepo, "check");
    assertEqual(c.status, 1, "[Y] copy-paths check fails on cross-pair divergence");

    // copy-paths rebuild: refuses because HEAD itself disagrees and no
    // working-tree edit signals a side.
    const r1 = runCopyPaths(env.localRepo, "rebuild");
    assertEqual(r1.status, 2, "[Y] copy-paths rebuild refuses without a working-tree resolution");
    assertIncludes(r1.stderr, "match HEAD individually", "[Y] error explains HEAD divergence");

    // Human resolution: monorepo dev edits frontend's mirror to match
    // backend's. Now exactly one path differs from HEAD; rebuild picks it.
    fs.writeFileSync(path.join(env.localRepo, "frontend/common/foo.ts"), "from backend\n");

    const r2 = runCopyPaths(env.localRepo, "rebuild");
    assertEqual(r2.status, 0, "[Y] rebuild succeeds after the manual edit settles the dispute");

    git('commit -m "Resolve common divergence: pick backend"', env.localRepo);

    // Push the resolution to both externals.
    const rPa = runPush(env);
    assertEqual(rPa.status, 0, "[Y] frontend push after resolution should succeed");
    const rPb = runPush(env, undefined, [], backend);
    assertEqual(rPb.status, 0, "[Y] backend push after resolution should succeed");

    // Both shadow tips now hold the resolution.
    assertEqual(
      readExternalShadowFile(env, "common/foo.ts"), "from backend\n",
      "[Y] frontend external shadow has resolution",
    );
    assertEqual(
      readExternalShadowFile(env, "common/foo.ts", backend), "from backend\n",
      "[Y] backend external shadow has resolution",
    );
  } finally {
    env.cleanup();
  }
}

function phaseZ_disciplineFailureLeavesExternalsDiverged(): void {
  // No copy-paths invoked. Monorepo dev edits ONE mirror only. shadow-sync
  // does its job: each pair's source rev-list scopes the diff, so backend
  // pair sees the change and pushes it; frontend pair doesn't.
  // Documents that the engine is not the safety net — copy-paths is.
  const { env, backend } = setupTwoPairsWithCopyPaths("cp-int-Z-discipline");
  try {
    runPush(env);
    runPush(env, undefined, [], backend);

    // Dev edits one mirror, doesn't run copy-paths, just commits + pushes.
    fs.writeFileSync(path.join(env.localRepo, "backend/common/foo.ts"), "v2 backend only\n");
    git("add backend/common/foo.ts", env.localRepo);
    git('commit -m "Naive edit to backend mirror"', env.localRepo);

    const rPa = runPush(env);
    assertEqual(rPa.status, 0, "[Z] frontend push succeeds");
    const rPb = runPush(env, undefined, [], backend);
    assertEqual(rPb.status, 0, "[Z] backend push succeeds");

    // Backend external has the new content; frontend external still v1.
    assertEqual(
      readExternalShadowFile(env, "common/foo.ts", backend), "v2 backend only\n",
      "[Z] backend external got the naive edit",
    );
    assertEqual(
      readExternalShadowFile(env, "common/foo.ts"), "v1\n",
      "[Z] frontend external still v1 — engine doesn't auto-correct",
    );

    // copy-paths check would have caught this BEFORE the commit; running
    // it now still flags the divergence so a follow-up rebuild can fix it.
    const c = runCopyPaths(env.localRepo, "check");
    assertEqual(c.status, 1, "[Z] copy-paths check would have caught it");
  } finally {
    env.cleanup();
  }
}

const phases: Array<[string, () => void]> = [
  ["X: forward — cross-cutting commit fans out to both externals",  phaseX_forwardCrossCuttingPropagation],
  ["Y: reverse — divergent ci-sync refused, resolved, fanned out",  phaseY_reverseDivergentCiSyncRefusedAndResolved],
  ["Z: discipline failure — engine doesn't auto-correct",           phaseZ_disciplineFailureLeavesExternalsDiverged],
];

export default function run() {
  for (const [label, fn] of phases) {
    try {
      fn();
      console.log(`  PASS  ${label}`);
    } catch (e) {
      console.log(`  FAIL  ${label}`);
      console.log(`        ${(e as Error).message}`);
      throw e;
    }
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-copy-paths-integration");
}
