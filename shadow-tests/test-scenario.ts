/**
 * test-scenario.ts — single connected walkthrough of the engine's behavior.
 *
 * Phases in order:
 *   0   — mature backend/frontend with shared common; init mono; 2-pair × 2-mapping config; filter
 *   1a  — first --from b with project filtered out (orphan filter)
 *   1b  — open project + project-b, re-sync, bootstrap-graft + multi-project shadows
 *   2   — mono main absorbs both leaf-shadow mains (Mc1, Mc2)
 *   3   — six mono commits exercising the per-slice drop/keep matrix + cross-pair common
 *   4   — leaf-side integration round-trip (Bc3, Fc3) + tree-shape snapshot semantics
 *   F1  — orphan filtered leaf branch + filter-then-merge (--from b direction)
 *   F2  — orphan filtered mono branch + filter-then-merge (--from a direction)
 *   5   — mono closes the round-trip into main (Mc5, Mc6)
 *   release    — core-2.0 + Mr1 release + project/project-b absorb + fan-out dedup +
 *                per-branch project-name identity via conflict resolution + amend
 *   hotfix     — be-only bug fix with asymmetric drop (kept on backend, dropped on frontend)
 *   hotfix-roundtrip — operator chases the no-op merge chain on the frontend side
 *   halt-recovery   — divergent merge halts the engine; operator-driven recovery via
 *                     Shadow-replayed-* trailer; squash absorbs Bm + Bn1 + R_be
 *
 * Companion files cover the same engine paths in narrower shapes:
 *   test-halt-recovery-variants.ts — 8 single-pair halt-recovery edge cases
 *   test-merges.ts F               — generic single-pair manual-merge-recovery
 *   test-autoignore-nested-mapping.ts — regression for intra-pair nested-mapping auto-ignore
 */
import { execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runSync } from "../shadow-sync";
import { applyTestOverrides, setBranchFiltersForTesting, compileIgnorePattern } from "../shadow-common";
import { assertEqual } from "./assert";
import { createTestEnv, runCiSync, runPush, TestEnv } from "./harness";

// ── Setup helpers ────────────────────────────────────────────────────────────

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function writeRepoConfig(workDir: string, identity: { email: string; name: string }) {
  fs.appendFileSync(
    path.join(workDir, ".git", "config"),
    `[user]\n\temail = ${identity.email}\n\tname = ${identity.name}\n[core]\n\tautocrlf = false\n`,
  );
}

interface Repo {
  bare: string;
  working: string;
}

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

function commitFiles(repo: Repo, files: Record<string, string | null>, msg: string): string {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(repo.working, rel);
    if (content === null) {
      if (fs.existsSync(full)) fs.unlinkSync(full);
    } else {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
  }
  git("add -A", repo.working);
  git(`commit -m "${msg}"`, repo.working);
  return git("rev-parse HEAD", repo.working);
}

function mergeRef(repo: Repo, ref: string, msg: string): string {
  git(`merge --no-ff ${ref} -m "${msg}"`, repo.working);
  return git("rev-parse HEAD", repo.working);
}

// ── Assertion helpers ────────────────────────────────────────────────────────

function getParents(repo: Repo, sha: string): string[] {
  const out = git(`log -1 --format=%P ${sha}`, repo.working);
  return out.split(/\s+/).filter(Boolean);
}

function assertParents(repo: Repo, sha: string, expected: string[], msg: string) {
  const actual = getParents(repo, sha);
  assertEqual(actual.length, expected.length, `${msg}: parent count (got ${actual.join(",")})`);
  for (let i = 0; i < expected.length; i++) {
    assertEqual(actual[i], expected[i], `${msg}: parent[${i}]`);
  }
}

function assertTip(repo: Repo, ref: string, expected: string, msg: string) {
  assertEqual(git(`rev-parse ${ref}`, repo.working), expected, msg);
}

function refExists(repo: Repo, ref: string): boolean {
  try {
    git(`rev-parse --verify --quiet ${ref}`, repo.working);
    return true;
  } catch {
    return false;
  }
}

function assertRefExists(repo: Repo, ref: string, msg: string) {
  if (!refExists(repo, ref)) throw new Error(`${msg}: ref ${ref} should exist`);
}

function assertRefAbsent(repo: Repo, ref: string, msg: string) {
  if (refExists(repo, ref)) throw new Error(`${msg}: ref ${ref} should NOT exist`);
}

function listRefs(repo: Repo, prefix: string): string[] {
  try {
    return git(`for-each-ref --format=%(refname) ${prefix}`, repo.working).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/** Find a shadow replay by its trailer. Returns the replay SHA or null. */
function findReplay(repo: Repo, branchRef: string, sourceRemoteName: string, sourceSha: string): string | null {
  const pairName = branchRef.split("/")[2];
  const trailer = `Shadow-replayed-${pairName}-${sourceRemoteName}: ${sourceSha}`;
  let log: string;
  try {
    log = execSync(`git log ${branchRef} --format=%H%n%B%n---END---`, {
      cwd: repo.working, encoding: "utf8", maxBuffer: 50 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    return null;
  }
  const blocks = log.split("---END---\n").filter(Boolean);
  for (const block of blocks) {
    const trimmed = block.replace(/^\s+/, "");
    const newlineIdx = trimmed.indexOf("\n");
    const sha = trimmed.slice(0, newlineIdx).trim();
    const body = trimmed.slice(newlineIdx + 1);
    if (body.includes(trailer)) return sha;
  }
  return null;
}

function findReplayOrFail(repo: Repo, branchRef: string, sourceRemoteName: string, sourceSha: string, label: string): string {
  const sha = findReplay(repo, branchRef, sourceRemoteName, sourceSha);
  if (!sha) throw new Error(`${label}: replay of ${sourceSha.slice(0, 8)} not found on ${branchRef}`);
  return sha;
}

function listTreePaths(repo: Repo, ref: string): string[] {
  return git(`ls-tree -r --name-only ${ref}`, repo.working).split("\n").filter(Boolean);
}

function assertTreeHas(repo: Repo, ref: string, expectedPath: string, msg: string) {
  const paths = listTreePaths(repo, ref);
  if (!paths.includes(expectedPath)) {
    throw new Error(`${msg}\n  expected path: ${expectedPath}\n  ref ${ref} tree:\n    ${paths.join("\n    ")}`);
  }
}

function readAtRef(repo: Repo, ref: string, p: string): string {
  const raw = execSync(`git show ${ref}:${p}`, {
    cwd: repo.working, encoding: "utf8", maxBuffer: 50 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"],
  });
  return raw.replace(/\r\n/g, "\n");
}

/** Assert the full tree at `ref` matches the expected file → content map exactly. */
function assertTreeContents(repo: Repo, ref: string, expected: Record<string, string>, label: string) {
  const paths = listTreePaths(repo, ref);
  const expectedKeys = Object.keys(expected).sort();
  const actualKeys = [...paths].sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    const missing = expectedKeys.filter(k => !actualKeys.includes(k));
    const extra = actualKeys.filter(k => !expectedKeys.includes(k));
    throw new Error(
      `${label}: tree path mismatch\n` +
      `  missing: ${missing.join(", ") || "(none)"}\n` +
      `  extra:   ${extra.join(", ") || "(none)"}\n` +
      `  expected: ${expectedKeys.join(", ")}\n` +
      `  actual:   ${actualKeys.join(", ")}`,
    );
  }
  for (const key of expectedKeys) {
    const actual = readAtRef(repo, ref, key);
    if (actual !== expected[key]) {
      throw new Error(
        `${label}: file ${key} content mismatch\n` +
        `  expected: ${JSON.stringify(expected[key])}\n` +
        `  actual:   ${JSON.stringify(actual)}`,
      );
    }
  }
}

/** Mono-shaped tree: outer (root files) + backend/<be> + frontend/<fe> + common/<cm>. */
function monoTree(
  outer: Record<string, string>,
  be: Record<string, string>,
  fe: Record<string, string>,
  cm: Record<string, string> = {},
): Record<string, string> {
  const result: Record<string, string> = { ...outer };
  for (const [k, v] of Object.entries(be)) result[`backend/${k}`] = v;
  for (const [k, v] of Object.entries(fe)) result[`frontend/${k}`] = v;
  for (const [k, v] of Object.entries(cm)) result[`common/${k}`] = v;
  return result;
}

function pathExists(repo: Repo, ref: string, p: string): boolean {
  return listTreePaths(repo, ref).includes(p);
}

function assertPathPresent(repo: Repo, ref: string, p: string, label: string) {
  if (!pathExists(repo, ref, p)) {
    throw new Error(`${label}: expected path ${p} to be present at ${ref}; tree:\n  ${listTreePaths(repo, ref).join("\n  ")}`);
  }
}

function assertPathAbsent(repo: Repo, ref: string, p: string, label: string) {
  if (pathExists(repo, ref, p)) {
    throw new Error(`${label}: expected path ${p} to be ABSENT at ${ref}; tree includes it`);
  }
}

function assertContent(repo: Repo, ref: string, p: string, expected: string, label: string) {
  const actual = readAtRef(repo, ref, p);
  if (actual !== expected) {
    throw new Error(`${label}: ${p} content mismatch\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  }
}

// Suppress unused-import warnings until the relevant phases land.
void createTestEnv; void runCiSync; void runPush;
type _TestEnvAlias = TestEnv;

// ── Tree content constants ───────────────────────────────────────────────────
// Added per-phase as the scenario grows. Naming convention:
//   BE_*  — backend repo trees (no prefix; bare backend layout)
//   FE_*  — frontend repo trees (no prefix; bare frontend layout)
//   CM_*  — common-slice tree (paths relative to mono's common/, backend's src/common/, frontend's src/app/common/)
//   OUTER_* — mono root-only files (README, .claude/, etc.)
const EMPTY: Record<string, string> = {};

// Common slice — byte-identical across leaves; routed to mono's root common/ via the longer mapping.
const CM_V1 = { "util.ts": "util v1\n" };

// Mono's outer (root-only) tree at Mc0.
const OUTER_MC0 = { ".claude/settings.json": "{}\n", "README.md": "# Monorepo\n" };

// Backend primary slice ON MONO (i.e. what lands under backend/ after the
// primary mapping). Common is NOT included here — it routes to common/.
const BE_BC1_MONO = { "src/init.txt": "init\n", "src/feature.txt": "v1\n", "src/project-name.txt": "Main\n" };

// Frontend primary slice on mono.
const FE_FC1_MONO = { "src/init.txt": "init\n", "src/component.txt": "v1\n", "src/project-name.txt": "Main\n" };

// Bc2 / Fc2 primary slices on mono (feature/component bumped to v2).
const BE_BC2_MONO = { "src/init.txt": "init\n", "src/feature.txt": "v2\n", "src/project-name.txt": "Main\n" };
const FE_FC2_MONO = { "src/init.txt": "init\n", "src/component.txt": "v2\n", "src/project-name.txt": "Main\n" };

// Mono-main slice states at the kept-set boundaries used in Phase 4 assertions.
//   *_MC3BCFM_MONO = mono's slice tree as of Mc3bcfm (the last kept commit shared by both pairs)
//   BE_MC3B_MONO   = mono's backend slice as of Mc3b (latest kept backend change)
//   FE_MC3FM_MONO  = mono's frontend slice as of Mc3fm (latest kept frontend change)
const BE_MC3BCFM_MONO = {
  "src/init.txt":    "init\n",
  "src/feature.txt": "v3\n",
  "src/shared.txt":  "shared be\n",
  "src/project-name.txt": "Main\n",
};
const BE_MC3B_MONO = {
  ...BE_MC3BCFM_MONO,
  "src/back-only.txt": "be only\n",
};
const FE_MC3BCFM_MONO = {
  "src/init.txt":      "init\n",
  "src/component.txt": "v2\n",
  "src/shared.txt":    "shared fe\n",
  "src/project-name.txt": "Main\n",
};
const FE_MC3FM_MONO = {
  ...FE_MC3BCFM_MONO,
  "src/feature-flag.txt": "flag\n",
};
const CM_V4 = { "util.ts": "util v4\n" };
const OUTER_MC3FM = { ".claude/settings.json": "{}\n", "README.md": "# Monorepo (Mc3fm)\n" };

// Mc5/Mc6-era backend slice on mono: Mc3b's content + internal.txt (from Mf1x via Mc4) + fx.txt (from Bfx1 via Bc4_mono).
const BE_MC5_MONO = {
  ...BE_MC3B_MONO,
  "src/internal.txt": "internal\n",
  "src/fx.txt":       "fx v1\n",
};

// ── Scenario function ───────────────────────────────────────────────────────
// Built phase-by-phase. Phases are appended below as each is locked in.

async function runScenario(): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-test-combined-"));

  try {
    const backend  = createRepo(tmpDir, "backend",  { email: "bea@example.com",  name: "Bea"  });
    const frontend = createRepo(tmpDir, "frontend", { email: "fred@example.com", name: "Fred" });
    const mono     = createRepo(tmpDir, "mono",     { email: "mira@example.com", name: "Mira" });

    // Mono's working clone has cross-remotes so the orchestrator can reach both leaves.
    git(`remote add backend "${backend.bare}"`, mono.working);
    git(`remote add frontend "${frontend.bare}"`, mono.working);

    // ── Phase 0a: Mature backend (with src/common/util.ts byte-identical to FE) ──
    const Bc0 = commitFiles(backend, {
      "src/init.txt": "init\n",
      "src/common/util.ts": "util v1\n",
      "src/project-name.txt": "Main\n",
    }, "Bc0");
    const Bc1 = commitFiles(backend, { "src/feature.txt": "v1\n" }, "Bc1");
    git("push origin main", backend.working);

    git("checkout -b core-1.0", backend.working);
    const Br1 = commitFiles(backend, { "src/release.txt": "1.0\n" }, "Br1");
    git("push origin core-1.0", backend.working);

    git("checkout main", backend.working);
    const Bc2 = commitFiles(backend, { "src/feature.txt": "v2\n" }, "Bc2");
    git("push origin main", backend.working);

    git("checkout -b project core-1.0", backend.working);
    const Bt1 = commitFiles(backend, {
      "src/project.txt": "proj v1\n",
      "src/project-name.txt": "project\n",
    }, "Bt1");
    git("push origin project", backend.working);
    git("checkout -b project-b core-1.0", backend.working);
    const Btb1 = commitFiles(backend, { "src/project-name.txt": "projectB\n" }, "Btb1");
    git("push origin project-b", backend.working);
    git("checkout main", backend.working);

    // ── Phase 0b: Mature frontend (with src/app/common/util.ts byte-identical to BE) ──
    const Fc0 = commitFiles(frontend, {
      "src/init.txt": "init\n",
      "src/app/common/util.ts": "util v1\n",
      "src/project-name.txt": "Main\n",
    }, "Fc0");
    const Fc1 = commitFiles(frontend, { "src/component.txt": "v1\n" }, "Fc1");
    git("push origin main", frontend.working);

    git("checkout -b core-1.0", frontend.working);
    const Fr1 = commitFiles(frontend, { "src/release.txt": "1.0\n" }, "Fr1");
    git("push origin core-1.0", frontend.working);

    git("checkout main", frontend.working);
    const Fc2 = commitFiles(frontend, { "src/component.txt": "v2\n" }, "Fc2");
    git("push origin main", frontend.working);

    git("checkout -b project core-1.0", frontend.working);
    const Ft1 = commitFiles(frontend, {
      "src/project.txt": "proj v1\n",
      "src/project-name.txt": "project\n",
    }, "Ft1");
    git("push origin project", frontend.working);
    git("checkout -b project-b core-1.0", frontend.working);
    const Ftb1 = commitFiles(frontend, { "src/project-name.txt": "projectB\n" }, "Ftb1");
    git("push origin project-b", frontend.working);
    git("checkout main", frontend.working);

    // ── Phase 0c: Init mono (Mc0) — outer only; no common/, no project branch ──
    const Mc0 = commitFiles(mono, {
      "README.md": "# Monorepo\n",
      ".claude/settings.json": "{}\n",
    }, "Mc0");
    git("push origin main", mono.working);

    // ── Phase 0d: Orchestrator config — 2 pairs × 2 mappings (primary + common) ──
    applyTestOverrides({
      repoRoot: mono.working,
      pairs: [
        {
          name: "backend",
          a: { remote: "origin",  url: mono.bare    },
          b: { remote: "backend", url: backend.bare },
          mappings: [
            { a: "backend", b: "" },
            { a: "common",  b: "src/common" },
          ],
        },
        {
          name: "frontend",
          a: { remote: "origin",   url: mono.bare     },
          b: { remote: "frontend", url: frontend.bare },
          mappings: [
            { a: "frontend", b: "" },
            { a: "common",   b: "src/app/common" },
          ],
        },
      ],
      shadowBranchPrefix: "shadow",
    });

    // ── Phase 0e: Branch allowlist — project filtered EVERYWHERE initially.
    // Phase 1's first --from b will verify the filter blocks project shadow refs.
    const allowed: Map<string, string[]> = new Map([
      ["origin",   ["main"]],
      ["backend",  ["main", "core-*"]],
      ["frontend", ["main", "core-*"]],
    ]);
    const installAllowed = () => setBranchFiltersForTesting(new Map(
      Array.from(allowed.entries(), ([r, bs]) => [r, bs.map(compileIgnorePattern)]),
    ));
    const allow = (remote: string, ...branches: string[]): void => {
      const list = allowed.get(remote) ?? [];
      for (const b of branches) if (!list.includes(b)) list.push(b);
      allowed.set(remote, list);
      installAllowed();
    };
    installAllowed();


    // ── Phase 1a: First --from b — project filtered out everywhere ──────
    {
      const r = runSync({ from: "b" });
      assertEqual(r.exitCode, 0, `[Phase 1a] --from b: ${r.stderr.slice(0, 300)}`);
    }
    git("fetch origin", mono.working);

    assertRefExists(mono, "origin/shadow/backend/main",      "[Phase 1a] shadow/backend/main");
    assertRefExists(mono, "origin/shadow/backend/core-1.0",  "[Phase 1a] shadow/backend/core-1.0");
    assertRefExists(mono, "origin/shadow/frontend/main",     "[Phase 1a] shadow/frontend/main");
    assertRefExists(mono, "origin/shadow/frontend/core-1.0", "[Phase 1a] shadow/frontend/core-1.0");

    // project filtered everywhere → no shadow refs at all on either pair.
    assertRefAbsent(mono, "origin/shadow/backend/project",  "[Phase 1a] backend/project filtered");
    assertRefAbsent(mono, "origin/shadow/frontend/project", "[Phase 1a] frontend/project filtered");

    // ── Phase 1b: Open project + project-b on all three sides, re-sync ──
    allow("origin",   "project");
    allow("backend",  "project");
    allow("frontend", "project");
    allow("backend",  "project-b");
    allow("frontend", "project-b");
    {
      const r = runSync({ from: "b" });
      assertEqual(r.exitCode, 0, `[Phase 1b] --from b after allowing project: ${r.stderr.slice(0, 300)}`);
    }
    git("fetch origin", mono.working);

    assertRefExists(mono, "origin/shadow/backend/project",    "[Phase 1b] shadow/backend/project now present");
    assertRefExists(mono, "origin/shadow/frontend/project",   "[Phase 1b] shadow/frontend/project now present");
    assertRefExists(mono, "origin/shadow/backend/project-b",  "[Phase 1b] shadow/backend/project-b now present");
    assertRefExists(mono, "origin/shadow/frontend/project-b", "[Phase 1b] shadow/frontend/project-b now present");

    // Existence-only check: every leaf commit has a replay on the matching shadow ref.
    const Bc0_mono = findReplayOrFail(mono, "origin/shadow/backend/main", "backend", Bc0, "Bc0'_mono");
    const Bc1_mono = findReplayOrFail(mono, "origin/shadow/backend/main", "backend", Bc1, "Bc1'_mono");
    const Bc2_mono = findReplayOrFail(mono, "origin/shadow/backend/main",     "backend",  Bc2, "Bc2'_mono");
    findReplayOrFail(mono, "origin/shadow/backend/core-1.0", "backend",  Br1, "Br1'_mono");
    findReplayOrFail(mono, "origin/shadow/backend/project",   "backend",  Bt1,  "Bt1'_mono");
    findReplayOrFail(mono, "origin/shadow/backend/project-b", "backend",  Btb1, "Btb1'_mono");
    const Fc0_mono = findReplayOrFail(mono, "origin/shadow/frontend/main", "frontend", Fc0, "Fc0'_mono");
    const Fc1_mono = findReplayOrFail(mono, "origin/shadow/frontend/main", "frontend", Fc1, "Fc1'_mono");
    const Fc2_mono = findReplayOrFail(mono, "origin/shadow/frontend/main", "frontend", Fc2, "Fc2'_mono");
    findReplayOrFail(mono, "origin/shadow/frontend/core-1.0", "frontend", Fr1, "Fr1'_mono");
    findReplayOrFail(mono, "origin/shadow/frontend/project",   "frontend", Ft1,  "Ft1'_mono");
    findReplayOrFail(mono, "origin/shadow/frontend/project-b", "frontend", Ftb1, "Ftb1'_mono");

    // Bootstrap-grafting: each pair's first replay should be parented onto Mc0
    // so the chain is connected to mono's history (not a dangling root).
    assertParents(mono, Bc0_mono, [Mc0], "Bc0'_mono parented onto Mc0 (bootstrap graft)");
    assertParents(mono, Fc0_mono, [Mc0], "Fc0'_mono parented onto Mc0 (bootstrap graft)");

    // Spot-check tree shape on Bc1'_mono and Fc1'_mono:
    //   outer = Mc0's outer (unchanged through bootstrap),
    //   primary slice projected under backend/ resp. frontend/ (no common leak),
    //   common slice at root common/util.ts via longest-prefix routing.
    assertTreeContents(mono, Bc1_mono, monoTree(OUTER_MC0, BE_BC1_MONO, EMPTY, CM_V1),
      "Bc1'_mono tree (outer=Mc0, be slice under backend/, common at root)");
    assertTreeContents(mono, Fc1_mono, monoTree(OUTER_MC0, EMPTY, FE_FC1_MONO, CM_V1),
      "Fc1'_mono tree (outer=Mc0, fe slice under frontend/, common at root)");

    // ── Phase 2: Bring both leaf shadows into mono's main (Mc1, Mc2) ────
    const Mc1 = mergeRef(mono, "origin/shadow/backend/main",  "Mc1");
    const Mc2 = mergeRef(mono, "origin/shadow/frontend/main", "Mc2");
    git("push origin main", mono.working);

    assertParents(mono, Mc1, [Mc0, Bc2_mono], "Mc1 = merge(Mc0, shadow/backend/main tip)");
    assertParents(mono, Mc2, [Mc1, Fc2_mono], "Mc2 = merge(Mc1, shadow/frontend/main tip)");

    // Mc2 = mono's unified main tip: both pair trees + common + Mc0 outer.
    assertTreeContents(mono, Mc2, monoTree(OUTER_MC0, BE_BC2_MONO, FE_FC2_MONO, CM_V1),
      "Mc2 tree (outer=Mc0, both pair slices, common at root)");

    // ── Phase 3: Six mono commits exercising per-slice drop/keep, then --from a ──
    // Mc3m    — outer-only            → DROP on backend, DROP on frontend
    // Mc3c    — common-only           → KEEP on backend, KEEP on frontend
    // Mc3bc   — backend + common      → KEEP on backend, KEEP on frontend
    // Mc3bcfm — outer + be + cm + fe  → KEEP on backend, KEEP on frontend
    // Mc3fm   — outer + frontend      → DROP on backend, KEEP on frontend
    // Mc3b    — backend-only          → KEEP on backend, DROP on frontend
    const Mc3m    = commitFiles(mono, { "README.md": "# Monorepo (Mc3m)\n" }, "Mc3m");
    const Mc3c    = commitFiles(mono, { "common/util.ts": "util v2\n" }, "Mc3c");
    const Mc3bc   = commitFiles(mono, {
      "backend/src/feature.txt": "v3\n",
      "common/util.ts": "util v3\n",
    }, "Mc3bc");
    const Mc3bcfm = commitFiles(mono, {
      "README.md": "# Monorepo (Mc3bcfm)\n",
      "backend/src/shared.txt": "shared be\n",
      "common/util.ts": "util v4\n",
      "frontend/src/shared.txt": "shared fe\n",
    }, "Mc3bcfm");
    const Mc3fm = commitFiles(mono, {
      "README.md": "# Monorepo (Mc3fm)\n",
      "frontend/src/feature-flag.txt": "flag\n",
    }, "Mc3fm");
    const Mc3b  = commitFiles(mono, { "backend/src/back-only.txt": "be only\n" }, "Mc3b");
    git("push origin main", mono.working);

    {
      const r = runSync({ from: "a" });
      assertEqual(r.exitCode, 0, `[Phase 3] --from a: ${r.stderr.slice(0, 300)}`);
    }
    git("fetch origin", backend.working);
    git("fetch origin", frontend.working);

    // ── Exactly 1 new shadow ref on each leaf, with the expected name ────
    const beShadowRefs = listRefs(backend,  "refs/remotes/origin/shadow");
    const feShadowRefs = listRefs(frontend, "refs/remotes/origin/shadow");
    assertEqual(beShadowRefs.length, 1, `[Phase 3] backend has exactly 1 shadow ref (got: ${beShadowRefs.join(",")})`);
    assertEqual(beShadowRefs[0], "refs/remotes/origin/shadow/backend/main", "[Phase 3] backend shadow ref name");
    assertEqual(feShadowRefs.length, 1, `[Phase 3] frontend has exactly 1 shadow ref (got: ${feShadowRefs.join(",")})`);
    assertEqual(feShadowRefs[0], "refs/remotes/origin/shadow/frontend/main", "[Phase 3] frontend shadow ref name");

    // ── Drops: Mc0 (outer-init) and Mc3m (outer-only) on BOTH pairs ──────
    assertEqual(findReplay(backend,  "origin/shadow/backend/main",  "origin", Mc0),  null,
      "[Phase 3] Mc0 (outer-init) dropped on backend");
    assertEqual(findReplay(frontend, "origin/shadow/frontend/main", "origin", Mc0),  null,
      "[Phase 3] Mc0 dropped on frontend");
    assertEqual(findReplay(backend,  "origin/shadow/backend/main",  "origin", Mc3m), null,
      "[Phase 3] Mc3m (outer-only) dropped on backend");
    assertEqual(findReplay(frontend, "origin/shadow/frontend/main", "origin", Mc3m), null,
      "[Phase 3] Mc3m dropped on frontend");

    // ── Asymmetric drops: be-only on frontend, fe-only-with-outer on backend ──
    assertEqual(findReplay(backend,  "origin/shadow/backend/main",  "origin", Mc3fm), null,
      "[Phase 3] Mc3fm (fe + outer, no be/cm change) dropped on backend");
    assertEqual(findReplay(frontend, "origin/shadow/frontend/main", "origin", Mc3b),  null,
      "[Phase 3] Mc3b (be-only) dropped on frontend");

    // ── Cross-pair common: Fc1/Fc2 don't change common → NOT cross-pair-replayed on backend ──
    assertEqual(findReplay(backend, "origin/shadow/backend/main", "origin", Fc1_mono), null,
      "[Phase 3] Fc1_mono not cross-pair-replayed on backend (no common change)");
    assertEqual(findReplay(backend, "origin/shadow/backend/main", "origin", Fc2_mono), null,
      "[Phase 3] Fc2_mono not cross-pair-replayed on backend (no common change)");
    assertEqual(findReplay(frontend, "origin/shadow/frontend/main", "origin", Bc1_mono), null,
      "[Phase 3] Bc1_mono not cross-pair-replayed on frontend (no common change)");
    assertEqual(findReplay(frontend, "origin/shadow/frontend/main", "origin", Bc2_mono), null,
      "[Phase 3] Bc2_mono not cross-pair-replayed on frontend (no common change)");

    // ── Backend pair topology: Mc1 (merge), Fc0 (cross-pair common), Mc2 (merge of both) ──
    const Mc1_be = findReplayOrFail(backend, "origin/shadow/backend/main", "origin", Mc1, "Mc1'_be");
    assertParents(backend, Mc1_be, [Bc0, Bc2], "Mc1'_be parents = [Bc0 (root graft), Bc2 (be shadow tip)]");

    const Fc0_be = findReplayOrFail(backend, "origin/shadow/backend/main", "origin", Fc0_mono, "Fc0'_be (cross-pair common)");
    assertParents(backend, Fc0_be, [Bc0], "Fc0'_be parents = [Bc0] (cross-pair common, single-parent graft on backend root)");

    const Mc2_be = findReplayOrFail(backend, "origin/shadow/backend/main", "origin", Mc2, "Mc2'_be");
    assertParents(backend, Mc2_be, [Mc1_be, Fc0_be], "Mc2'_be parents = [Mc1'_be, Fc0'_be] (integrates cross-pair replay)");

    // ── Frontend pair topology: mirror — Bc0 (cross-pair) hangs off Fc0, Mc1 is the integrator ──
    const Bc0_fe = findReplayOrFail(frontend, "origin/shadow/frontend/main", "origin", Bc0_mono, "Bc0'_fe (cross-pair common)");
    assertParents(frontend, Bc0_fe, [Fc0], "Bc0'_fe parents = [Fc0] (cross-pair common, single-parent graft on frontend root)");

    const Mc1_fe = findReplayOrFail(frontend, "origin/shadow/frontend/main", "origin", Mc1, "Mc1'_fe");
    assertParents(frontend, Mc1_fe, [Fc0, Bc0_fe], "Mc1'_fe parents = [Fc0 (root graft), Bc0'_fe (cross-pair)]");

    const Mc2_fe = findReplayOrFail(frontend, "origin/shadow/frontend/main", "origin", Mc2, "Mc2'_fe");
    assertParents(frontend, Mc2_fe, [Mc1_fe, Fc2], "Mc2'_fe parents = [Mc1'_fe, Fc2 (fe shadow tip)]");

    // ── Mc3* keeps (existence-only): single-parent chains tail off Mc2'_* ──
    findReplayOrFail(backend,  "origin/shadow/backend/main",  "origin", Mc3c,    "Mc3c'_be");
    findReplayOrFail(frontend, "origin/shadow/frontend/main", "origin", Mc3c,    "Mc3c'_fe");
    findReplayOrFail(backend,  "origin/shadow/backend/main",  "origin", Mc3bc,   "Mc3bc'_be");
    findReplayOrFail(frontend, "origin/shadow/frontend/main", "origin", Mc3bc,   "Mc3bc'_fe");
    findReplayOrFail(backend,  "origin/shadow/backend/main",  "origin", Mc3bcfm, "Mc3bcfm'_be");
    findReplayOrFail(frontend, "origin/shadow/frontend/main", "origin", Mc3bcfm, "Mc3bcfm'_fe");
    const Mc3fm_fe = findReplayOrFail(frontend, "origin/shadow/frontend/main", "origin", Mc3fm, "Mc3fm'_fe");
    const Mc3b_be  = findReplayOrFail(backend,  "origin/shadow/backend/main",  "origin", Mc3b,  "Mc3b'_be");

    // ── Phase 4: Leaf integration (Bc3, Fc3) + --from b + tree-shape round-trip ──
    // Backend merges shadow/backend/main back into main; frontend mirrors.
    // After --from b, mono's shadow/{backend,frontend}/main tips integrate the
    // leaf-side merge and must carry outer + cross-pair slice spliced from the
    // latest kept ancestor on each pair's view of mono main.
    git("checkout main", backend.working);
    const Bc3 = mergeRef(backend, "origin/shadow/backend/main", "Bc3");
    git("push origin main", backend.working);
    assertParents(backend, Bc3, [Bc2, Mc3b_be], "Bc3 = merge(Bc2, shadow/backend/main tip)");

    git("checkout main", frontend.working);
    const Fc3 = mergeRef(frontend, "origin/shadow/frontend/main", "Fc3");
    git("push origin main", frontend.working);
    assertParents(frontend, Fc3, [Fc2, Mc3fm_fe], "Fc3 = merge(Fc2, shadow/frontend/main tip)");

    {
      const r = runSync({ from: "b" });
      assertEqual(r.exitCode, 0, `[Phase 4] --from b after Bc3/Fc3: ${r.stderr.slice(0, 300)}`);
    }
    git("fetch origin", mono.working);

    // ── Bc3'_mono and Fc3'_mono exist and become the new shadow tips ─────
    const Bc3_mono = findReplayOrFail(mono, "origin/shadow/backend/main",  "backend",  Bc3, "Bc3'_mono");
    const Fc3_mono = findReplayOrFail(mono, "origin/shadow/frontend/main", "frontend", Fc3, "Fc3'_mono");
    assertTip(mono, "origin/shadow/backend/main",  Bc3_mono, "[Phase 4] shadow/backend/main tip = Bc3'_mono");
    assertTip(mono, "origin/shadow/frontend/main", Fc3_mono, "[Phase 4] shadow/frontend/main tip = Fc3'_mono");

    // ── Tree-shape round-trip: each pair's shadow tip = mono-main snapshot at the pair's latest kept commit ──
    // Backend pair's latest kept on mono main = Mc3b. mono main at Mc3b has:
    //   outer = Mc3fm's README (Mc3b doesn't change outer; Mc3fm is Mc3b's parent),
    //   be    = Mc3b's own be slice (back-only added),
    //   fe    = Mc3fm's fe slice (feature-flag rides along via Mc3b's ancestry),
    //   cm    = Mc3bcfm's util v4 (last common change).
    assertTreeContents(mono, Bc3_mono,
      monoTree(OUTER_MC3FM, BE_MC3B_MONO, FE_MC3FM_MONO, CM_V4),
      "Bc3'_mono tree: snapshot of mono main at Mc3b (be pair's latest kept commit)");

    // Frontend pair's latest kept = Mc3fm. mono main at Mc3fm has:
    //   outer = Mc3fm's README,
    //   be    = Mc3bcfm's be (Mc3b is later and dropped on fe pair — Mc3fm's parent is Mc3bcfm),
    //   fe    = Mc3fm's own fe slice,
    //   cm    = Mc3bcfm's util v4.
    assertTreeContents(mono, Fc3_mono,
      monoTree(OUTER_MC3FM, BE_MC3BCFM_MONO, FE_MC3FM_MONO, CM_V4),
      "Fc3'_mono tree: snapshot of mono main at Mc3fm (fe pair's latest kept commit)");

    // ── Phase F1: orphan filtered branch + filter-then-merge ──────────────
    // feature/x is created on backend but NEVER added to the allowlist.
    // First --from b: branch and its commits stay invisible on mono.
    // Then we merge feature/x into backend's main (which IS allowlisted) and
    // re-sync: the branch still has no shadow ref, but its commits reach
    // mono's shadow/backend/main via merge reachability.
    git("checkout -b feature/x main", backend.working);
    const Bfx1 = commitFiles(backend, { "src/fx.txt": "fx v1\n" }, "Bfx1");
    git("push origin feature/x", backend.working);

    {
      const r = runSync({ from: "b" });
      assertEqual(r.exitCode, 0, `[F1 step 1] --from b with orphan filtered branch: ${r.stderr.slice(0, 300)}`);
    }
    git("fetch origin", mono.working);

    // Filtered branch produces no shadow ref of its own…
    assertRefAbsent(mono, "origin/shadow/backend/feature/x",
      "[F1 step 1] filtered feature/x must not get a shadow ref on mono");
    // …and its commits aren't reachable from any allowed shadow ref either
    // (it's not yet merged into main).
    assertEqual(findReplay(mono, "origin/shadow/backend/main", "backend", Bfx1), null,
      "[F1 step 1] Bfx1 not replayed on shadow/backend/main (branch not merged yet)");

    // Snapshot the shadow-ref set so we can confirm no NEW refs appear after the merge.
    const monoShadowRefsBeforeMerge = listRefs(mono, "refs/remotes/origin/shadow").sort();

    // ── F1 step 2: merge feature/x into backend's main, re-sync ──────────
    git("checkout main", backend.working);
    const Bc4 = mergeRef(backend, "feature/x", "Bc4");
    git("push origin main", backend.working);

    {
      const r = runSync({ from: "b" });
      assertEqual(r.exitCode, 0, `[F1 step 2] --from b after merging feature/x into main: ${r.stderr.slice(0, 300)}`);
    }
    git("fetch origin", mono.working);

    // The branch itself STILL has no shadow ref — the filter is branch-level.
    assertRefAbsent(mono, "origin/shadow/backend/feature/x",
      "[F1 step 2] filter is branch-level: feature/x stays out even after the merge");
    // No new shadow refs appeared.
    const monoShadowRefsAfterMerge = listRefs(mono, "refs/remotes/origin/shadow").sort();
    assertEqual(JSON.stringify(monoShadowRefsAfterMerge), JSON.stringify(monoShadowRefsBeforeMerge),
      "[F1 step 2] no new shadow refs from the merge — same set as before");

    // But Bfx1 and Bc4 DO reach shadow/backend/main via merge reachability.
    const Bfx1_mono = findReplayOrFail(mono, "origin/shadow/backend/main", "backend", Bfx1, "Bfx1'_mono (via merge reachability)");
    const Bc4_mono  = findReplayOrFail(mono, "origin/shadow/backend/main", "backend", Bc4,  "Bc4'_mono");
    // Bfx1's parent on leaf is Bc3 (branch was cut from main = Bc3); maps to Bc3_mono.
    assertParents(mono, Bfx1_mono, [Bc3_mono],
      "[F1 step 2] Bfx1'_mono parents = [Bc3'_mono] (filtered-branch commit grafted via merge reachability)");
    // Bc4 is the integration merge on backend's main.
    assertParents(mono, Bc4_mono, [Bc3_mono, Bfx1_mono],
      "[F1 step 2] Bc4'_mono parents = [Bc3'_mono, Bfx1'_mono]");

    // ── Phase F2: orphan filtered MONO branch (--from a direction) ───────
    // Mirror of F1 on the other direction. Mono creates internal/notes which
    // is NOT in origin's allowlist. First --from a: no shadow ref on either
    // leaf, no replays. Then we merge into mono main (Mc4): branch still
    // filtered, but Mf1x reaches backend's shadow/backend/main via merge
    // reachability. Frontend pair TREESAME-drops both (be-only change).
    git("checkout -b internal/notes main", mono.working);
    const Mf1x = commitFiles(mono, { "backend/src/internal.txt": "internal\n" }, "Mf1x");
    git("push origin internal/notes", mono.working);

    {
      const r = runSync({ from: "a" });
      assertEqual(r.exitCode, 0, `[F2 step 1] --from a with orphan filtered mono branch: ${r.stderr.slice(0, 300)}`);
    }
    git("fetch origin", backend.working);
    git("fetch origin", frontend.working);

    // Filtered mono branch produces no shadow ref on either leaf…
    assertRefAbsent(backend,  "origin/shadow/backend/internal/notes",  "[F2 step 1] no shadow ref on backend leaf");
    assertRefAbsent(frontend, "origin/shadow/frontend/internal/notes", "[F2 step 1] no shadow ref on frontend leaf");
    // …and Mf1x is not yet reachable from any allowed mono branch.
    assertEqual(findReplay(backend,  "origin/shadow/backend/main",  "origin", Mf1x), null,
      "[F2 step 1] Mf1x not replayed on backend (branch not merged into main yet)");
    assertEqual(findReplay(frontend, "origin/shadow/frontend/main", "origin", Mf1x), null,
      "[F2 step 1] Mf1x not replayed on frontend");

    // ── F2 step 2: merge internal/notes into mono's main (Mc4), re-sync ──
    git("checkout main", mono.working);
    const Mc4 = mergeRef(mono, "internal/notes", "Mc4");
    git("push origin main", mono.working);

    {
      const r = runSync({ from: "a" });
      assertEqual(r.exitCode, 0, `[F2 step 2] --from a after Mc4: ${r.stderr.slice(0, 300)}`);
    }
    git("fetch origin", backend.working);
    git("fetch origin", frontend.working);

    // Branch refs still absent (filter is branch-level).
    assertRefAbsent(backend,  "origin/shadow/backend/internal/notes",  "[F2 step 2] filter is branch-level on --from a too");
    assertRefAbsent(frontend, "origin/shadow/frontend/internal/notes", "[F2 step 2] same on frontend leaf");

    // Backend: Mf1x reaches via merge reachability; Mc4 lands as the integration merge.
    const Mf1x_be = findReplayOrFail(backend, "origin/shadow/backend/main", "origin", Mf1x, "Mf1x'_be");
    const Mc4_be  = findReplayOrFail(backend, "origin/shadow/backend/main", "origin", Mc4,  "Mc4'_be");
    assertParents(backend, Mf1x_be, [Mc3b_be],
      "[F2 step 2] Mf1x'_be parents = [Mc3b'_be] (filtered-branch commit grafted onto kept-set tip)");
    assertParents(backend, Mc4_be, [Mc3b_be, Mf1x_be],
      "[F2 step 2] Mc4'_be parents = [Mc3b'_be, Mf1x'_be]");

    // Frontend: be-only change on Mf1x → TREESAME drop. Mc4 also drops (merge of two
    // commits whose fe/cm projections both equal Mc3fm's). Tip stays at Mc3fm'_fe.
    assertEqual(findReplay(frontend, "origin/shadow/frontend/main", "origin", Mf1x), null,
      "[F2 step 2] Mf1x (be-only) dropped on frontend pair");
    assertEqual(findReplay(frontend, "origin/shadow/frontend/main", "origin", Mc4), null,
      "[F2 step 2] Mc4 (be-only merge) dropped on frontend pair");
    assertTip(frontend, "origin/shadow/frontend/main", Mc3fm_fe,
      "[F2 step 2] frontend shadow tip unchanged at Mc3fm'_fe");

    // ── Phase 5: Mono integrates both pair shadows back into main (Mc5, Mc6) ──
    // Closes the full round-trip: leaf→mono→leaf→mono is now followed by mono's
    // own integration merges, bringing Bfx1's fx.txt into mono main via Bc4_mono.
    // Fc3_mono carries the Mc3fm snapshot; since Mc3fm is already an ancestor of
    // Mc4, Mc6 = merge(Mc5, Fc3_mono) is a topology-preserving merge with no
    // new tree changes beyond what Mc5 already had.
    git("checkout main", mono.working);
    const Mc5 = mergeRef(mono, "origin/shadow/backend/main",  "Mc5");
    const Mc6 = mergeRef(mono, "origin/shadow/frontend/main", "Mc6");
    git("push origin main", mono.working);

    assertParents(mono, Mc5, [Mc4, Bc4_mono],
      "[Phase 5] Mc5 = merge(Mc4, shadow/backend/main tip = Bc4'_mono)");
    assertParents(mono, Mc6, [Mc5, Fc3_mono],
      "[Phase 5] Mc6 = merge(Mc5, shadow/frontend/main tip = Fc3'_mono)");
    assertTip(mono, "main", Mc6, "[Phase 5] mono main = Mc6 (round-trip closed)");

    // Final mono main tree: Mc3fm-era outer/fe/cm + the union of leaf and mono
    // additions on backend (back-only, internal, fx).
    assertTreeContents(mono, Mc6,
      monoTree(OUTER_MC3FM, BE_MC5_MONO, FE_MC3FM_MONO, CM_V4),
      "[Phase 5] Mc6 tree: outer=Mc3fm, be=Mc3b+internal+fx, fe=Mc3fm, cm=Mc3bcfm");

    // ── Phase release: core-2.0 release branch + project absorbs release ──
    // mono first absorbs the shadow project refs into main (Mc7, Mc8), then
    // creates core-2.0 with the v2 release marker (Mr1). The absorption is
    // load-bearing: it puts the release-1.0 baseline (from Br1 via Bt1) into
    // the common ancestor of project and the eventual core-2.0, so the
    // later leaf-side Bt2 = merge(project, core-2.0) can resolve the
    // release.txt collision via 3-way merge instead of an add/add conflict.
    // After --from a, leaves get shadow/<pair>/core-2.0; each leaf integrates
    // main, branches its own core-2.0, merges the shadow release (Br2/Fr2),
    // then merges core-2.0 into project (Bt2/Ft2). Final --from b syncs back.
    git("checkout main", mono.working);
    const Mc7a = mergeRef(mono, "origin/shadow/backend/project", "Mc7a");
    // Mc7b conflicts on backend/src/project-name.txt — Mc7a brought "project",
    // project-b shadow has "projectB". Operator drops project-b's identifier
    // (keeps "project" — main-side decides what name lives on main).
    let Mc7b: string;
    try {
      Mc7b = mergeRef(mono, "origin/shadow/backend/project-b", "Mc7b");
    } catch {
      fs.writeFileSync(path.join(mono.working, "backend/src/project-name.txt"), "project\n");
      git("add -A", mono.working);
      git("commit --no-edit", mono.working);
      Mc7b = git("rev-parse HEAD", mono.working);
    }
    const Mc8a = mergeRef(mono, "origin/shadow/frontend/project", "Mc8a");
    // Mc8b: symmetric conflict on frontend/src/project-name.txt.
    let Mc8b: string;
    try {
      Mc8b = mergeRef(mono, "origin/shadow/frontend/project-b", "Mc8b");
    } catch {
      fs.writeFileSync(path.join(mono.working, "frontend/src/project-name.txt"), "project\n");
      git("add -A", mono.working);
      git("commit --no-edit", mono.working);
      Mc8b = git("rev-parse HEAD", mono.working);
    }
    git("push origin main", mono.working);

    allow("origin", "core-*");
    git("checkout -b core-2.0 main", mono.working);
    const Mr1 = commitFiles(mono, {
      "backend/src/release.txt":  "2.0\n",
      "frontend/src/release.txt": "2.0\n",
    }, "Mr1");
    git("push origin core-2.0", mono.working);

    {
      const r = runSync({ from: "a" });
      assertEqual(r.exitCode, 0, `[release] --from a after Mr1: ${r.stderr.slice(0, 300)}`);
    }

    // ── Backend: main catches up, then core-2.0 + project ────────────────
    git("fetch origin", backend.working);
    git("checkout main", backend.working);
    const Bc5 = mergeRef(backend, "origin/shadow/backend/main", "Bc5");
    git("push origin main", backend.working);
    // Bc5's 2nd parent is the shadow/backend/main tip, which is Mc7b'_be —
    // Mc8a / Mc8b (frontend project absorptions) drop on backend pair so the
    // tip stays at Mc7b'_be after --from a.
    const Mc7b_be = findReplayOrFail(backend, "origin/shadow/backend/main", "origin", Mc7b, "Mc7b'_be");
    assertParents(backend, Bc5, [Bc4, Mc7b_be], "[release] Bc5 = merge(Bc4, Mc7b'_be)");
    assertEqual(findReplay(backend, "origin/shadow/backend/main", "origin", Mc8a), null,
      "[release] Mc8a (cross-pair fe-project merge) drops on backend pair");
    assertEqual(findReplay(backend, "origin/shadow/backend/main", "origin", Mc8b), null,
      "[release] Mc8b (cross-pair fe-project-b merge) drops on backend pair");

    git("checkout -b core-2.0 main", backend.working);
    const Br2 = mergeRef(backend, "origin/shadow/backend/core-2.0", "Br2");
    git("push origin core-2.0", backend.working);

    git("checkout project", backend.working);
    const Bt2 = mergeRef(backend, "core-2.0", "Bt2");
    git("push origin project", backend.working);

    // Fan-out: project-b also absorbs core-2.0. The merge itself doesn't
    // conflict — Btb1 became the merge base via the round-trip ancestry
    // (Mc7b absorbed Btb1'_mono on mono main → propagates back through Bc5).
    // The natural merge takes core-2.0's "project" value, so the project-b
    // operator restamps the identity to "projectB" via commit --amend.
    git("checkout project-b", backend.working);
    mergeRef(backend, "core-2.0", "Btb2");
    fs.writeFileSync(path.join(backend.working, "src/project-name.txt"), "projectB\n");
    git("add -A", backend.working);
    git("commit --amend --no-edit", backend.working);
    const Btb2 = git("rev-parse HEAD", backend.working);
    git("push origin project-b", backend.working);

    // ── Frontend mirror ──────────────────────────────────────────────────
    git("fetch origin", frontend.working);
    git("checkout main", frontend.working);
    const Fc4 = mergeRef(frontend, "origin/shadow/frontend/main", "Fc4");
    git("push origin main", frontend.working);

    git("checkout -b core-2.0 main", frontend.working);
    const Fr2 = mergeRef(frontend, "origin/shadow/frontend/core-2.0", "Fr2");
    git("push origin core-2.0", frontend.working);

    git("checkout project", frontend.working);
    const Ft2 = mergeRef(frontend, "core-2.0", "Ft2");
    git("push origin project", frontend.working);

    git("checkout project-b", frontend.working);
    mergeRef(frontend, "core-2.0", "Ftb2");
    fs.writeFileSync(path.join(frontend.working, "src/project-name.txt"), "projectB\n");
    git("add -A", frontend.working);
    git("commit --amend --no-edit", frontend.working);
    const Ftb2 = git("rev-parse HEAD", frontend.working);
    git("push origin project-b", frontend.working);

    // ── --from b: leaves' new branches + project absorption land on mono ──
    {
      const r = runSync({ from: "b" });
      assertEqual(r.exitCode, 0, `[release] --from b after leaf releases: ${r.stderr.slice(0, 300)}`);
    }
    git("fetch origin", mono.working);

    // Mr1 lives only on mono's core-2.0 — must NOT appear on shadow/backend/main
    // or shadow/frontend/main (release branch is isolated from main).
    assertEqual(findReplay(backend, "origin/shadow/backend/main", "origin", Mr1), null,
      "[release] Mr1 (core-2.0-only) must not appear on backend's shadow/backend/main");
    assertEqual(findReplay(frontend, "origin/shadow/frontend/main", "origin", Mr1), null,
      "[release] Mr1 must not appear on frontend's shadow/frontend/main");

    // core-2.0 shadow refs land on mono carrying the release integration.
    const Br2_mono = findReplayOrFail(mono, "origin/shadow/backend/core-2.0",  "backend",  Br2, "Br2'_mono");
    const Fr2_mono = findReplayOrFail(mono, "origin/shadow/frontend/core-2.0", "frontend", Fr2, "Fr2'_mono");
    assertTip(mono, "origin/shadow/backend/core-2.0",  Br2_mono, "[release] shadow/backend/core-2.0 tip = Br2'_mono");
    assertTip(mono, "origin/shadow/frontend/core-2.0", Fr2_mono, "[release] shadow/frontend/core-2.0 tip = Fr2'_mono");

    // project shadow tips advance with Bt2'_mono / Ft2'_mono (project absorbed release).
    const Bt2_mono = findReplayOrFail(mono, "origin/shadow/backend/project",  "backend",  Bt2, "Bt2'_mono");
    const Ft2_mono = findReplayOrFail(mono, "origin/shadow/frontend/project", "frontend", Ft2, "Ft2'_mono");
    assertTip(mono, "origin/shadow/backend/project",  Bt2_mono, "[release] shadow/backend/project tip = Bt2'_mono");
    assertTip(mono, "origin/shadow/frontend/project", Ft2_mono, "[release] shadow/frontend/project tip = Ft2'_mono");

    // Release content propagated to project: src/release.txt exists on both leaf project branches.
    assertContent(backend,  "project", "src/release.txt", "2.0\n", "[release] backend project has release v2");
    assertContent(frontend, "project", "src/release.txt", "2.0\n", "[release] frontend project has release v2");

    // Fan-out: project-b also got the release.
    assertContent(backend,  "project-b", "src/release.txt", "2.0\n", "[release] backend project-b has release v2 (fan-out)");
    assertContent(frontend, "project-b", "src/release.txt", "2.0\n", "[release] frontend project-b has release v2 (fan-out)");

    // Per-branch identity preserved through the merge dance:
    //   project keeps "project", project-b rewrote back to "projectB", mono main holds "project".
    assertContent(backend,  "project",   "src/project-name.txt", "project\n",  "[release] backend project name = project");
    assertContent(backend,  "project-b", "src/project-name.txt", "projectB\n", "[release] backend project-b rewrote name to projectB after release merge");
    assertContent(frontend, "project",   "src/project-name.txt", "project\n",  "[release] frontend project name = project");
    assertContent(frontend, "project-b", "src/project-name.txt", "projectB\n", "[release] frontend project-b rewrote name to projectB after release merge");
    assertContent(mono,     "main",      "backend/src/project-name.txt",  "project\n", "[release] mono main dropped project-b's name change (kept project)");
    assertContent(mono,     "main",      "frontend/src/project-name.txt", "project\n", "[release] mono main frontend project-name dropped project-b's change");

    // Multi-project discriminator (commit-graph level): each leaf-side merge
    // replays onto ITS OWN shadow ref only. Bt2's replay is on shadow/project;
    // Btb2's is on shadow/project-b. They never conflate.
    // (Tree content overlaps because mono main absorbed both projects via Mc7a/Mc7b
    // and composeMergeBaseTree splices mono's full state — that's by design.)
    const Btb2_mono = findReplayOrFail(mono, "origin/shadow/backend/project-b",  "backend",  Btb2, "Btb2'_mono");
    const Ftb2_mono = findReplayOrFail(mono, "origin/shadow/frontend/project-b", "frontend", Ftb2, "Ftb2'_mono");
    assertTip(mono, "origin/shadow/backend/project-b",  Btb2_mono, "[release] shadow/backend/project-b tip = Btb2'_mono");
    assertTip(mono, "origin/shadow/frontend/project-b", Ftb2_mono, "[release] shadow/frontend/project-b tip = Ftb2'_mono");

    // Cross-branch isolation: Bt2's replay belongs to shadow/project, not shadow/project-b.
    assertEqual(findReplay(mono, "origin/shadow/backend/project-b",  "backend",  Bt2),  null,
      "[release] Bt2 not replayed on shadow/backend/project-b (different branch)");
    assertEqual(findReplay(mono, "origin/shadow/backend/project",    "backend",  Btb2), null,
      "[release] Btb2 not replayed on shadow/backend/project (different branch)");
    assertEqual(findReplay(mono, "origin/shadow/frontend/project-b", "frontend", Ft2),  null,
      "[release] Ft2 not replayed on shadow/frontend/project-b");
    assertEqual(findReplay(mono, "origin/shadow/frontend/project",   "frontend", Ftb2), null,
      "[release] Ftb2 not replayed on shadow/frontend/project");

    // ── Fan-out dedup: Br2 / Fr2 (the release-integration commits on each leaf)
    // sit at core-2.0's tip AND as the 2nd parent of Bt2 and Btb2 (project and
    // project-b absorbed them). After --from b, the engine must produce ONE
    // replay per leaf commit, referenced from multiple shadow refs — not three
    // separate synthetics. Identical SHA across {core-2.0, project, project-b}
    // proves the dedup.
    const Br2_via_core   = findReplay(mono, "origin/shadow/backend/core-2.0",  "backend", Br2);
    const Br2_via_proj   = findReplay(mono, "origin/shadow/backend/project",   "backend", Br2);
    const Br2_via_projb  = findReplay(mono, "origin/shadow/backend/project-b", "backend", Br2);
    assertEqual(Br2_via_core, Br2_via_proj,
      "[release fan-out dedup] Br2 replay on shadow/backend/core-2.0 = replay on shadow/backend/project");
    assertEqual(Br2_via_core, Br2_via_projb,
      "[release fan-out dedup] Br2 replay on shadow/backend/core-2.0 = replay on shadow/backend/project-b");

    const Fr2_via_core  = findReplay(mono, "origin/shadow/frontend/core-2.0",  "frontend", Fr2);
    const Fr2_via_proj  = findReplay(mono, "origin/shadow/frontend/project",   "frontend", Fr2);
    const Fr2_via_projb = findReplay(mono, "origin/shadow/frontend/project-b", "frontend", Fr2);
    assertEqual(Fr2_via_core, Fr2_via_proj,
      "[release fan-out dedup] Fr2 replay deduped across frontend core-2.0 + project");
    assertEqual(Fr2_via_core, Fr2_via_projb,
      "[release fan-out dedup] Fr2 replay deduped across frontend core-2.0 + project-b");

    void Bc5; void Fc4;

    // ── Phase hotfix: bug reported on project — mono fixes, leaves absorb ──
    // mono creates project from Mc0 and absorbs both shadow project refs
    // (Mt1, Mt2 — bringing leaf project state with release v2 from Phase release
    // into the new mono:project branch). mono then branches bug/project/fix off
    // project, applies the be-side fix (Mf1). After --from a each leaf creates
    // its own bug/project/fix off its project tip, merges the shadow bug ref
    // in (Bf1 / Ff1), then merges the bug branch into project (Bt3 / Ft3).
    // Final --from b syncs the project absorption back to mono.
    git(`checkout -b project ${Mc0}`, mono.working);
    const Mt1 = mergeRef(mono, "origin/shadow/backend/project",  "Mt1");
    const Mt2 = mergeRef(mono, "origin/shadow/frontend/project", "Mt2");
    git("push origin project", mono.working);

    git("checkout -b bug/project/fix project", mono.working);
    allow("origin", "bug/project/fix");
    // be-only fix — exercises the asymmetric drop: backend pair keeps it and
    // propagates through to backend project; frontend pair TREESAME-drops it,
    // so frontend project's tree is untouched even though it goes through the
    // same bug-branch dance on the frontend side.
    const Mf1 = commitFiles(mono, { "backend/src/feature.txt": "v3 + bugfix\n" }, "Mf1");
    git("push origin bug/project/fix", mono.working);

    {
      const r = runSync({ from: "a" });
      assertEqual(r.exitCode, 0, `[hotfix] --from a after Mf1: ${r.stderr.slice(0, 300)}`);
    }

    // ── Backend: cut bug branch from project, merge shadow fix, merge into project ──
    git("fetch origin", backend.working);
    git("checkout project", backend.working);
    git("checkout -b bug/project/fix", backend.working);
    allow("backend", "bug/project/fix");
    const Bf1 = mergeRef(backend, "origin/shadow/backend/bug/project/fix", "Bf1");
    git("push origin bug/project/fix", backend.working);
    git("checkout project", backend.working);
    const Bt3 = mergeRef(backend, "bug/project/fix", "Bt3");
    git("push origin project", backend.working);

    // ── Frontend mirror ──────────────────────────────────────────────────
    git("fetch origin", frontend.working);
    git("checkout project", frontend.working);
    git("checkout -b bug/project/fix", frontend.working);
    allow("frontend", "bug/project/fix");
    const Ff1 = mergeRef(frontend, "origin/shadow/frontend/bug/project/fix", "Ff1");
    git("push origin bug/project/fix", frontend.working);
    git("checkout project", frontend.working);
    const Ft3 = mergeRef(frontend, "bug/project/fix", "Ft3");
    git("push origin project", frontend.working);

    {
      const r = runSync({ from: "b" });
      assertEqual(r.exitCode, 0, `[hotfix] --from b after leaf bug merges: ${r.stderr.slice(0, 300)}`);
    }
    git("fetch origin", mono.working);

    // ── Asymmetric outcome: backend project gets the fix; frontend is untouched ──
    // backend: feature.txt changed v3 → v3 + bugfix via Bf1/Bt3.
    assertContent(backend, "project", "src/feature.txt", "v3 + bugfix\n",
      "[hotfix] backend project has the be fix");
    // frontend: component.txt unchanged (Mf1 dropped on fe pair → no fix flowed).
    assertContent(frontend, "project", "src/component.txt", "v2\n",
      "[hotfix] frontend project component.txt unchanged (be-only fix dropped on fe pair)");

    // Mono's shadow ref tips advance: project moves to Bt3'_mono / Ft3'_mono,
    // bug/project/fix shadow refs exist with the integration merges.
    const Bt3_mono = findReplayOrFail(mono, "origin/shadow/backend/project",         "backend",  Bt3, "Bt3'_mono");
    const Ft3_mono = findReplayOrFail(mono, "origin/shadow/frontend/project",        "frontend", Ft3, "Ft3'_mono");
    const Bf1_mono = findReplayOrFail(mono, "origin/shadow/backend/bug/project/fix", "backend",  Bf1, "Bf1'_mono");
    const Ff1_mono = findReplayOrFail(mono, "origin/shadow/frontend/bug/project/fix","frontend", Ff1, "Ff1'_mono");
    assertTip(mono, "origin/shadow/backend/project",          Bt3_mono, "[hotfix] backend project tip = Bt3'_mono");
    assertTip(mono, "origin/shadow/frontend/project",         Ft3_mono, "[hotfix] frontend project tip = Ft3'_mono");
    assertTip(mono, "origin/shadow/backend/bug/project/fix",  Bf1_mono, "[hotfix] backend bug tip = Bf1'_mono");
    assertTip(mono, "origin/shadow/frontend/bug/project/fix", Ff1_mono, "[hotfix] frontend bug tip = Ff1'_mono");

    // Mf1 is be-only → kept on backend pair, dropped on frontend pair.
    findReplayOrFail(backend, "origin/shadow/backend/bug/project/fix", "origin", Mf1, "Mf1'_be");
    assertEqual(findReplay(frontend, "origin/shadow/frontend/bug/project/fix", "origin", Mf1), null,
      "[hotfix] Mf1 (be-only fix) drops on frontend pair");

    void Mt1; void Mt2; void Bf1_mono;

    // ── Phase hotfix-roundtrip: chase the no-op frontend bug branch ───────
    // The frontend pair never saw Mf1, but the operator workflow still cycles
    // the no-op through: mono merges shadow/frontend/bug/project/fix back into
    // its own bug branch (Mf2), --from a propagates, frontend operator merges
    // shadow into bug (Ff2), bug into project (Ft4), --from b syncs. Each
    // merge is tree-equivalent to its first parent — content doesn't shift.
    git("checkout bug/project/fix", mono.working);
    const Mf2 = mergeRef(mono, "origin/shadow/frontend/bug/project/fix", "Mf2");
    git("push origin bug/project/fix", mono.working);
    assertParents(mono, Mf2, [Mf1, Ff1_mono],
      "[hotfix-roundtrip] Mf2 = merge(Mf1, Ff1'_mono)");

    {
      const r = runSync({ from: "a" });
      assertEqual(r.exitCode, 0, `[hotfix-roundtrip] --from a after Mf2: ${r.stderr.slice(0, 300)}`);
    }

    // Frontend operator: pulls updated shadow, merges into bug, then bug into project.
    git("fetch origin", frontend.working);
    git("checkout bug/project/fix", frontend.working);
    const Ff2 = mergeRef(frontend, "origin/shadow/frontend/bug/project/fix", "Ff2");
    git("push origin bug/project/fix", frontend.working);
    git("checkout project", frontend.working);
    const Ft4 = mergeRef(frontend, "bug/project/fix", "Ft4");
    git("push origin project", frontend.working);

    {
      const r = runSync({ from: "b" });
      assertEqual(r.exitCode, 0, `[hotfix-roundtrip] --from b after Ff2/Ft4: ${r.stderr.slice(0, 300)}`);
    }
    git("fetch origin", mono.working);

    // Branch existence at the end of the round-trip.
    assertRefExists(mono,     "refs/heads/bug/project/fix",
      "[hotfix-roundtrip] mono bug/project/fix still present");
    assertRefExists(backend,  "refs/heads/bug/project/fix",
      "[hotfix-roundtrip] backend bug/project/fix still present");
    assertRefExists(frontend, "refs/heads/bug/project/fix",
      "[hotfix-roundtrip] frontend bug/project/fix still present");
    assertRefExists(mono, "refs/remotes/origin/shadow/frontend/bug/project/fix",
      "[hotfix-roundtrip] mono shadow/frontend/bug/project/fix still present");

    // One frontend assertion is enough — the entire no-op chain must NOT have
    // shifted component.txt off "v2\n". (Backend still has its fix from Bt3;
    // nothing in this phase touches backend.)
    assertContent(frontend, "project", "src/component.txt", "v2\n",
      "[hotfix-roundtrip] frontend project component.txt still v2 after the no-op chain");

    void Mf2; void Ff2; void Ft4;

    // ── Phase halt-recovery: divergent merge halts engine; operator-driven recovery ──
    // Two mono feature branches with both outer (README) and inner (backend slice)
    // divergence. Backend absorbs each, merges them locally with manual resolution
    // → Bm. --from b HALTS because the engine can't auto-resolve outer when
    // composing Bm's projected merge base. Operator mirrors the merge on mono with
    // byte-identical inner resolution → Mm. After --from a + backend merging the
    // new shadow tip → R_be, --from b succeeds and produces a squash replay
    // carrying BOTH Bm and R_be trailers (multi-trailer encoding).
    git("checkout main", mono.working);
    git("checkout -b feature/conflict-a main", mono.working);
    allow("origin", "feature/conflict-a");
    const Mca = commitFiles(mono, {
      "README.md": "# Monorepo (conflict-a)\n",
      "backend/src/conflict.txt": "value a\n",
    }, "Mca");
    git("push origin feature/conflict-a", mono.working);

    git("checkout main", mono.working);
    git("checkout -b feature/conflict-b main", mono.working);
    allow("origin", "feature/conflict-b");
    const Mcb = commitFiles(mono, {
      "README.md": "# Monorepo (conflict-b)\n",
      "backend/src/conflict.txt": "value b\n",
    }, "Mcb");
    git("push origin feature/conflict-b", mono.working);
    void Mca; void Mcb;

    {
      const r = runSync({ from: "a" });
      assertEqual(r.exitCode, 0, `[halt-recovery] --from a propagates conflict branches: ${r.stderr.slice(0, 300)}`);
    }

    // Backend operators absorb each branch's shadow.
    git("fetch origin", backend.working);
    git("checkout main", backend.working);
    git("checkout -b feature/conflict-a main", backend.working);
    allow("backend", "feature/conflict-a");
    mergeRef(backend, "origin/shadow/backend/feature/conflict-a", "Bca");
    git("push origin feature/conflict-a", backend.working);

    git("checkout -b feature/conflict-b main", backend.working);
    allow("backend", "feature/conflict-b");
    mergeRef(backend, "origin/shadow/backend/feature/conflict-b", "Bcb");
    git("push origin feature/conflict-b", backend.working);

    // Backend merges conflict-b into conflict-a — conflict on src/conflict.txt, resolved manually.
    git("checkout feature/conflict-a", backend.working);
    let Bm: string;
    try {
      Bm = mergeRef(backend, "feature/conflict-b", "Bm");
    } catch {
      fs.writeFileSync(path.join(backend.working, "src/conflict.txt"), "value a + value b\n");
      git("add -A", backend.working);
      git("commit --no-edit", backend.working);
      Bm = git("rev-parse HEAD", backend.working);
    }
    git("push origin feature/conflict-a", backend.working);

    // Linear commit AFTER Bm on backend's feature/conflict-a. Bn1 inherits the halt
    // via the all-parents-halted+unmapped rule (its only source parent is the
    // halted Bm). The recovery squash must absorb BOTH Bm and Bn1 via multi-trailer
    // encoding, with Bn1's content (post-halt.txt) preserved in the shadow tip's tree.
    const Bn1 = commitFiles(backend, { "src/post-halt.txt": "post halt\n" }, "Bn1");
    git("push origin feature/conflict-a", backend.working);

    // --from b HALTS — engine can't auto-resolve outer; both Bm and Bn1 are halted.
    {
      const r = runSync({ from: "b" });
      if (r.exitCode === 0) throw new Error("[halt-recovery] --from b expected to halt on Bm but succeeded");
      const errText = r.stdout + "\n" + r.stderr;
      if (!/cannot auto-resolve replay parent tree/.test(errText)) {
        throw new Error(`[halt-recovery] expected halt diagnostic, got:\n${errText.slice(0, 500)}`);
      }
    }

    // Operator-driven recovery: mirror the merge on mono with byte-identical inner resolution.
    git("checkout feature/conflict-a", mono.working);
    let Mm: string;
    try {
      Mm = mergeRef(mono, "feature/conflict-b", "Mm");
    } catch {
      fs.writeFileSync(path.join(mono.working, "README.md"), "# Monorepo (merged)\n");
      fs.writeFileSync(path.join(mono.working, "backend/src/conflict.txt"), "value a + value b\n");
      git("add -A", mono.working);
      git("commit --no-edit", mono.working);
      Mm = git("rev-parse HEAD", mono.working);
    }
    git("push origin feature/conflict-a", mono.working);
    void Mm;

    // --from a propagates Mm onto backend's shadow.
    {
      const r = runSync({ from: "a" });
      assertEqual(r.exitCode, 0, `[halt-recovery] --from a after Mm: ${r.stderr.slice(0, 300)}`);
    }

    // Backend dev merges the new shadow tip into feature/conflict-a → R_be.
    git("fetch origin", backend.working);
    git("checkout feature/conflict-a", backend.working);
    const R_be = mergeRef(backend, "origin/shadow/backend/feature/conflict-a", "R_be");
    git("push origin feature/conflict-a", backend.working);

    // --from b succeeds: engine emits a squash replay carrying both Bm + R_be trailers.
    {
      const r = runSync({ from: "b" });
      assertEqual(r.exitCode, 0, `[halt-recovery] --from b post-recovery: ${r.stderr.slice(0, 400)}`);
    }

    // Verify the squash on mono's shadow ref encodes both the halted-Bm and the
    // recovery R_be trailers, and carries the operator's resolution content.
    git("fetch origin", mono.working);
    const sq = git("rev-parse origin/shadow/backend/feature/conflict-a", mono.working);
    const sqMsg = execSync(`git log -1 --format=%B ${sq}`, {
      cwd: mono.working, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    });
    if (!sqMsg.includes(`Shadow-replayed-backend-backend: ${Bm}`)) {
      throw new Error(`[halt-recovery] squash missing absorbed-Bm trailer for ${Bm}\nmsg:\n${sqMsg.slice(0, 800)}`);
    }
    if (!sqMsg.includes(`Shadow-replayed-backend-backend: ${Bn1}`)) {
      throw new Error(`[halt-recovery] squash missing absorbed-Bn1 trailer for ${Bn1}\nmsg:\n${sqMsg.slice(0, 800)}`);
    }
    if (!sqMsg.includes(`Shadow-replayed-backend-backend: ${R_be}`)) {
      throw new Error(`[halt-recovery] squash missing R_be trailer for ${R_be}\nmsg:\n${sqMsg.slice(0, 800)}`);
    }
    assertContent(mono, "origin/shadow/backend/feature/conflict-a", "backend/src/conflict.txt", "value a + value b\n",
      "[halt-recovery] squash carries the agreed inner resolution");
    assertContent(mono, "origin/shadow/backend/feature/conflict-a", "README.md", "# Monorepo (merged)\n",
      "[halt-recovery] squash carries operator's outer resolution");
    assertContent(mono, "origin/shadow/backend/feature/conflict-a", "backend/src/post-halt.txt", "post halt\n",
      "[halt-recovery] squash preserves Bn1's post-halt content");

  } finally {
    setBranchFiltersForTesting(null);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export default async function run(): Promise<void> {
  await runScenario();
}

if (require.main === module) {
  run().then(() => console.log("PASS  test-scenario")).catch(err => { console.error(err); process.exit(1); });
}
