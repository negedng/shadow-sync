/**
 * test-scenario.ts — full scenario.md walkthrough (sht5 + sht6 + sht7 + sht8).
 *
 * Each scenario is a self-contained function; default export runs all four sequentially.
 *   sht5 (runSht5) — main multi-pair scenario with multi-branch fan-in/out.
 *   sht6 (runSht6) — dedicated common-pair mechanism + B′ recovery on project branches.
 *   sht7 (runSht7) — B′ composed-squash on a single backend pair (5 sub-tests).
 *   sht8 (runSht8) — branch-filter behavior: orphan filtered branches stay absent;
 *                    filtered branches later merged into allowed branches leak their
 *                    commits via merge reachability, but never get a shadow ref of
 *                    their own. Both --from b and --from a directions.
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
  // Force initial branch to "main" for working clone too.
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

/** Find a shadow replay by its trailer. Returns the replay SHA or null.
 *  Pair name is parsed from branchRef ("<remote>/shadow/<pair>/<branch>"). */
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

function readAtRef(repo: Repo, ref: string, path: string): string {
  const raw = execSync(`git show ${ref}:${path}`, {
    cwd: repo.working, encoding: "utf8", maxBuffer: 50 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"],
  });
  return raw.replace(/\r\n/g, "\n");
}

/** Assert the full tree at `ref` matches the expected file → content map exactly (no extra paths, no missing paths). */
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

/** Mono-shaped tree: outer (root files) + backend/<be> + frontend/<fe>. */
function monoTree(outer: Record<string, string>, be: Record<string, string>, fe: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = { ...outer };
  for (const [k, v] of Object.entries(be)) result[`backend/${k}`] = v;
  for (const [k, v] of Object.entries(fe)) result[`frontend/${k}`] = v;
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

// ── Predicted file content constants ─────────────────────────────────────────
// Backend repo trees (no prefix — bare backend layout)
const BE_BC0 = { "src/init.txt": "init\n" };
const BE_BC1 = { "src/init.txt": "init\n", "src/feature.txt": "v1\n" };
const BE_BC2 = { "src/init.txt": "init\n", "src/feature.txt": "v2\n" };
const BE_BR1 = { "src/init.txt": "init\n", "src/feature.txt": "v1\n", "src/release.txt": "1.0\n" };
const BE_BT1 = { "src/init.txt": "init\n", "src/feature.txt": "v1\n", "src/release.txt": "1.0\n", "src/project.txt": "proj v1\n" };
// Mc4-era be (Bc2 + shared) — what Bc3 absorbs from shadow/backend/main
const BE_MC4 = { "src/init.txt": "init\n", "src/feature.txt": "v2\n", "src/shared.txt": "shared be\n" };
const BE_BC3 = BE_MC4;  // merge(Bc2, Mc4'_be) → Mc4'_be tree (descendant)
// Mc6-era be (Mc5 backend = Mc4 ∪ Bt1)
const BE_MC6 = { "src/init.txt": "init\n", "src/feature.txt": "v2\n", "src/shared.txt": "shared be\n", "src/release.txt": "1.0\n", "src/project.txt": "proj v1\n" };
const BE_BC4 = BE_MC6;  // merge(Bc3, Mc6'_be) → Mc6'_be tree
// Mr1-era be (Mc6 be + release v2)
const BE_MR1 = { "src/init.txt": "init\n", "src/feature.txt": "v2\n", "src/shared.txt": "shared be\n", "src/release.txt": "2.0\n", "src/project.txt": "proj v1\n" };
const BE_BR2 = BE_MR1;  // merge(Bc4, Mr1'_be)
const BE_BT2 = BE_MR1;  // merge(Bt1, Br2) → Br2's content (Bt1 subset)
// Mf1-era be (Mr1 + bugfix)
const BE_MF1 = { "src/init.txt": "init\n", "src/feature.txt": "v2 + bugfix\n", "src/shared.txt": "shared be\n", "src/release.txt": "2.0\n", "src/project.txt": "proj v1\n" };
const BE_BF1 = BE_MF1;
const BE_BT3 = BE_MF1;

// Frontend repo trees
const FE_FC0 = { "src/init.txt": "init\n" };
const FE_FC1 = { "src/init.txt": "init\n", "src/component.txt": "v1\n" };
const FE_FC2 = { "src/init.txt": "init\n", "src/component.txt": "v2\n" };
const FE_FR1 = { "src/init.txt": "init\n", "src/component.txt": "v1\n", "src/release.txt": "1.0\n" };
const FE_FT1 = { "src/init.txt": "init\n", "src/component.txt": "v1\n", "src/release.txt": "1.0\n", "src/project.txt": "proj v1\n" };
// Mc3-era fe (Fc2 + feature-flag)
const FE_MC3 = { "src/init.txt": "init\n", "src/component.txt": "v2\n", "src/feature-flag.txt": "flag\n" };
// Mc4-era fe (Mc3 + shared)
const FE_MC4 = { "src/init.txt": "init\n", "src/component.txt": "v2\n", "src/feature-flag.txt": "flag\n", "src/shared.txt": "shared fe\n" };
const FE_FC3 = FE_MC4;  // merge(Fc2, Mc4'_fe)
// Mc6-era fe (Mc4 fe + Ft1 = adds release+project)
const FE_MC6 = { "src/init.txt": "init\n", "src/component.txt": "v2\n", "src/feature-flag.txt": "flag\n", "src/shared.txt": "shared fe\n", "src/release.txt": "1.0\n", "src/project.txt": "proj v1\n" };
const FE_FC4 = FE_MC6;
// Mr1-era fe (Mc6 fe + release v2)
const FE_MR1 = { "src/init.txt": "init\n", "src/component.txt": "v2\n", "src/feature-flag.txt": "flag\n", "src/shared.txt": "shared fe\n", "src/release.txt": "2.0\n", "src/project.txt": "proj v1\n" };
const FE_FR2 = FE_MR1;
const FE_FT2 = FE_MR1;  // merge(Ft1, Fr2) → Fr2 content (Ft1 subset)

// Outer (root files on monorepo)
const OUTER_MC0 = { ".claude/settings.json": "{}\n", "README.md": "# Monorepo\n" };
const OUTER_MC4 = { ".claude/settings.json": "{}\n", "README.md": "# Monorepo (Mc4)\n" };

const EMPTY: Record<string, string> = {};

// ── sht5: full multi-pair scenario ──────────────────────────────────────────
function runSht5() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-test-scenario-"));

  try {
    const backend  = createRepo(tmpDir, "backend",  { email: "bea@example.com",  name: "Bea"  });
    const frontend = createRepo(tmpDir, "frontend", { email: "fred@example.com", name: "Fred" });
    const mono     = createRepo(tmpDir, "mono",     { email: "mira@example.com", name: "Mira" });

    // Mono's working clone has cross-remotes for the orchestrator.
    git(`remote add backend "${backend.bare}"`, mono.working);
    git(`remote add frontend "${frontend.bare}"`, mono.working);

    // ── Phase 1: Mature backend (lines 2–11) ──────────────────────────────
    const Bc0 = commitFiles(backend, { "src/init.txt": "init\n" }, "Bc0");
    const Bc1 = commitFiles(backend, { "src/feature.txt": "v1\n" }, "Bc1");
    git("push origin main", backend.working);

    git("checkout -b core-1.0", backend.working);
    const Br1 = commitFiles(backend, { "src/release.txt": "1.0\n" }, "Br1");
    git("push origin core-1.0", backend.working);

    git("checkout main", backend.working);
    const Bc2 = commitFiles(backend, { "src/feature.txt": "v2\n" }, "Bc2");
    git("push origin main", backend.working);

    git("checkout -b project core-1.0", backend.working);
    const Bt1 = commitFiles(backend, { "src/project.txt": "proj v1\n" }, "Bt1");
    git("push origin project", backend.working);
    git("checkout main", backend.working);

    // ── Phase 2: Mature frontend (lines 12–21) ────────────────────────────
    const Fc0 = commitFiles(frontend, { "src/init.txt": "init\n" }, "Fc0");
    const Fc1 = commitFiles(frontend, { "src/component.txt": "v1\n" }, "Fc1");
    git("push origin main", frontend.working);

    git("checkout -b core-1.0", frontend.working);
    const Fr1 = commitFiles(frontend, { "src/release.txt": "1.0\n" }, "Fr1");
    git("push origin core-1.0", frontend.working);

    git("checkout main", frontend.working);
    const Fc2 = commitFiles(frontend, { "src/component.txt": "v2\n" }, "Fc2");
    git("push origin main", frontend.working);

    git("checkout -b project core-1.0", frontend.working);
    const Ft1 = commitFiles(frontend, { "src/project.txt": "proj v1\n" }, "Ft1");
    git("push origin project", frontend.working);
    git("checkout main", frontend.working);

    // ── Phase 3: Init monorepo (lines 22–24) ──────────────────────────────
    // Mc0: README.md + .claude/ at root (monorepo-only content).
    const Mc0 = commitFiles(mono, {
      "README.md": "# Monorepo\n",
      ".claude/settings.json": "{}\n",
    }, "Mc0");
    git("push origin main", mono.working);
    git("checkout -b project", mono.working);
    git("push origin project", mono.working);
    git("checkout main", mono.working);

    // Configure orchestrator (runs from mono.working).
    applyTestOverrides({
      repoRoot: mono.working,
      pairs: [
        { name: "backend",  a: { remote: "origin", url: mono.bare, dir: "backend"  }, b: { remote: "backend",  url: backend.bare,  dir: "" } },
        { name: "frontend", a: { remote: "origin", url: mono.bare, dir: "frontend" }, b: { remote: "frontend", url: frontend.bare, dir: "" } },
      ],
      shadowBranchPrefix: "shadow",
    });

    // Branch allowlist — the engine fails closed without one. Patterns are
    // added by literal name (or `core-*` glob, which also exercises the
    // pattern compiler) as the scenario creates each branch. See the
    // allow() calls scattered through the phases below.
    const allowed: Map<string, string[]> = new Map([
      ["origin",   ["main", "project"]],            // Phase 3 created project on mono
      ["backend",  ["main", "core-*", "project"]],  // Phase 1 created core-1.0 + project on backend
      ["frontend", ["main", "core-*", "project"]],  // Phase 2 created core-1.0 + project on frontend
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

    // ── Phase 4: First sync --from b (line 26) ────────────────────────────
    {
      const r = runSync({ from: "b" });
      assertEqual(r.exitCode, 0, `[line 26] --from b: ${r.stderr.slice(0, 300)}`);
    }

    // ── Phase 5: Mc1, Mc2, Mc3 (frontend-only), Mc4 (lines 27–30) ─────────
    git("fetch origin", mono.working);
    const Mc1 = mergeRef(mono, "origin/shadow/backend/main",  "Mc1");
    const Mc2 = mergeRef(mono, "origin/shadow/frontend/main", "Mc2");
    // Mc3: frontend-only single-parent commit. Tests TREESAME-drop on backend pair.
    const Mc3 = commitFiles(mono, {
      "frontend/src/feature-flag.txt": "flag\n",
    }, "Mc3");
    // Mc4: cross-cutting (be/, fe/, root) — was the old Mc3.
    const Mc4 = commitFiles(mono, {
      "backend/src/shared.txt":  "shared be\n",
      "frontend/src/shared.txt": "shared fe\n",
      "README.md":               "# Monorepo (Mc4)\n",
    }, "Mc4");
    git("push origin main", mono.working);

    // ── Phase 6: sync --from a (line 31) ──────────────────────────────────
    {
      const r = runSync({ from: "a" });
      assertEqual(r.exitCode, 0, `[line 31] --from a: ${r.stderr.slice(0, 300)}`);
    }

    // ── Mid-assert (line 32): Mc3 (single-parent, frontend-only) drop ─────
    git("fetch origin", backend.working);
    git("fetch origin", frontend.working);
    assertEqual(
      findReplay(backend, "origin/shadow/backend/main", "origin", Mc3), null,
      "[line 32] Mc3 (single-parent fe-only) MUST NOT appear on backend's shadow",
    );
    if (!findReplay(frontend, "origin/shadow/frontend/main", "origin", Mc3)) {
      throw new Error("[line 32] Mc3 SHOULD appear on frontend's shadow (fe content present)");
    }

    // ── Phase 7: Bc3, Fc3 (lines 32–33) ───────────────────────────────────
    const Bc3 = mergeRef(backend, "origin/shadow/backend/main", "Bc3");
    git("push origin main", backend.working);

    const Fc3 = mergeRef(frontend, "origin/shadow/frontend/main", "Fc3");
    git("push origin main", frontend.working);

    // ── Phase 8: sync --from b (line 34) ──────────────────────────────────
    {
      const r = runSync({ from: "b" });
      assertEqual(r.exitCode, 0, `[line 34] --from b: ${r.stderr.slice(0, 300)}`);
    }

    // ── Phase 9: Mt1 (lines 35–36) ────────────────────────────────────────
    git("fetch origin", mono.working);
    git("checkout project", mono.working);
    const Mt1 = mergeRef(mono, "origin/shadow/backend/project", "Mt1");
    git("push origin project", mono.working);

    // ── Mid-assert (line 37): pair isolation ──────────────────────────────
    git("fetch origin", backend.working);
    const beShadowLog = git("log origin/shadow/backend/main --format=%H%n%B", backend.working);
    assertEqual(beShadowLog.includes(Fc2), false, "[line 37] shadow/backend/main must not reference Fc2");
    assertEqual(beShadowLog.includes(Fc3), false, "[line 37] shadow/backend/main must not reference Fc3");

    git("fetch origin", frontend.working);
    const feShadowLog = git("log origin/shadow/frontend/main --format=%H%n%B", frontend.working);
    assertEqual(feShadowLog.includes(Bc2), false, "[line 37] shadow/frontend/main must not reference Bc2");
    assertEqual(feShadowLog.includes(Bc3), false, "[line 37] shadow/frontend/main must not reference Bc3");

    // ── Phase 10: Mc5, Mc6, core-2.0, Mr1 (lines 38–42) ──────────────────
    git("checkout main", mono.working);
    git("fetch origin", mono.working);
    const Mc5 = mergeRef(mono, "origin/shadow/backend/project",  "Mc5");
    const Mc6 = mergeRef(mono, "origin/shadow/frontend/project", "Mc6");
    git("push origin main", mono.working);
    git("checkout -b core-2.0", mono.working);
    allow("origin", "core-*");
    const Mr1 = commitFiles(mono, {
      "backend/src/release.txt":  "2.0\n",
      "frontend/src/release.txt": "2.0\n",
    }, "Mr1");
    git("push origin core-2.0", mono.working);

    // ── Phase 11: sync --from a (line 43) ─────────────────────────────────
    git("checkout main", mono.working);
    {
      const r = runSync({ from: "a" });
      assertEqual(r.exitCode, 0, `[line 43] --from a: ${r.stderr.slice(0, 300)}`);
    }

    // ── Phase 12: backend-side Bc4, Br2, Bt2 (lines 44–48) ────────────────
    git("fetch origin", backend.working);
    git("checkout main", backend.working);
    const Bc4 = mergeRef(backend, "origin/shadow/backend/main", "Bc4");
    git("push origin main", backend.working);
    git("checkout -b core-2.0", backend.working);
    const Br2 = mergeRef(backend, "origin/shadow/backend/core-2.0", "Br2");
    git("push origin core-2.0", backend.working);
    git("checkout project", backend.working);
    const Bt2 = mergeRef(backend, "core-2.0", "Bt2");
    git("push origin project", backend.working);

    // ── Phase 12b: frontend-side Fc4, Fr2, Ft2 (lines 49–53) ──────────────
    git("fetch origin", frontend.working);
    git("checkout main", frontend.working);
    const Fc4 = mergeRef(frontend, "origin/shadow/frontend/main", "Fc4");
    git("push origin main", frontend.working);
    git("checkout -b core-2.0", frontend.working);
    const Fr2 = mergeRef(frontend, "origin/shadow/frontend/core-2.0", "Fr2");
    git("push origin core-2.0", frontend.working);
    git("checkout project", frontend.working);
    const Ft2 = mergeRef(frontend, "core-2.0", "Ft2");
    git("push origin project", frontend.working);

    // ── Phase 13: sync --from b (line 54) ─────────────────────────────────
    {
      const r = runSync({ from: "b" });
      assertEqual(r.exitCode, 0, `[line 54] --from b: ${r.stderr.slice(0, 300)}`);
    }

    // ── Mid-assert (line 55): all expected shadow refs exist on mono ──────
    git("fetch origin", mono.working);
    for (const ref of [
      "origin/shadow/backend/main",
      "origin/shadow/backend/core-1.0",
      "origin/shadow/backend/core-2.0",
      "origin/shadow/backend/project",
      "origin/shadow/frontend/main",
      "origin/shadow/frontend/core-1.0",
      "origin/shadow/frontend/core-2.0",
      "origin/shadow/frontend/project",
    ]) {
      assertRefExists(mono, ref, `[line 55] mono ${ref}`);
    }

    // ── Phase 14: Mt2, Mt3, bug branch, Mf1 (lines 56–60) ────────────────
    git("checkout project", mono.working);
    const Mt2 = mergeRef(mono, "origin/shadow/backend/project",  "Mt2");
    const Mt3 = mergeRef(mono, "origin/shadow/frontend/project", "Mt3");

    // The Mt3 merge regression: shadow/frontend/project on monorepo has only frontend/* (engine's
    // composeCrossRepoMergeTree didn't preserve backend through Ft2 = merge(Ft1, Fr2) because
    // neither parent had the skip-trailer key — Fr2 is a local frontend merge with no trailer).
    // Merge base of Mt2 and Ft2'_mono is Mr1 (which has both pair trees), so 3-way merge sees
    // "Mt2 deleted frontend, Ft2'_mono deleted backend" and applies BOTH deletions, leaving the
    // project tree with only root files. This assertion will start failing once the engine bug
    // is fixed (and the Mt3 tree retains both pair trees as it should).
    assertTreeHas(mono, Mt3, "backend/src/init.txt",
      "Mt3 should preserve backend/* (currently fails: Mt3 tree has only root files because shadow/frontend/project lost backend through Ft2'_mono's compose)");
    assertTreeHas(mono, Mt3, "frontend/src/init.txt",
      "Mt3 should preserve frontend/*");

    git("push origin project", mono.working);
    git("checkout -b bug/core-2.0/fix", mono.working);
    allow("origin", "bug/core-2.0/fix");
    const Mf1 = commitFiles(mono, { "backend/src/feature.txt": "v2 + bugfix\n" }, "Mf1");
    git("push origin bug/core-2.0/fix", mono.working);

    // ── Phase 15: sync --from a (line 61) ─────────────────────────────────
    git("checkout main", mono.working);
    {
      const r = runSync({ from: "a" });
      if (r.exitCode !== 0) {
        console.error("STDOUT:\n" + r.stdout);
        console.error("STDERR:\n" + r.stderr);
      }
      assertEqual(r.exitCode, 0, `[line 61] --from a`);
    }

    // ── Phase 16: Bf1, Bt3 (lines 62–65) ──────────────────────────────────
    git("fetch origin", backend.working);
    git("checkout project", backend.working);
    git("checkout -b bug/core-2.0/fix", backend.working);
    allow("backend", "bug/core-2.0/fix");
    const Bf1 = mergeRef(backend, "origin/shadow/backend/bug/core-2.0/fix", "Bf1");
    git("push origin bug/core-2.0/fix", backend.working);
    git("checkout project", backend.working);
    const Bt3 = mergeRef(backend, "bug/core-2.0/fix", "Bt3");
    git("push origin project", backend.working);

    // ── Phase 17: sync --from b (line 66) ─────────────────────────────────
    {
      const r = runSync({ from: "b" });
      assertEqual(r.exitCode, 0, `[line 66] --from b: ${r.stderr.slice(0, 300)}`);
    }

    // ── Phase 18: Multi-project — projectB parallel to project (scenario.md) ──
    git("checkout core-1.0", backend.working);
    git("checkout -b projectB", backend.working);
    allow("backend", "projectB");
    const BtB1 = commitFiles(backend, { "src/projectB.txt": "projB v1\n" }, "BtB1");
    git("push origin projectB", backend.working);
    git("checkout main", backend.working);

    git("checkout core-1.0", frontend.working);
    git("checkout -b projectB", frontend.working);
    allow("frontend", "projectB");
    const FtB1 = commitFiles(frontend, { "src/projectB.txt": "projB v1\n" }, "FtB1");
    git("push origin projectB", frontend.working);
    git("checkout main", frontend.working);

    {
      const r = runSync({ from: "b" });
      assertEqual(r.exitCode, 0, `[Phase 18 --from b after projectB creation]: ${r.stderr.slice(0, 300)}`);
    }

    git("fetch origin", mono.working);
    git("checkout -b projectB origin/shadow/backend/projectB", mono.working);
    allow("origin", "projectB");
    // Reset projectB tip to Mc0 (we want it to fork from Mc0, not from BtB1'_mono).
    git(`reset --hard ${Mc0}`, mono.working);
    const MtB1 = mergeRef(mono, "origin/shadow/backend/projectB",  "MtB1");
    const MtB2 = mergeRef(mono, "origin/shadow/frontend/projectB", "MtB2");
    git("push origin projectB", mono.working);
    git("checkout main", mono.working);

    {
      const r = runSync({ from: "a" });
      assertEqual(r.exitCode, 0, `[Phase 18 --from a after MtB1/MtB2]: ${r.stderr.slice(0, 300)}`);
    }

    // ── Phase 19: Fanout — feature/fanout merged into main, project, projectB ──
    git("checkout main", backend.working);
    git("checkout -b feature/fanout", backend.working);
    allow("backend", "feature/fanout");
    const BfX1 = commitFiles(backend, { "src/fanout.txt": "fanout v1\n" }, "BfX1");
    git("push origin feature/fanout", backend.working);

    git("checkout main", backend.working);
    const Bc5 = mergeRef(backend, "feature/fanout", "Bc5");
    git("push origin main", backend.working);
    git("checkout project", backend.working);
    const Bt4 = mergeRef(backend, "feature/fanout", "Bt4");
    git("push origin project", backend.working);
    git("checkout projectB", backend.working);
    const BtB2 = mergeRef(backend, "feature/fanout", "BtB2");
    git("push origin projectB", backend.working);

    {
      const r = runSync({ from: "b" });
      assertEqual(r.exitCode, 0, `[Phase 19 --from b after fanout]: ${r.stderr.slice(0, 300)}`);
    }

    // ──────────────────────────────────────────────────────────────────────
    // Final assertions: parents of every named commit + branch tips
    // ──────────────────────────────────────────────────────────────────────

    git("fetch origin", backend.working);
    git("fetch origin", frontend.working);
    git("fetch origin", mono.working);

    // ── Backend named commits ──────────────────────────────────────────────
    assertParents(backend, Bc0, [],          "Bc0 = init");
    assertParents(backend, Bc1, [Bc0],       "Bc1 parents");
    assertParents(backend, Br1, [Bc1],       "Br1 parents");
    assertParents(backend, Bc2, [Bc1],       "Bc2 parents");
    assertParents(backend, Bt1, [Br1],       "Bt1 parents");

    // Bc3's 2nd parent = Mc4'_be (the cross-cutting commit's replay; Mc3 fe-only is dropped on backend).
    const Mc4_be = findReplayOrFail(backend, "origin/shadow/backend/main", "origin", Mc4, "Mc4'_be");
    assertParents(backend, Bc3, [Bc2, Mc4_be], "Bc3 = merge(Bc2, Mc4'_be)");

    // Bc4's 2nd parent = Mc5'_be (the latest same-pair kept synthetic on backend's shadow).
    // Mc6 (mono's merge of shadow/frontend/project — cross-pair only) drops under the
    // same-pair discriminator, so backend's shadow tip after Phase 11 sync stays at Mc5'_be.
    assertEqual(findReplay(backend, "origin/shadow/backend/main", "origin", Mc6), null,
      "Mc6 (cross-pair-only merge) must not appear on backend's shadow");
    const Mc5_be_tip = findReplayOrFail(backend, "origin/shadow/backend/main", "origin", Mc5, "Mc5'_be");
    assertParents(backend, Bc4, [Bc3, Mc5_be_tip], "Bc4 = merge(Bc3, Mc5'_be)");

    const Mr1_be = findReplayOrFail(backend, "origin/shadow/backend/core-2.0", "origin", Mr1, "Mr1'_be");
    assertParents(backend, Br2, [Bc4, Mr1_be], "Br2 = merge(Bc4, Mr1'_be)");

    assertParents(backend, Bt2, [Bt1, Br2], "Bt2 = merge(Bt1, Br2)");

    const Mf1_be = findReplayOrFail(backend, "origin/shadow/backend/bug/core-2.0/fix", "origin", Mf1, "Mf1'_be");
    assertParents(backend, Bf1, [Bt2, Mf1_be], "Bf1 = merge(Bt2, Mf1'_be)");

    assertParents(backend, Bt3, [Bt2, Bf1], "Bt3 = merge(Bt2, Bf1)");

    // Backend working branches at end (tips advance through Phase 18/19; see Phase 19 assertions for projectB/Bt4/Bc5)
    assertTip(backend, "core-1.0",          Br1, "backend/core-1.0 = Br1");
    assertTip(backend, "core-2.0",          Br2, "backend/core-2.0 = Br2");
    assertTip(backend, "bug/core-2.0/fix",  Bf1, "backend/bug/core-2.0/fix = Bf1");
    // Phase 19 advances main → Bc5, project → Bt4, projectB → BtB2 — asserted below.

    // Backend shadow tips: shadow/backend/main → Mc5'_be (Mc6's cross-pair merge drops);
    // shadow/backend/core-2.0 → Mr1'_be.
    assertTip(backend, "origin/shadow/backend/main",     Mc5_be_tip, "shadow/backend/main → Mc5'_be");
    assertTip(backend, "origin/shadow/backend/core-2.0", Mr1_be, "shadow/backend/core-2.0 → Mr1'_be");
    assertRefAbsent(backend, "origin/shadow/backend/core-1.0", "no shadow/backend/core-1.0 on backend (mono never had core-1.0)");

    // Backend shadow: Mc1 (same-pair merge), Mc5 (same-pair merge), Mt1 (same-pair merge) are kept.
    // Mc2 (cross-pair-only merge) drops under the same-pair discriminator.
    findReplayOrFail(backend, "origin/shadow/backend/main",    "origin", Mc1, "Mc1'_be");
    assertEqual(findReplay(backend, "origin/shadow/backend/main", "origin", Mc2), null,
      "Mc2 (cross-pair-only merge) must not appear on backend's shadow");
    findReplayOrFail(backend, "origin/shadow/backend/main",    "origin", Mc5, "Mc5'_be");
    findReplayOrFail(backend, "origin/shadow/backend/project", "origin", Mt1, "Mt1'_be");

    // Mc3 (single-parent, fe-only) is dropped (single-parent TREESAME on be/).
    assertEqual(findReplay(backend, "origin/shadow/backend/main", "origin", Mc3), null,
      "Mc3 (single-parent fe-only) must not appear on backend's shadow");
    // Mt3 (merge, all-TREESAME on be/ thanks to merge-tree splice) is dropped.
    assertEqual(findReplay(backend, "origin/shadow/backend/project", "origin", Mt3), null,
      "Mt3 (merge, all-TREESAME on be/) must not appear on backend's shadow");

    // ── Frontend named commits ────────────────────────────────────────────
    assertParents(frontend, Fc0, [],         "Fc0 = init");
    assertParents(frontend, Fc1, [Fc0],      "Fc1 parents");
    assertParents(frontend, Fr1, [Fc1],      "Fr1 parents");
    assertParents(frontend, Fc2, [Fc1],      "Fc2 parents");
    assertParents(frontend, Ft1, [Fr1],      "Ft1 parents");

    // Fc3's 2nd parent = Mc4'_fe (after line 31 sync, monorepo's main = Mc4 → mapped).
    const Mc4_fe = findReplayOrFail(frontend, "origin/shadow/frontend/main", "origin", Mc4, "Mc4'_fe");
    assertParents(frontend, Fc3, [Fc2, Mc4_fe], "Fc3 = merge(Fc2, Mc4'_fe)");

    // Fc4's 2nd parent = Mc6'_fe (monorepo's main = Mc6 after line 43 sync).
    const Mc6_fe = findReplayOrFail(frontend, "origin/shadow/frontend/main", "origin", Mc6, "Mc6'_fe");
    assertParents(frontend, Fc4, [Fc3, Mc6_fe], "Fc4 = merge(Fc3, Mc6'_fe)");

    const Mr1_fe = findReplayOrFail(frontend, "origin/shadow/frontend/core-2.0", "origin", Mr1, "Mr1'_fe");
    assertParents(frontend, Fr2, [Fc4, Mr1_fe], "Fr2 = merge(Fc4, Mr1'_fe)");

    assertParents(frontend, Ft2, [Ft1, Fr2], "Ft2 = merge(Ft1, Fr2)");

    // Frontend working branches at end
    assertTip(frontend, "main",     Fc4, "frontend/main = Fc4");
    assertTip(frontend, "core-1.0", Fr1, "frontend/core-1.0 = Fr1");
    assertTip(frontend, "core-2.0", Fr2, "frontend/core-2.0 = Fr2");
    assertTip(frontend, "project",  Ft2, "frontend/project = Ft2");

    // Frontend shadow tips on main/core-2.0
    assertTip(frontend, "origin/shadow/frontend/main",     Mc6_fe, "shadow/frontend/main → Mc6'_fe");
    assertTip(frontend, "origin/shadow/frontend/core-2.0", Mr1_fe, "shadow/frontend/core-2.0 → Mr1'_fe");
    assertRefAbsent(frontend, "origin/shadow/frontend/core-1.0", "no shadow/frontend/core-1.0 on frontend");

    // Frontend shadow: same-pair merges (Mc2 = merge(Mc1, shadow/frontend/main)) and
    // non-merge frontend commits (Mc3) are kept. Mc5 = merge(Mc4, shadow/backend/project)
    // carries only a cross-pair (backend) trailer on its 2nd parent — drops under same-pair rule.
    findReplayOrFail(frontend, "origin/shadow/frontend/main", "origin", Mc2, "Mc2'_fe");
    findReplayOrFail(frontend, "origin/shadow/frontend/main", "origin", Mc3, "Mc3'_fe (frontend-only Mc3 IS replayed)");
    assertEqual(findReplay(frontend, "origin/shadow/frontend/main", "origin", Mc5), null,
      "Mc5 (cross-pair-only merge from frontend's view) must not appear on frontend's shadow");

    // TREESAME-to-all-parents drops on fe: Mc1, Mt1.
    assertEqual(findReplay(frontend, "origin/shadow/frontend/main",    "origin", Mc1), null,
      "Mc1 (merge, all parents empty under fe/) must not appear on frontend's shadow");
    assertEqual(findReplay(frontend, "origin/shadow/frontend/project", "origin", Mt1), null,
      "Mt1 (merge, all parents empty under fe/) must not appear on frontend's shadow");
    // Mt3 is all-TREESAME on fe (with engine fix, Mt2/Mt3/Ft2'_mono trees are identical).
    assertEqual(findReplay(frontend, "origin/shadow/frontend/project", "origin", Mt3), null,
      "Mt3 (merge, all parents identical under fe/ thanks to merge-tree splice) must not appear on frontend's shadow");

    // Mf1 (single-parent be-only) is the single-parent TREESAME drop.
    assertEqual(findReplay(frontend, "origin/shadow/frontend/bug/core-2.0/fix", "origin", Mf1), null,
      "Mf1 (single-parent be-only) must not appear on frontend's shadow");

    // ── Monorepo named commits ────────────────────────────────────────────
    assertParents(mono, Mc0, [], "Mc0 = init");

    const Bc2_mono = findReplayOrFail(mono, "origin/shadow/backend/main",  "backend",  Bc2, "Bc2'");
    const Fc2_mono = findReplayOrFail(mono, "origin/shadow/frontend/main", "frontend", Fc2, "Fc2'");
    assertParents(mono, Mc1, [Mc0, Bc2_mono], "Mc1 = merge(Mc0, Bc2')");
    assertParents(mono, Mc2, [Mc1, Fc2_mono], "Mc2 = merge(Mc1, Fc2')");
    assertParents(mono, Mc3, [Mc2],           "Mc3 parent = Mc2 (frontend-only)");
    assertParents(mono, Mc4, [Mc3],           "Mc4 parent = Mc3 (cross-cutting)");

    const Bt1_mono = findReplayOrFail(mono, "origin/shadow/backend/project",  "backend",  Bt1, "Bt1'");
    const Ft1_mono = findReplayOrFail(mono, "origin/shadow/frontend/project", "frontend", Ft1, "Ft1'");
    assertParents(mono, Mt1, [Mc0, Bt1_mono], "Mt1 = merge(Mc0, Bt1')");
    assertParents(mono, Mc5, [Mc4, Bt1_mono], "Mc5 = merge(Mc4, Bt1')");
    assertParents(mono, Mc6, [Mc5, Ft1_mono], "Mc6 = merge(Mc5, Ft1')");
    assertParents(mono, Mr1, [Mc6],           "Mr1 parent = Mc6");

    const Bt2_mono = findReplayOrFail(mono, "origin/shadow/backend/project",  "backend",  Bt2, "Bt2'_mono");
    const Ft2_mono = findReplayOrFail(mono, "origin/shadow/frontend/project", "frontend", Ft2, "Ft2'_mono");
    assertParents(mono, Mt2, [Mt1, Bt2_mono], "Mt2 = merge(Mt1, Bt2'_mono)");
    assertParents(mono, Mt3, [Mt2, Ft2_mono], "Mt3 = merge(Mt2, Ft2'_mono)");
    assertParents(mono, Mf1, [Mt3],           "Mf1 parent = Mt3");

    // Mono working branches at end
    assertTip(mono, "main",             Mc6, "mono/main = Mc6");
    assertTip(mono, "core-2.0",         Mr1, "mono/core-2.0 = Mr1");
    assertTip(mono, "project",          Mt3, "mono/project = Mt3");
    assertTip(mono, "bug/core-2.0/fix", Mf1, "mono/bug/core-2.0/fix = Mf1");
    assertRefAbsent(mono, "core-1.0",   "mono never created core-1.0");

    // Mono shadow tips
    const Bc4_mono = findReplayOrFail(mono, "origin/shadow/backend/main",            "backend", Bc4, "Bc4'_mono");
    const Br2_mono = findReplayOrFail(mono, "origin/shadow/backend/core-2.0",        "backend", Br2, "Br2'_mono");
    const Bt3_mono = findReplayOrFail(mono, "origin/shadow/backend/project",         "backend", Bt3, "Bt3'_mono");
    const Bf1_mono = findReplayOrFail(mono, "origin/shadow/backend/bug/core-2.0/fix","backend", Bf1, "Bf1'_mono");
    const Br1_mono = findReplayOrFail(mono, "origin/shadow/backend/core-1.0",        "backend", Br1, "Br1'");
    const Fc4_mono = findReplayOrFail(mono, "origin/shadow/frontend/main",     "frontend", Fc4, "Fc4'_mono");
    const Fr2_mono = findReplayOrFail(mono, "origin/shadow/frontend/core-2.0", "frontend", Fr2, "Fr2'_mono");
    const Fr1_mono = findReplayOrFail(mono, "origin/shadow/frontend/core-1.0", "frontend", Fr1, "Fr1'");

    // Phase 19 advances mono's shadow/backend/{main,project,projectB} past Bc4_mono/Bt3_mono;
    // those new tips (Bc5_mono / Bt4_mono / BtB2_mono) are asserted in the Phase 19 block below.
    assertTip(mono, "origin/shadow/backend/core-1.0",         Br1_mono, "mono shadow/backend/core-1.0 → Br1'");
    assertTip(mono, "origin/shadow/backend/core-2.0",         Br2_mono, "mono shadow/backend/core-2.0 → Br2'_mono");
    assertTip(mono, "origin/shadow/backend/bug/core-2.0/fix", Bf1_mono, "mono shadow/backend/bug → Bf1'_mono");
    assertTip(mono, "origin/shadow/frontend/main",            Fc4_mono, "mono shadow/frontend/main → Fc4'_mono");
    assertTip(mono, "origin/shadow/frontend/core-1.0",        Fr1_mono, "mono shadow/frontend/core-1.0 → Fr1'");
    assertTip(mono, "origin/shadow/frontend/core-2.0",        Fr2_mono, "mono shadow/frontend/core-2.0 → Fr2'_mono");
    assertTip(mono, "origin/shadow/frontend/project",         Ft2_mono, "mono shadow/frontend/project → Ft2'_mono");

    // No frontend bug branch on mono (frontend never had a bug branch)
    assertRefAbsent(mono, "origin/shadow/frontend/bug/core-2.0/fix",
      "no shadow/frontend/bug on mono (frontend pair has no source bug branch)");

    // ──────────────────────────────────────────────────────────────────────
    // Comprehensive tree-content assertions: every named commit + every
    // shadow replay has a deterministic predicted tree. Authored content
    // originates only from the obvious authoring side; content that flows
    // across pairs via shadow merges is sourced from a monorepo commit
    // (via composeCrossRepoMergeTree splicing or mergeMappedParentTrees).
    // ──────────────────────────────────────────────────────────────────────

    // ── Backend named commits ──────────────────────────────────────────────
    assertTreeContents(backend, Bc0, BE_BC0, "Bc0 tree");
    assertTreeContents(backend, Bc1, BE_BC1, "Bc1 tree");
    assertTreeContents(backend, Br1, BE_BR1, "Br1 tree");
    assertTreeContents(backend, Bc2, BE_BC2, "Bc2 tree");
    assertTreeContents(backend, Bt1, BE_BT1, "Bt1 tree");
    assertTreeContents(backend, Bc3, BE_BC3, "Bc3 tree (Bc2 + Mc4 shared via shadow merge)");
    assertTreeContents(backend, Bc4, BE_BC4, "Bc4 tree (Mc6-era be: Bc3 + release + project)");
    assertTreeContents(backend, Br2, BE_BR2, "Br2 tree (Mr1-era be: Bc4 + release v2)");
    assertTreeContents(backend, Bt2, BE_BT2, "Bt2 tree (= Br2 content)");
    assertTreeContents(backend, Bf1, BE_BF1, "Bf1 tree (Bt2 + bugfix)");
    assertTreeContents(backend, Bt3, BE_BT3, "Bt3 tree (= Bf1 content)");

    // ── Frontend named commits ─────────────────────────────────────────────
    assertTreeContents(frontend, Fc0, FE_FC0, "Fc0 tree");
    assertTreeContents(frontend, Fc1, FE_FC1, "Fc1 tree");
    assertTreeContents(frontend, Fr1, FE_FR1, "Fr1 tree");
    assertTreeContents(frontend, Fc2, FE_FC2, "Fc2 tree");
    assertTreeContents(frontend, Ft1, FE_FT1, "Ft1 tree");
    assertTreeContents(frontend, Fc3, FE_FC3, "Fc3 tree (Fc2 + Mc4 fe slice)");
    assertTreeContents(frontend, Fc4, FE_FC4, "Fc4 tree (Mc6-era fe: Fc3 + release + project)");
    assertTreeContents(frontend, Fr2, FE_FR2, "Fr2 tree (Mr1-era fe: Fc4 + release v2)");
    assertTreeContents(frontend, Ft2, FE_FT2, "Ft2 tree (= Fr2 content)");

    // ── Monorepo named commits (full tree: outer + be + fe) ───────────────
    assertTreeContents(mono, Mc0, monoTree(OUTER_MC0, EMPTY,  EMPTY),  "Mc0 tree (init: outer only)");
    assertTreeContents(mono, Mc1, monoTree(OUTER_MC0, BE_BC2, EMPTY),  "Mc1 tree (be from Bc2)");
    assertTreeContents(mono, Mc2, monoTree(OUTER_MC0, BE_BC2, FE_FC2), "Mc2 tree (be Bc2, fe Fc2)");
    assertTreeContents(mono, Mc3, monoTree(OUTER_MC0, BE_BC2, FE_MC3), "Mc3 tree (fe-only +feature-flag)");
    assertTreeContents(mono, Mc4, monoTree(OUTER_MC4, BE_MC4, FE_MC4), "Mc4 tree (cross-cutting + README updated)");
    assertTreeContents(mono, Mt1, monoTree(OUTER_MC0, BE_BT1, EMPTY),  "Mt1 tree (project bringing Bt1)");
    assertTreeContents(mono, Mc5, monoTree(OUTER_MC4, BE_MC6, FE_MC4), "Mc5 tree (be Mc4∪Bt1, fe Mc4)");
    assertTreeContents(mono, Mc6, monoTree(OUTER_MC4, BE_MC6, FE_MC6), "Mc6 tree (fe brought from Ft1)");
    assertTreeContents(mono, Mr1, monoTree(OUTER_MC4, BE_MR1, FE_MR1), "Mr1 tree (release v2 both)");
    assertTreeContents(mono, Mt2, monoTree(OUTER_MC4, BE_BT2, FE_MR1), "Mt2 tree (be Bt2, fe inherited from Bt2'_mono outer = Mr1)");
    assertTreeContents(mono, Mt3, monoTree(OUTER_MC4, BE_BT2, FE_FT2), "Mt3 tree (be Bt2, fe Ft2 — both pair trees preserved)");
    assertTreeContents(mono, Mf1, monoTree(OUTER_MC4, BE_MF1, FE_FT2), "Mf1 tree (be Mr1+bugfix, fe Ft2)");

    // ── Shadow replays on monorepo ────────────────────────────────────────
    // Bootstrap chain (line 26 first --from b): no compose; bare adds.
    const Bc0_mono = findReplayOrFail(mono, "origin/shadow/backend/main", "backend", Bc0, "Bc0'_mono");
    const Bc1_mono = findReplayOrFail(mono, "origin/shadow/backend/main", "backend", Bc1, "Bc1'_mono");
    assertTreeContents(mono, Bc0_mono, monoTree(OUTER_MC0, BE_BC0, EMPTY), "Bc0'_mono tree (bootstrap, outer Mc0)");
    assertTreeContents(mono, Bc1_mono, monoTree(OUTER_MC0, BE_BC1, EMPTY), "Bc1'_mono tree");
    assertTreeContents(mono, Bc2_mono, monoTree(OUTER_MC0, BE_BC2, EMPTY), "Bc2'_mono tree");
    assertTreeContents(mono, Br1_mono, monoTree(OUTER_MC0, BE_BR1, EMPTY), "Br1'_mono tree");
    assertTreeContents(mono, Bt1_mono, monoTree(OUTER_MC0, BE_BT1, EMPTY), "Bt1'_mono tree");

    const Fc0_mono = findReplayOrFail(mono, "origin/shadow/frontend/main", "frontend", Fc0, "Fc0'_mono");
    const Fc1_mono = findReplayOrFail(mono, "origin/shadow/frontend/main", "frontend", Fc1, "Fc1'_mono");
    assertTreeContents(mono, Fc0_mono, monoTree(OUTER_MC0, EMPTY, FE_FC0), "Fc0'_mono tree");
    assertTreeContents(mono, Fc1_mono, monoTree(OUTER_MC0, EMPTY, FE_FC1), "Fc1'_mono tree");
    assertTreeContents(mono, Fc2_mono, monoTree(OUTER_MC0, EMPTY, FE_FC2), "Fc2'_mono tree");
    assertTreeContents(mono, Fr1_mono, monoTree(OUTER_MC0, EMPTY, FE_FR1), "Fr1'_mono tree");
    assertTreeContents(mono, Ft1_mono, monoTree(OUTER_MC0, EMPTY, FE_FT1), "Ft1'_mono tree");

    // Cross-repo merges replayed onto monorepo with composeCrossRepoMergeTree firing.
    const Bc3_mono = findReplayOrFail(mono, "origin/shadow/backend/main", "backend", Bc3, "Bc3'_mono");
    assertTreeContents(mono, Bc3_mono, monoTree(OUTER_MC4, BE_BC3, FE_MC4),
      "Bc3'_mono (composeCrossRepoMergeTree splice: Mc4 outer + Bc3 be + Mc4 fe)");
    assertTreeContents(mono, Bc4_mono, monoTree(OUTER_MC4, BE_BC4, FE_MC4),
      "Bc4'_mono (Mc5 outer + Bc4 be + Mc5 fe via Mc5'_be echo; Mc6 cross-pair merge dropped)");
    assertTreeContents(mono, Br2_mono, monoTree(OUTER_MC4, BE_BR2, FE_MR1),
      "Br2'_mono (Mr1 outer + Br2 be + Mr1 fe via Mr1'_be echo)");
    assertTreeContents(mono, Bf1_mono, monoTree(OUTER_MC4, BE_BF1, FE_FT2),
      "Bf1'_mono (Mf1 outer + Bf1 be + Ft2 fe via Mf1'_be echo)");

    // Bt2'_mono / Bt3'_mono have no direct echo parent — mergeMappedParentTrees does the FF.
    assertTreeContents(mono, Bt2_mono, monoTree(OUTER_MC4, BE_BT2, FE_MR1),
      "Bt2'_mono (mergeMappedParentTrees FF to Br2'_mono → preserves outer + fe slice)");
    assertTreeContents(mono, Bt3_mono, monoTree(OUTER_MC4, BE_BT3, FE_FT2),
      "Bt3'_mono (FF to Bf1'_mono)");

    // Symmetric for frontend pair shadow replays on mono.
    const Fc3_mono = findReplayOrFail(mono, "origin/shadow/frontend/main", "frontend", Fc3, "Fc3'_mono");
    assertTreeContents(mono, Fc3_mono, monoTree(OUTER_MC4, BE_MC4, FE_FC3), "Fc3'_mono");
    assertTreeContents(mono, Fc4_mono, monoTree(OUTER_MC4, BE_MC6, FE_FC4), "Fc4'_mono");
    assertTreeContents(mono, Fr2_mono, monoTree(OUTER_MC4, BE_MR1, FE_FR2), "Fr2'_mono");
    assertTreeContents(mono, Ft2_mono, monoTree(OUTER_MC4, BE_MR1, FE_FT2), "Ft2'_mono");

    // ── Shadow replays on backend (b-side; trees are be content only) ─────
    // Mc2 and Mc6 (cross-pair-only merges) drop under the same-pair discriminator.
    const Mc1_be = findReplayOrFail(backend, "origin/shadow/backend/main", "origin", Mc1, "Mc1'_be");
    const Mc5_be = findReplayOrFail(backend, "origin/shadow/backend/main", "origin", Mc5, "Mc5'_be");
    const Mt1_be = findReplayOrFail(backend, "origin/shadow/backend/project", "origin", Mt1, "Mt1'_be");
    assertTreeContents(backend, Mc1_be, BE_BC2,  "Mc1'_be tree (= Bc2 content via merge-tree FF)");
    assertTreeContents(backend, Mc4_be, BE_MC4,  "Mc4'_be tree (Bc2 + shared)");
    assertTreeContents(backend, Mc5_be, BE_MC6,  "Mc5'_be tree (Mc4 + Bt1 = Mc6 era)");
    assertTreeContents(backend, Mr1_be, BE_MR1,  "Mr1'_be tree (Mc6 + release v2)");
    assertTreeContents(backend, Mt1_be, BE_BT1,  "Mt1'_be tree (Bt1 content)");
    assertTreeContents(backend, Mf1_be, BE_MF1,  "Mf1'_be tree (Mr1 + bugfix)");

    // ── Shadow replays on frontend ────────────────────────────────────────
    // Mc5 (cross-pair-only merge from frontend POV) drops under the same-pair rule.
    const Mc2_fe = findReplayOrFail(frontend, "origin/shadow/frontend/main", "origin", Mc2, "Mc2'_fe");
    const Mc3_fe = findReplayOrFail(frontend, "origin/shadow/frontend/main", "origin", Mc3, "Mc3'_fe");
    assertTreeContents(frontend, Mc2_fe, FE_FC2,  "Mc2'_fe tree (Fc2 content)");
    assertTreeContents(frontend, Mc3_fe, FE_MC3,  "Mc3'_fe tree (Fc2 + feature-flag)");
    assertTreeContents(frontend, Mc4_fe, FE_MC4,  "Mc4'_fe tree (Mc3 + shared)");
    assertTreeContents(frontend, Mc6_fe, FE_MC6,  "Mc6'_fe tree (Mc4 + Ft1)");
    assertTreeContents(frontend, Mr1_fe, FE_MR1,  "Mr1'_fe tree (Mc6 + release v2)");

    // ── Shadow ref TIPS — strict tree-content assertions ──────────────────
    assertTreeContents(backend, "origin/shadow/backend/main",             BE_MC6,  "shadow/backend/main tip tree = BE_MC6");
    assertTreeContents(backend, "origin/shadow/backend/core-2.0",         BE_MR1,  "shadow/backend/core-2.0 tip tree = BE_MR1");
    assertTreeContents(backend, "origin/shadow/backend/project",          BE_MR1,  "shadow/backend/project tip tree = BE_MR1 (Mt3 dropped)");
    assertTreeContents(backend, "origin/shadow/backend/bug/core-2.0/fix", BE_MF1,  "shadow/backend/bug tip tree = BE_MF1");

    assertTreeContents(frontend, "origin/shadow/frontend/main",             FE_MC6, "shadow/frontend/main tip tree = FE_MC6");
    assertTreeContents(frontend, "origin/shadow/frontend/core-2.0",         FE_MR1, "shadow/frontend/core-2.0 tip tree = FE_MR1");
    assertTreeContents(frontend, "origin/shadow/frontend/project",          FE_MR1, "shadow/frontend/project tip tree = FE_MR1 (= FE_FT2)");
    assertTreeContents(frontend, "origin/shadow/frontend/bug/core-2.0/fix", FE_MR1, "shadow/frontend/bug tip tree = FE_MR1 (Mf1 dropped on fe)");

    // shadow/backend/{main,project} tip trees are asserted after Phase 19 (they advance through fanout merges).
    assertTreeContents(mono, "origin/shadow/backend/core-1.0", monoTree(OUTER_MC0, BE_BR1, EMPTY),  "mono shadow/backend/core-1.0 tip");
    assertTreeContents(mono, "origin/shadow/backend/core-2.0", monoTree(OUTER_MC4, BE_BR2, FE_MR1), "mono shadow/backend/core-2.0 tip");
    assertTreeContents(mono, "origin/shadow/backend/bug/core-2.0/fix", monoTree(OUTER_MC4, BE_BF1, FE_FT2), "mono shadow/backend/bug tip");
    assertTreeContents(mono, "origin/shadow/frontend/main",     monoTree(OUTER_MC4, BE_MC6, FE_FC4), "mono shadow/frontend/main tip");
    assertTreeContents(mono, "origin/shadow/frontend/core-1.0", monoTree(OUTER_MC0, EMPTY,  FE_FR1), "mono shadow/frontend/core-1.0 tip");
    assertTreeContents(mono, "origin/shadow/frontend/core-2.0", monoTree(OUTER_MC4, BE_MR1, FE_FR2), "mono shadow/frontend/core-2.0 tip");
    assertTreeContents(mono, "origin/shadow/frontend/project",  monoTree(OUTER_MC4, BE_MR1, FE_FT2), "mono shadow/frontend/project tip");

    // ── Phase 18 assertions: Multi-project (projectB parallel to project) ──
    const BE_BTB1 = { "src/init.txt": "init\n", "src/feature.txt": "v1\n", "src/release.txt": "1.0\n", "src/projectB.txt": "projB v1\n" };
    const FE_FTB1 = { "src/init.txt": "init\n", "src/component.txt": "v1\n", "src/release.txt": "1.0\n", "src/projectB.txt": "projB v1\n" };

    // Backend leaf — BtB1 is the first projectB commit off Br1; tip advances to BtB2 in Phase 19.
    assertParents(backend, BtB1, [Br1], "BtB1 parents = (Br1)");
    assertTreeContents(backend, BtB1, BE_BTB1, "BtB1 tree");

    // Frontend leaf — projectB is single-commit (no fanout merged into frontend's projectB).
    assertParents(frontend, FtB1, [Fr1], "FtB1 parents = (Fr1)");
    assertTip(frontend, "projectB", FtB1, "frontend/projectB = FtB1");
    assertTreeContents(frontend, FtB1, FE_FTB1, "FtB1 tree");

    // Monorepo projectB: MtB1 = merge(Mc0, BtB1'_mono); MtB2 = merge(MtB1, FtB1'_mono).
    const BtB1_mono = findReplayOrFail(mono, "origin/shadow/backend/projectB",  "backend",  BtB1, "BtB1'_mono");
    const FtB1_mono = findReplayOrFail(mono, "origin/shadow/frontend/projectB", "frontend", FtB1, "FtB1'_mono");
    assertParents(mono, MtB1, [Mc0, BtB1_mono], "MtB1 = merge(Mc0, BtB1'_mono)");
    assertParents(mono, MtB2, [MtB1, FtB1_mono], "MtB2 = merge(MtB1, FtB1'_mono)");
    assertTreeContents(mono, MtB1, monoTree(OUTER_MC0, BE_BTB1, EMPTY),
      "MtB1 tree (root + backend/projectB; no frontend/)");
    assertTreeContents(mono, MtB2, monoTree(OUTER_MC0, BE_BTB1, FE_FTB1),
      "MtB2 tree (root + backend/projectB + frontend/projectB)");
    assertTip(mono, "origin/projectB", MtB2, "mono/projectB = MtB2");

    // Monorepo's shadow/frontend/projectB stays at FtB1'_mono (frontend's projectB has no
    // further commits). shadow/backend/projectB advances to BtB2'_mono after Phase 19 — see
    // BtB2_mono assertion in the fanout block.
    assertTip(mono, "origin/shadow/frontend/projectB", FtB1_mono, "mono shadow/frontend/projectB = FtB1'_mono");

    // After --from a, leaf shadow refs for projectB.
    // Backend pair: MtB1 kept (full content, brings BtB1's backend tree); MtB2 kept as <noop-tree>.
    const MtB1_be = findReplayOrFail(backend, "origin/shadow/backend/projectB", "origin", MtB1, "MtB1'_be");
    // MtB2 = mono's merge of shadow/frontend/projectB — cross-pair-only, drops under same-pair rule.
    // Backend shadow/backend/projectB tip stays at MtB1'_be (the same-pair backend echo merge).
    assertEqual(findReplay(backend, "origin/shadow/backend/projectB", "origin", MtB2), null,
      "MtB2 (cross-pair-only merge) must not appear on backend's shadow");
    const MtB1_be_tip = findReplayOrFail(backend, "origin/shadow/backend/projectB", "origin", MtB1, "MtB1'_be");
    assertTip(backend, "origin/shadow/backend/projectB", MtB1_be_tip, "backend shadow/backend/projectB = MtB1'_be");
    assertTreeContents(backend, MtB1_be_tip, BE_BTB1, "MtB1'_be tree = BtB1's tree");

    // Frontend pair: MtB1 dropped (all-TREESAME on fe — both Mc0 and BtB1'_mono have empty fe);
    // MtB2 kept (brings FtB1's fe content).
    assertEqual(findReplay(frontend, "origin/shadow/frontend/projectB", "origin", MtB1), null,
      "MtB1 (merge, all parents empty under fe/) must not appear on frontend's shadow");
    const MtB2_fe = findReplayOrFail(frontend, "origin/shadow/frontend/projectB", "origin", MtB2, "MtB2'_fe");
    assertTip(frontend, "origin/shadow/frontend/projectB", MtB2_fe, "frontend shadow/frontend/projectB = MtB2'_fe");
    assertTreeContents(frontend, MtB2_fe, FE_FTB1, "MtB2'_fe tree = FtB1's tree");

    // Independence: project's backend shadow chain must NOT contain projectB.txt;
    // projectB's backend shadow chain must NOT contain project.txt.
    assertEqual(
      git("ls-tree -r --name-only origin/shadow/backend/project", backend.working).split("\n").includes("src/projectB.txt"),
      false, "shadow/backend/project tip must not have src/projectB.txt",
    );
    assertEqual(
      git("ls-tree -r --name-only origin/shadow/backend/projectB", backend.working).split("\n").includes("src/project.txt"),
      false, "shadow/backend/projectB tip must not have src/project.txt",
    );

    // ── Phase 19 assertions: Fanout (BfX1 dedup across 3 merge replays) ──
    const BE_BFX1 = { ...BE_BC4, "src/fanout.txt": "fanout v1\n" };
    const BE_BC5  = BE_BFX1;                                            // merge(Bc4, BfX1) = BfX1's tree (Bc4 ⊂ BfX1)
    const BE_BT4  = { ...BE_BT3, "src/fanout.txt": "fanout v1\n" };     // Bt3 carries bugfix; merge adds fanout.txt
    const BE_BTB2 = { ...BE_BTB1, "src/feature.txt": "v2\n", "src/shared.txt": "shared be\n", "src/project.txt": "proj v1\n", "src/fanout.txt": "fanout v1\n" };

    // Backend leaf parents and trees + branch tips after the fanout phase.
    assertParents(backend, BfX1, [Bc4], "BfX1 parents = (Bc4)");
    assertParents(backend, Bc5,  [Bc4, BfX1], "Bc5  = merge(Bc4, BfX1)");
    assertParents(backend, Bt4,  [Bt3, BfX1], "Bt4  = merge(Bt3, BfX1)");
    assertParents(backend, BtB2, [BtB1, BfX1], "BtB2 = merge(BtB1, BfX1)");
    assertTreeContents(backend, BfX1, BE_BFX1, "BfX1 tree");
    assertTreeContents(backend, Bc5,  BE_BC5,  "Bc5 tree");
    assertTreeContents(backend, Bt4,  BE_BT4,  "Bt4 tree");
    assertTreeContents(backend, BtB2, BE_BTB2, "BtB2 tree");
    assertTip(backend, "main",     Bc5,  "backend/main = Bc5 (post-fanout)");
    assertTip(backend, "project",  Bt4,  "backend/project = Bt4 (post-fanout)");
    assertTip(backend, "projectB", BtB2, "backend/projectB = BtB2 (post-fanout)");

    // Fanout dedup: BfX1 has exactly ONE replay across all monorepo backend shadow refs.
    // Search the union of branches that reference BfX1 (main, project, projectB, feature/fanout).
    const fanoutShadowRefs = [
      "origin/shadow/backend/main",
      "origin/shadow/backend/project",
      "origin/shadow/backend/projectB",
      "origin/shadow/backend/feature/fanout",
    ];
    const replays = new Set<string>();
    for (const ref of fanoutShadowRefs) {
      const sha = findReplay(mono, ref, "backend", BfX1);
      if (sha) replays.add(sha);
    }
    assertEqual(replays.size, 1,
      `BfX1 must have exactly one replay SHA across monorepo's backend shadow refs (got ${replays.size}: ${[...replays].join(", ")})`);
    const BfX1_mono = [...replays][0];

    // The three merge replays' second parent must all equal BfX1'_mono.
    const Bc5_mono  = findReplayOrFail(mono, "origin/shadow/backend/main",     "backend", Bc5,  "Bc5'_mono");
    const Bt4_mono  = findReplayOrFail(mono, "origin/shadow/backend/project",  "backend", Bt4,  "Bt4'_mono");
    const BtB2_mono = findReplayOrFail(mono, "origin/shadow/backend/projectB", "backend", BtB2, "BtB2'_mono");
    assertEqual(getParents(mono, Bc5_mono)[1],  BfX1_mono, "Bc5'_mono.parents[1]  = BfX1'_mono");
    assertEqual(getParents(mono, Bt4_mono)[1],  BfX1_mono, "Bt4'_mono.parents[1]  = BfX1'_mono");
    assertEqual(getParents(mono, BtB2_mono)[1], BfX1_mono, "BtB2'_mono.parents[1] = BfX1'_mono");

    // BfX1 itself appears as the tip of shadow/backend/feature/fanout (the engine syncs every branch).
    assertTip(mono, "origin/shadow/backend/feature/fanout", BfX1_mono, "shadow/backend/feature/fanout tip = BfX1'_mono");

    // ── Idempotence: a clean end-state must produce no replays on re-sync ──
    // Mt2 (post-M9, frontend pair) is non-TREESAME under fe/ vs Mt1 because
    // Bt2'_mono now carries spliced fe content. The engine replays Mt2'_fe
    // every time, but mapBranchesToTargetTips finds Ft2'_mono first in topo
    // order (it has a Shadow-replayed-frontend-repo skip-trailer mapping it
    // to Ft2 itself) and stops the walk before reaching Mt2. Mt2'_fe is left
    // dangling; the next sync's loadReplayedMappings doesn't see it (only
    // scans target's pushed shadow refs) and re-replays it indefinitely.
    for (const from of ["a", "b"] as const) {
      const r = runSync({ from });
      assertEqual(r.exitCode, 0, `[idempotence] --from ${from}: ${r.stderr.slice(0, 300)}`);
      const replayLines = r.stdout.split("\n").filter(l => /^\s*Replaying /.test(l));
      if (replayLines.length > 0) {
        throw new Error(
          `[idempotence] --from ${from} re-replayed commits on a clean end-state:\n  ${replayLines.join("\n  ")}`,
        );
      }
    }

  } finally {
    setBranchFiltersForTesting(null);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── sht6: common pairs + B′ on project branches ─────────────────────────────
function runSht6() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-test-common-"));

  try {
    const backend  = createRepo(tmpDir, "backend",  { email: "bea@example.com",  name: "Bea"  });
    const frontend = createRepo(tmpDir, "frontend", { email: "fred@example.com", name: "Fred" });
    const mono     = createRepo(tmpDir, "mono",     { email: "mira@example.com", name: "Mira" });

    git(`remote add backend "${backend.bare}"`, mono.working);
    git(`remote add frontend "${frontend.bare}"`, mono.working);

    // ── Phase 0: Mature backend (Bc0) — common pre-existing at canonical path
    // .shadowignore at root excludes src/common/ so the parent pair
    // never carries it (in either direction — see scenario.md A13).
    const Bc0 = commitFiles(backend, {
      "src/init.txt": "init\n",
      "src/common/util.ts": "util v1\n",
      ".shadowignore": "src/common/**\n",
    }, "Bc0");
    git("push origin main", backend.working);

    // ── Phase 0: Mature frontend (Fc0) — mirror; common util byte-identical
    const Fc0 = commitFiles(frontend, {
      "src/init.txt": "init\n",
      "src/app/common/util.ts": "util v1\n",
      ".shadowignore": "src/app/common/**\n",
    }, "Fc0");
    git("push origin main", frontend.working);

    // ── Phase 0: Init monorepo (Mc0) — parent shadowignores AND common/ pre-populated
    // byte-identical to leaves (see scenario.md A15).
    const Mc0 = commitFiles(mono, {
      "README.md": "# Monorepo\n",
      ".claude/settings.json": "{}\n",
      "backend/.shadowignore": "src/common/**\n",
      "frontend/.shadowignore": "src/app/common/**\n",
      "common/util.ts": "util v1\n",
    }, "Mc0");
    git("push origin main", mono.working);

    // 4-pair config: parent + dedicated common pairs, nested dir on the leaf side.
    applyTestOverrides({
      repoRoot: mono.working,
      pairs: [
        { name: "backend",         a: { remote: "origin", url: mono.bare, dir: "backend"  }, b: { remote: "backend",  url: backend.bare,  dir: "" } },
        { name: "frontend",        a: { remote: "origin", url: mono.bare, dir: "frontend" }, b: { remote: "frontend", url: frontend.bare, dir: "" } },
        { name: "common-backend",  a: { remote: "origin", url: mono.bare, dir: "common"   }, b: { remote: "backend",  url: backend.bare,  dir: "src/common"   } },
        { name: "common-frontend", a: { remote: "origin", url: mono.bare, dir: "common"   }, b: { remote: "frontend", url: frontend.bare, dir: "src/app/common"        } },
      ],
      shadowBranchPrefix: "shadow",
    });
    void Bc0; void Fc0; void Mc0;

    // Branch allowlist (fail-closed) — grows as the scenario creates branches.
    const allowed: Map<string, string[]> = new Map([
      ["origin",   ["main"]],
      ["backend",  ["main"]],
      ["frontend", ["main"]],
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

    // ── Phase 1: Initial sync --from b ──────────────────────────────────────
    {
      const r = runSync({ from: "b" });
      assertEqual(r.exitCode, 0, `[Phase 1] --from b initial sync: ${r.stderr.slice(0, 400)}`);
    }

    git("fetch origin", mono.working);
    // Shadow refs on monorepo are monorepo-shaped: leaf content is spliced under
    // the target dir, monorepo's bootstrap tree (Mc0) provides everything else.
    // Parent-pair shadow refs: canonical common excluded by .shadowignore.
    assertPathPresent(mono, "origin/shadow/backend/main",  "backend/src/init.txt",      "[Phase 1 backend shadow]");
    assertPathPresent(mono, "origin/shadow/backend/main",  "backend/.shadowignore",     "[Phase 1 backend shadow] .shadowignore itself flows");
    assertPathAbsent(mono,  "origin/shadow/backend/main",  "backend/src/common/util.ts", "[Phase 1 backend shadow] canonical common excluded");
    assertPathPresent(mono, "origin/shadow/frontend/main", "frontend/src/init.txt",     "[Phase 1 frontend shadow]");
    assertPathAbsent(mono,  "origin/shadow/frontend/main", "frontend/src/app/common/util.ts", "[Phase 1 frontend shadow] canonical common excluded");
    // Common-pair shadow refs: canonical common content under "common/" prefix.
    assertPathPresent(mono, "origin/shadow/common-backend/main",  "common/util.ts", "[Phase 1 common-backend shadow] util.ts under common/");
    assertContent(mono, "origin/shadow/common-backend/main", "common/util.ts", "util v1\n", "[Phase 1 common-backend shadow]");
    assertPathPresent(mono, "origin/shadow/common-frontend/main", "common/util.ts", "[Phase 1 common-frontend shadow] util.ts under common/");
    assertContent(mono, "origin/shadow/common-frontend/main", "common/util.ts", "util v1\n", "[Phase 1 common-frontend shadow]");
    // Common-pair shadow refs must NOT carry non-common leaf content (e.g. src/init.txt).
    assertPathAbsent(mono, "origin/shadow/common-backend/main",  "backend/src/init.txt", "[Phase 1 common-backend shadow] no non-common leaf content");
    assertPathAbsent(mono, "origin/shadow/common-frontend/main", "frontend/src/init.txt", "[Phase 1 common-frontend shadow] no non-common leaf content");

    // ── Phase 1b: Merge shadow refs into monorepo main ──────────────────────
    // Order: backend → common-backend → frontend → common-frontend.
    // The second common merge is a no-op (same byte content from byte-identical leaves).
    const Mcm1 = mergeRef(mono, "origin/shadow/backend/main",         "Mcm1");
    const Mcm2 = mergeRef(mono, "origin/shadow/common-backend/main",  "Mcm2");
    const Mcm3 = mergeRef(mono, "origin/shadow/frontend/main",        "Mcm3");
    const Mcm4 = mergeRef(mono, "origin/shadow/common-frontend/main", "Mcm4");
    git("push origin main", mono.working);
    void Mcm1; void Mcm2; void Mcm3;

    // Mcm4 is the post-init monorepo state. Verify the layout matches the design:
    // root common/, no nested canonical common under backend/ or frontend/.
    assertPathPresent(mono, Mcm4, "common/util.ts", "[Phase 1 monorepo state] common/ at root");
    assertContent(mono, Mcm4, "common/util.ts", "util v1\n", "[Phase 1 monorepo state]");
    assertPathPresent(mono, Mcm4, "backend/src/init.txt", "[Phase 1 monorepo state] backend/ slice");
    assertPathPresent(mono, Mcm4, "frontend/src/init.txt", "[Phase 1 monorepo state] frontend/ slice");
    assertPathAbsent(mono, Mcm4, "backend/src/common/util.ts", "[Phase 1 monorepo state] no nested canonical common under backend/");
    assertPathAbsent(mono, Mcm4, "frontend/src/app/common/util.ts", "[Phase 1 monorepo state] no nested canonical common under frontend/");

    // Leaves still hold their canonical common (sync did not touch them).
    assertContent(backend,  "main", "src/common/util.ts", "util v1\n", "[Phase 1] backend canonical common preserved");
    assertContent(frontend, "main", "src/app/common/util.ts",      "util v1\n", "[Phase 1] frontend canonical common preserved");

    // ── Phase 2: Monorepo-sourced common edit reaches both leaves ───────────
    const Mcm5 = commitFiles(mono, { "common/util.ts": "util v2\n" }, "Mcm5");
    git("push origin main", mono.working);
    void Mcm5;

    {
      const r = runSync({ from: "a" });
      assertEqual(r.exitCode, 0, `[Phase 2] --from a after Mcm5: ${r.stderr.slice(0, 400)}`);
    }

    // Each leaf merges its dedicated common shadow ref to land the v2 update at
    // its own canonical path.
    git("fetch origin", backend.working);
    const Bcm1 = mergeRef(backend, "origin/shadow/common-backend/main", "Bcm1");
    git("push origin main", backend.working);
    git("fetch origin", frontend.working);
    const Fcm1 = mergeRef(frontend, "origin/shadow/common-frontend/main", "Fcm1");
    git("push origin main", frontend.working);

    assertContent(backend,  Bcm1, "src/common/util.ts", "util v2\n", "[Phase 2] backend canonical = v2");
    assertContent(frontend, Fcm1, "src/app/common/util.ts",      "util v2\n", "[Phase 2] frontend canonical = v2");
    // Confirm v2 did NOT land at the leaves' roots or under unexpected paths.
    assertPathAbsent(backend,  Bcm1, "common/util.ts",    "[Phase 2] backend has no root-level common/");
    assertPathAbsent(frontend, Fcm1, "common/util.ts",    "[Phase 2] frontend has no root-level common/");
    assertPathAbsent(frontend, Fcm1, "src/common/util.ts","[Phase 2] frontend has no src/common/ (canonical is src/app/common/)");

    // ── Phase 3: Cross-cutting commit — each pair carries its own slice ─────
    const Mcm6 = commitFiles(mono, {
      "common/util.ts":            "util v3\n",
      "backend/src/api.ts":        "api v1\n",
      "frontend/src/component.ts": "component v1\n",
    }, "Mcm6");
    git("push origin main", mono.working);
    void Mcm6;

    {
      const r = runSync({ from: "a" });
      assertEqual(r.exitCode, 0, `[Phase 3] --from a after Mcm6: ${r.stderr.slice(0, 400)}`);
    }

    git("fetch origin", backend.working);
    const Bcm2 = mergeRef(backend, "origin/shadow/backend/main",        "Bcm2");
    const Bcm3 = mergeRef(backend, "origin/shadow/common-backend/main", "Bcm3");
    git("push origin main", backend.working);
    void Bcm2;

    git("fetch origin", frontend.working);
    const Fcm2 = mergeRef(frontend, "origin/shadow/frontend/main",        "Fcm2");
    const Fcm3 = mergeRef(frontend, "origin/shadow/common-frontend/main", "Fcm3");
    git("push origin main", frontend.working);
    void Fcm2;

    assertPathPresent(backend, Bcm3, "src/api.ts", "[Phase 3] backend got api.ts via parent pair");
    assertContent(backend, Bcm3, "src/api.ts", "api v1\n", "[Phase 3] backend api.ts content");
    assertContent(backend, Bcm3, "src/common/util.ts", "util v3\n", "[Phase 3] backend canonical common = v3");
    assertPathAbsent(backend, Bcm3, "src/component.ts", "[Phase 3] frontend slice did NOT leak to backend");

    assertPathPresent(frontend, Fcm3, "src/component.ts", "[Phase 3] frontend got component.ts via parent pair");
    assertContent(frontend, Fcm3, "src/component.ts", "component v1\n", "[Phase 3] frontend component.ts content");
    assertContent(frontend, Fcm3, "src/app/common/util.ts", "util v3\n", "[Phase 3] frontend canonical common = v3");
    assertPathAbsent(frontend, Fcm3, "src/api.ts", "[Phase 3] backend slice did NOT leak to frontend");

    // ── Phase 4: Variant non-interference ───────────────────────────────────
    // A file under backend/project/src/app/common/ is a *variant* common file.
    // It must flow via the parent pair (because it's outside src/common/),
    // and it must NOT appear in the common pair's shadow chain or in monorepo/common/.
    const Mcm7 = commitFiles(mono, {
      "backend/project/src/app/common/variant-only.ts": "variant only\n",
    }, "Mcm7");
    git("push origin main", mono.working);
    void Mcm7;

    {
      const r = runSync({ from: "a" });
      assertEqual(r.exitCode, 0, `[Phase 4] --from a after Mcm7: ${r.stderr.slice(0, 400)}`);
    }

    git("fetch origin", backend.working);
    const Bcm4 = mergeRef(backend, "origin/shadow/backend/main", "Bcm4");
    git("push origin main", backend.working);

    // Variant file landed via the parent pair, in its variant directory.
    assertContent(backend, Bcm4, "project/src/app/common/variant-only.ts", "variant only\n",
      "[Phase 4] variant file landed at variant path via parent pair");
    // Canonical common is unchanged by the variant addition.
    assertContent(backend, Bcm4, "src/common/util.ts", "util v3\n",
      "[Phase 4] canonical common still at v3, variant did not leak in");

    // The common pair must not have picked up the variant file. On the
    // common-backend shadow (mono-shaped), the leaf's src/common/
    // content is spliced under "common/" — a variant-only.ts under "common/"
    // there would indicate leakage.
    git("fetch origin", mono.working);
    assertPathAbsent(mono, "origin/shadow/common-backend/main", "common/variant-only.ts",
      "[Phase 4] variant file did NOT leak into common-backend shadow");

    // monorepo/common/ must not gain variant-only.ts (the strict mapping invariant).
    // Re-fetch and check the post-Mcm7 main tip's tree.
    git("fetch origin", mono.working);
    const monoMainTip = git("rev-parse origin/main", mono.working);
    assertPathAbsent(mono, monoMainTip, "common/variant-only.ts",
      "[Phase 4] variant file is NOT visible at monorepo/common/ — strict alias invariant");

    // ── Phase 5: Convergence after stray leaf edit ──────────────────────────
    // A direct edit on the backend leaf to canonical common. There's no automatic
    // shadow-sync hard-fail for this (see scenario.md A16); instead --from b
    // brings the leaf change back to monorepo's shadow/common-backend, the
    // operator merges it, and --from a propagates to the frontend leaf.
    const Bcm5 = commitFiles(backend, {
      "src/common/util.ts": "util v3 leaf-stray\n",
    }, "Bcm5");
    git("push origin main", backend.working);
    void Bcm5;

    {
      const r = runSync({ from: "b" });
      assertEqual(r.exitCode, 0, `[Phase 5] --from b after stray leaf edit: ${r.stderr.slice(0, 400)}`);
    }

    git("fetch origin", mono.working);
    // Bcm5 was replayed onto common-backend's shadow chain on monorepo.
    assertContent(mono, "origin/shadow/common-backend/main", "common/util.ts", "util v3 leaf-stray\n",
      "[Phase 5] leaf-stray edit reached monorepo's shadow/common-backend");
    // Operator merges to accept the leaf change into monorepo's common/.
    git("checkout main", mono.working);
    git("pull origin main", mono.working);
    const Mcm8 = mergeRef(mono, "origin/shadow/common-backend/main", "Mcm8");
    git("push origin main", mono.working);
    void Mcm8;

    {
      const r = runSync({ from: "a" });
      assertEqual(r.exitCode, 0, `[Phase 5] --from a propagating leaf-stray to frontend: ${r.stderr.slice(0, 400)}`);
    }

    git("fetch origin", frontend.working);
    const Fcm4 = mergeRef(frontend, "origin/shadow/common-frontend/main", "Fcm4");
    git("push origin main", frontend.working);

    // Final --from b captures Fcm4 in monorepo's shadow chain. Without this,
    // the idempotence loop below would re-replay Fcm4 every time (the merge has
    // no trailer of its own; loadReplayedMappings only sees it as "replayed"
    // once Fcm4'_mono exists on monorepo's shadow/common-frontend/main).
    {
      const r = runSync({ from: "b" });
      assertEqual(r.exitCode, 0, `[Phase 5] final --from b capturing Fcm4: ${r.stderr.slice(0, 400)}`);
    }

    // All three sides converge on the leaf-stray content.
    assertContent(backend,  "main", "src/common/util.ts", "util v3 leaf-stray\n", "[Phase 5] backend (origin)");
    assertContent(mono,     "main", "common/util.ts",              "util v3 leaf-stray\n", "[Phase 5] monorepo");
    assertContent(frontend, Fcm4,   "src/app/common/util.ts",      "util v3 leaf-stray\n", "[Phase 5] frontend (propagated)");

    // ── Idempotence (post Phase 5): clean end state must produce no replays ─
    for (const from of ["a", "b"] as const) {
      const r = runSync({ from });
      assertEqual(r.exitCode, 0, `[idempotence post-Phase-5] --from ${from}: ${r.stderr.slice(0, 300)}`);
      const replayLines = r.stdout.split("\n").filter(l => /^\s*Replaying /.test(l));
      if (replayLines.length > 0) {
        throw new Error(
          `[idempotence post-Phase-5] --from ${from} re-replayed:\n  ${replayLines.join("\n  ")}`,
        );
      }
    }

    // ── Phase 6: round-trip + squash recovery on a project branch ───────────
    // See scenario.md sht6 Phase 6 for narrative. Backend opens project-a,
    // project-b; mono adds outer-divergent commits; backend merges + adds Bp1x;
    // backend's project-b → project-a merge (Bm) has mapped parents disagreeing
    // on README.md; engine halts. Operator merges project-b on mono's project-a
    // (Mm); --from a propagates Mm to backend's shadow ref; backend merges that
    // shadow ref into project-a (R_be); --from b sees R_be, naturally FFs to
    // Mm.tree via merge-tree, and absorbs Bm into R_be's squashed replay via
    // multi-trailer encoding.

    // 6.0 Backend creates project-a, project-b from Bc0 (clean ancestry).
    git(`checkout -b project-a ${Bc0}`, backend.working);
    allow("backend", "project-a");
    const Bp1 = commitFiles(backend, { "src/feat-a.ts": "feat a\n" }, "Bp1");
    git("push origin project-a", backend.working);
    git(`checkout -b project-b ${Bc0}`, backend.working);
    allow("backend", "project-b");
    const Bp2 = commitFiles(backend, { "src/feat-b.ts": "feat b\n" }, "Bp2");
    git("push origin project-b", backend.working);
    void Bp1; void Bp2;

    // 6.1 --from b — engine creates shadow/backend/{project-a,project-b} on mono
    {
      const r = runSync({ from: "b" });
      assertEqual(r.exitCode, 0, `[Phase 6.1] --from b: ${r.stderr.slice(0, 400)}`);
    }

    // 6.2 Mono creates project-a, project-b from Mc0 (matching backend's clean ancestry
    // — see Phase 6.0 comment) and adds outer-divergent commits. Each commit touches
    // backend/* (survives parent-pair TREESAME-drop) AND README.md (outer file →
    // divergence the engine can't auto-resolve).
    git(`checkout -b project-a ${Mc0}`, mono.working);
    allow("origin", "project-a");
    const Mp1c = commitFiles(mono, {
      "backend/release-notes.txt": "release a\n",
      "README.md": "v_a\n",
    }, "Mp1c");
    git("push origin project-a", mono.working);
    git(`checkout -b project-b ${Mc0}`, mono.working);
    allow("origin", "project-b");
    const Mp2c = commitFiles(mono, {
      "backend/release-notes.txt": "release b\n",
      "README.md": "v_b\n",
    }, "Mp2c");
    git("push origin project-b", mono.working);
    void Mp1c; void Mp2c;

    // 6.3 --from a — pushes Mp1c/Mp2c onto backend's shadow/backend/{project-a,project-b}
    {
      const r = runSync({ from: "a" });
      assertEqual(r.exitCode, 0, `[Phase 6.3] --from a: ${r.stderr.slice(0, 400)}`);
    }

    // 6.4 Backend absorbs M's work on each project; Bp1x is the post-merge content
    // the squash MUST preserve (see scenario.md A19).
    git("fetch origin --prune", backend.working);
    git("checkout project-a", backend.working);
    const Bp1m = mergeRef(backend, "origin/shadow/backend/project-a", "Bp1m");
    const Bp1x = commitFiles(backend, { "src/feat-a-extra.ts": "extra\n" }, "Bp1x");
    git("push origin project-a", backend.working);
    git("checkout project-b", backend.working);
    const Bp2m = mergeRef(backend, "origin/shadow/backend/project-b", "Bp2m");
    git("push origin project-b", backend.working);
    void Bp1m; void Bp1x; void Bp2m;

    // 6.5 Backend merges project-b → project-a → Bm (textual conflict on release-notes.txt
    // at backend's root — Mp1c/Mp2c's "backend/release-notes.txt" maps to "release-notes.txt"
    // on backend since backend pair's b.dir="").
    git("checkout project-a", backend.working);
    let Bm: string;
    try {
      Bm = mergeRef(backend, "project-b", "Bm");
    } catch {
      fs.writeFileSync(path.join(backend.working, "release-notes.txt"), "release a + release b\n");
      git("add -A", backend.working);
      git("commit --no-edit", backend.working);
      Bm = git("rev-parse HEAD", backend.working);
    }
    git("push origin project-a", backend.working);

    // 6.6 --from b — engine HALTS on Bm (per-branch halt; exit 1 + diagnostic)
    {
      const r = runSync({ from: "b" });
      if (r.exitCode === 0) throw new Error(`[Phase 6.6] expected --from b to halt on Bm but it succeeded`);
      const errText = r.stdout + "\n" + r.stderr;
      if (!/cannot auto-resolve replay parent tree — branch halted/.test(errText)) {
        throw new Error(`[Phase 6.6] expected halt diagnostic, got:\n${errText.slice(0, 800)}`);
      }
    }

    // 6.7 Mono concurrent dev edit on project-a
    git("fetch origin --prune", mono.working);
    git("checkout -B project-a origin/project-a", mono.working);
    const Mp1c2 = commitFiles(mono, { "README.md": "v_a_v2\n" }, "Mp1c2");
    git("push origin project-a", mono.working);
    void Mp1c2;

    // 6.8 Operator action — `git merge project-b` on mono's project-a → Mm
    git("checkout -B project-b origin/project-b", mono.working);
    git("checkout project-a", mono.working);
    let Mm: string;
    try {
      Mm = mergeRef(mono, "project-b", "Mm");
    } catch {
      // Mm's INNER resolution must be byte-identical to Bm's INNER resolution.
      // R_be (in 6.10) is a merge of [Bm, Mm'_on_be]; if their inner content
      // differs, that merge conflicts. Operators independently arriving at the
      // same resolution is the realistic expectation; the test models that.
      fs.writeFileSync(path.join(mono.working, "README.md"), "v_merged\n");
      fs.writeFileSync(path.join(mono.working, "backend/release-notes.txt"), "release a + release b\n");
      git("add -A", mono.working);
      git("commit --no-edit", mono.working);
      Mm = git("rev-parse HEAD", mono.working);
    }
    git("push origin project-a", mono.working);
    void Mm;

    // 6.9 --from a — propagates Mm onto backend's shadow/backend/project-a as Mm'_on_be
    {
      const r = runSync({ from: "a" });
      assertEqual(r.exitCode, 0, `[Phase 6.9] --from a propagation: ${r.stderr.slice(0, 400)}`);
    }

    // 6.10 Backend dev merges shadow ref into project-a → R_be
    git("fetch origin --prune", backend.working);
    git("checkout project-a", backend.working);
    let Rbe: string;
    try {
      Rbe = mergeRef(backend, "origin/shadow/backend/project-a", "R_be");
    } catch {
      // Inner resolutions are byte-identical between Bm and Mm'_on_be, so the
      // merge tree is clean; this catch only fires if a tooling quirk surfaces
      // a phantom conflict.
      git("add -A", backend.working);
      git("commit --no-edit", backend.working);
      Rbe = git("rev-parse HEAD", backend.working);
    }
    git("push origin project-a", backend.working);
    void Rbe;

    // 6.11 --from b — engine sees R_be, naturally FFs through Mm via merge-tree,
    // absorbs Bm into R_be's squashed replay via multi-trailer encoding.
    {
      const r = runSync({ from: "b" });
      assertEqual(r.exitCode, 0, `[Phase 6.11] --from b post-roundtrip: ${r.stderr.slice(0, 400)}`);
    }

    git("fetch origin", mono.working);
    const sq = git("rev-parse origin/shadow/backend/project-a", mono.working);
    const sqMsg = execSync(`git log -1 --format=%B ${sq}`, {
      cwd: mono.working, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    });
    if (!sqMsg.includes(`Shadow-replayed-backend-backend: ${Bm}`)) {
      throw new Error(`[Phase 6.11] sq missing absorbed-Bm trailer for ${Bm}\nsq message:\n${sqMsg}`);
    }
    if (!sqMsg.includes(`Shadow-replayed-backend-backend: ${Rbe}`)) {
      throw new Error(`[Phase 6.11] sq missing own R_be trailer for ${Rbe}\nsq message:\n${sqMsg}`);
    }
    assertContent(mono, "origin/shadow/backend/project-a", "backend/src/feat-a-extra.ts", "extra\n",
      "[Phase 6.11] sq preserves Bp1x (backend/src/feat-a-extra.ts) — backend's inner");
    assertContent(mono, "origin/shadow/backend/project-a", "README.md", "v_merged\n",
      "[Phase 6.11] sq carries Mm's outer (README.md) via FF to Mm.tree");
    assertContent(mono, "origin/shadow/backend/project-a", "backend/release-notes.txt", "release a + release b\n",
      "[Phase 6.11] sq carries the agreed inner resolution of release-notes.txt");

    // 6.12 Catch-up merge on mono's project-a — clean
    git("checkout project-a", mono.working);
    git("pull origin project-a", mono.working);
    mergeRef(mono, "origin/shadow/backend/project-a", "catch-up");
    git("push origin project-a", mono.working);
    assertContent(mono, "project-a", "backend/src/feat-a-extra.ts", "extra\n",
      "[Phase 6.12] catch-up brings backend/src/feat-a-extra.ts to mono.project-a");

    // 6.13 Idempotency — re-running --from b is a no-op on shadow tip
    {
      const r = runSync({ from: "b" });
      assertEqual(r.exitCode, 0, `[Phase 6.13] re-run --from b: ${r.stderr.slice(0, 400)}`);
    }
    git("fetch origin", mono.working);
    const sq2 = git("rev-parse origin/shadow/backend/project-a", mono.working);
    if (sq2 !== sq) {
      throw new Error(`[Phase 6.13] shadow tip changed on idempotent re-run: ${sq} → ${sq2}`);
    }
  } finally {
    setBranchFiltersForTesting(null);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── sht7: round-trip + squash recovery (single-pair, 4 sub-tests) ───────────
async function runSht7(): Promise<void> {
  function git(cmd: string, cwd: string): void {
    execSync(`git ${cmd}`, { cwd, stdio: "pipe" });
  }
  function gitOut(cmd: string, cwd: string): string {
    return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  }
  function writeFile(dir: string, rel: string, content: string): void {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  function assert(cond: boolean, msg: string): void {
    if (!cond) throw new Error(`assertion failed: ${msg}`);
  }
  function assertEqual<T>(actual: T, expected: T, msg: string): void {
    if (actual !== expected) throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
  
  interface ConflictInfo {
    p1: string;
    p2: string;
    bm: string;
  }
  
  /** Drive scenario through the Bm failure; return env and parsed mapped parents. */
  function setupAndFailReplay(envName: string): { env: TestEnv; info: ConflictInfo } {
    const env = createTestEnv(envName, "backend");

    git("branch -m main core-dev", env.localRepo);
    git("branch -m main core-dev", env.remoteWorking);

    // Branch allowlist (engine fails closed without one). sht7 doesn't create
    // any branches beyond core-dev and project, so we list both upfront.
    setBranchFiltersForTesting(new Map([
      ["origin", [compileIgnorePattern("core-dev"), compileIgnorePattern("project")]],
      ["team",   [compileIgnorePattern("core-dev"), compileIgnorePattern("project")]],
    ]));

    // BE: Bc1 on core-dev, Bp1 on project
    writeFile(env.remoteWorking, "api.ts", "v_be_initial\n");
    git("add -A", env.remoteWorking);
    git('commit -m "Bc1"', env.remoteWorking);
    git("push origin core-dev", env.remoteWorking);
    git("checkout -b project core-dev~1", env.remoteWorking);
    writeFile(env.remoteWorking, "api.ts", "v_be_project\n");
    git("add -A", env.remoteWorking);
    git('commit -m "Bp1"', env.remoteWorking);
    git("push origin project", env.remoteWorking);
    git("checkout core-dev", env.remoteWorking);

    // Initial --from b
    const r1 = runCiSync(env);
    if (r1.status !== 0) throw new Error(`initial --from b failed: ${r1.stderr}`);
  
    // M: Mc on core-dev, Mp on project, with frontend.txt divergent outer
    git("checkout core-dev", env.localRepo);
    writeFile(env.localRepo, "backend/notes.txt", "core notes\n");
    writeFile(env.localRepo, "frontend.txt", "v_fe_core\n");
    git("add -A", env.localRepo);
    git('commit -m "Mc"', env.localRepo);
    git("checkout -b project core-dev~1", env.localRepo);
    writeFile(env.localRepo, "backend/notes.txt", "project notes\n");
    writeFile(env.localRepo, "frontend.txt", "v_fe_project\n");
    git("add -A", env.localRepo);
    git('commit -m "Mp"', env.localRepo);
    git("checkout core-dev", env.localRepo);
  
    // --from a
    const r2 = runPush(env);
    if (r2.status !== 0) throw new Error(`--from a failed: ${r2.stderr}`);
  
    // BE: Bcm, Bcx, Bpm, Bm
    git("checkout core-dev", env.remoteWorking);
    git("fetch origin", env.remoteWorking);
    git('merge --no-ff origin/shadow/backend/core-dev -m "Bcm"', env.remoteWorking);
    writeFile(env.remoteWorking, "feature.ts", "be feature added in Bcx\n");
    git("add -A", env.remoteWorking);
    git('commit -m "Bcx"', env.remoteWorking);
    git("push origin core-dev", env.remoteWorking);
    git("checkout project", env.remoteWorking);
    git('merge --no-ff origin/shadow/backend/project -m "Bpm"', env.remoteWorking);
    git("push origin project", env.remoteWorking);
    git("checkout core-dev", env.remoteWorking);
    try {
      git('merge --no-ff project -m "Bm"', env.remoteWorking);
    } catch {
      writeFile(env.remoteWorking, "api.ts", "v_be_initial + v_be_project\n");
      writeFile(env.remoteWorking, "notes.txt", "core + project notes\n");
      git("add -A", env.remoteWorking);
      git('commit --no-edit', env.remoteWorking);
    }
    git("push origin core-dev", env.remoteWorking);
  
    // --from b — must fail
    const r3 = runCiSync(env);
    if (r3.status === 0) throw new Error("expected --from b to fail on Bm but it succeeded");
  
    // Concurrent M-side edit (Mc2)
    git("fetch origin --prune", env.localRepo);
    git("checkout core-dev", env.localRepo);
    writeFile(env.localRepo, "frontend.txt", "v_fe_core_v2\n");
    git("add -A", env.localRepo);
    git('commit -m "Mc2"', env.localRepo);
  
    const errText = r3.stdout + r3.stderr;
    const mp = errText.match(/Mapped parents on origin:\s+([0-9a-f]{40})\s+([0-9a-f]{40})/);
    if (!mp) throw new Error("could not parse mapped parents from:\n" + errText);
    const bmMatch = errText.match(/Source merge:\s+([0-9a-f]{40})/);
    if (!bmMatch) throw new Error("could not parse Bm sha");
  
    return { env, info: { p1: mp[1], p2: mp[2], bm: bmMatch[1] } };
  }
  
  /** Operator action: `git merge project` on M.core-dev. Resolves outer in-place. */
  function operatorMergeProject(env: TestEnv): string {
    git("checkout core-dev", env.localRepo);
    try {
      git('merge --no-ff project -m "Mm"', env.localRepo);
    } catch {
      writeFile(env.localRepo, "frontend.txt", "v_fe_merged_with_v2\n");
      writeFile(env.localRepo, "backend/notes.txt", "core + project notes\n");
      git("add -A", env.localRepo);
      git('commit --no-edit', env.localRepo);
    }
    git("push origin core-dev", env.localRepo);
    return gitOut("rev-parse HEAD", env.localRepo);
  }

  /**
   * Full round-trip after a halt: operator does Mm on mono; --from a propagates
   * Mm onto backend's shadow ref; backend merges that shadow ref into core-dev
   * (= R_be); returns R_be's SHA.
   */
  function roundTripResolution(env: TestEnv): { mm: string; rbe: string } {
    const mm = operatorMergeProject(env);

    // --from a propagates Mm onto backend's shadow/backend/core-dev as Mm'_on_be
    const r = runPush(env);
    if (r.status !== 0) throw new Error(`--from a propagation failed: ${r.stderr}`);

    // Backend merges the shadow ref into core-dev → R_be
    git("fetch origin --prune", env.remoteWorking);
    git("checkout core-dev", env.remoteWorking);
    try {
      git('merge --no-ff origin/shadow/backend/core-dev -m "R_be"', env.remoteWorking);
    } catch {
      // Inner resolutions are byte-identical between Bm and Mm'_on_be, so the
      // merge tree is clean; this catch only fires on phantom tooling conflicts.
      git("add -A", env.remoteWorking);
      git('commit --no-edit', env.remoteWorking);
    }
    git("push origin core-dev", env.remoteWorking);
    const rbe = gitOut("rev-parse HEAD", env.remoteWorking);
    return { mm, rbe };
  }

  function runHappyRoundTrip(): void {
    const { env, info } = setupAndFailReplay("roundtrip-happy");
    try {
      const { rbe } = roundTripResolution(env);
      const r = runCiSync(env);
      assertEqual(r.status, 0, `--from b status after round-trip (stderr=${r.stderr})`);

      git("fetch origin --prune", env.localRepo);
      const sqHash = gitOut("rev-parse origin/shadow/backend/core-dev", env.localRepo);
      assert(sqHash.length === 40, "shadow ref must exist");

      // sq must carry replay trailers for BOTH R_be (its own) and Bm (absorbed)
      const sqMsg = gitOut(`log -1 --format=%B ${sqHash}`, env.localRepo);
      assert(sqMsg.includes(`Shadow-replayed-backend-team: ${rbe}`),
        `sq missing own R_be trailer for ${rbe}\n${sqMsg}`);
      assert(sqMsg.includes(`Shadow-replayed-backend-team: ${info.bm}`),
        `sq missing absorbed Bm trailer for ${info.bm}\n${sqMsg}`);

      // backend/feature.ts (Bcx's content) must be present on the shadow ref tree
      const feature = gitOut(`show origin/shadow/backend/core-dev:backend/feature.ts`, env.localRepo);
      assert(feature.includes("be feature added in Bcx"), `feature.ts missing/wrong on shadow: ${feature}`);

      // Catch-up merge: shadow tip's outer matches M.core-dev's outer (FF'd from Mm),
      // so the merge is clean — no second resolution needed.
      git("checkout core-dev", env.localRepo);
      git("merge --no-ff origin/shadow/backend/core-dev -m \"catch-up\"", env.localRepo);
      const localFeature = fs.readFileSync(path.join(env.localRepo, "backend/feature.ts"), "utf8");
      assert(localFeature.includes("be feature added in Bcx"), `feature.ts missing on M.core-dev`);
    } finally {
      env.cleanup();
    }
  }

  function runIdempotentRerun(): void {
    const { env, info } = setupAndFailReplay("roundtrip-idempotent");
    try {
      roundTripResolution(env);
      const r1 = runCiSync(env);
      assertEqual(r1.status, 0, `first post-roundtrip --from b status (stderr=${r1.stderr})`);
      git("fetch origin --prune", env.localRepo);
      const sq1 = gitOut("rev-parse origin/shadow/backend/core-dev", env.localRepo);

      const r2 = runCiSync(env);
      assertEqual(r2.status, 0, `second --from b status (stderr=${r2.stderr})`);
      git("fetch origin --prune", env.localRepo);
      const sq2 = gitOut("rev-parse origin/shadow/backend/core-dev", env.localRepo);
      assertEqual(sq2, sq1, "sq SHA must be stable across re-runs");
      void info;
    } finally {
      env.cleanup();
    }
  }

  function runHaltPersistence(): void {
    const { env, info } = setupAndFailReplay("roundtrip-halt-persists");
    try {
      // Skip the round-trip — re-run --from b and verify the halt persists
      // with the same diagnostic and no spurious shadow advances.
      git("fetch origin --prune", env.localRepo);
      const tipBefore = gitOut("rev-parse origin/shadow/backend/core-dev", env.localRepo);

      const r = runCiSync(env);
      assert(r.status !== 0, "expected --from b to halt again without resolution");
      assert(/cannot auto-resolve replay parent tree — branch halted/.test(r.stdout + r.stderr),
        `expected halt diagnostic, got:\n${r.stdout}\n${r.stderr}`);

      git("fetch origin --prune", env.localRepo);
      const tipAfter = gitOut("rev-parse origin/shadow/backend/core-dev", env.localRepo);
      assertEqual(tipAfter, tipBefore, "shadow tip must not advance while halted");
      void info;
    } finally {
      env.cleanup();
    }
  }
  
  function runApproachAStillWorks(): void {
    const { env, info } = setupAndFailReplay("b-prime-approach-a");
    try {
      // Hand-build X on shadow ref with existing replay trailer (Approach A recipe)
      const { p1, p2, bm } = info;
      git(`checkout -b manual-resolve-${bm.slice(0, 7)} ${p1}`, env.localRepo);
      try {
        git(`merge --no-ff ${p2}`, env.localRepo);
      } catch {
        writeFile(env.localRepo, "frontend.txt", "v_fe_merged\n");
        writeFile(env.localRepo, "backend/notes.txt", "core + project notes\n");
        writeFile(env.localRepo, "backend/api.ts", "v_be_initial + v_be_project\n");
        git("add -A", env.localRepo);
        git('commit --no-edit', env.localRepo);
      }
      const tree = gitOut("write-tree", env.localRepo);
      const X = gitOut(
        `commit-tree ${tree} -p ${p1} -p ${p2} -m "Manual resolution of ${bm.slice(0, 7)}" -m "Shadow-replayed-backend-team: ${bm}"`,
        env.localRepo,
      );
      git(`update-ref refs/heads/shadow/backend/core-dev ${X}`, env.localRepo);
      git(`push origin shadow/backend/core-dev`, env.localRepo);
      git("checkout core-dev", env.localRepo);
  
      // Re-run without the flag — A should resume normally via loadReplayedMappings
      const r = runCiSync(env);
      assertEqual(r.status, 0, `A recipe --from b status (stderr=${r.stderr})`);
    } finally {
      env.cleanup();
    }
  }

  function runMultiCommitHaltAbsorption(): void {
    const { env, info } = setupAndFailReplay("roundtrip-multi-halt");
    try {
      // BE devs commit on core-dev AFTER the halt. Bm+1 is a linear child whose
      // only source parent is the halted Bm → it inherits the halt via the
      // all-parents-halted+unmapped rule, and the propagation step copies Bm's
      // mappedParents into Bm+1's halt record (the `inheritedMP` block).
      git("checkout core-dev", env.remoteWorking);
      writeFile(env.remoteWorking, "post-halt.ts", "post-halt content\n");
      git("add -A", env.remoteWorking);
      git('commit -m "Bm+1: linear commit after halt"', env.remoteWorking);
      const bmPlus1 = gitOut("rev-parse HEAD", env.remoteWorking);
      git("push origin core-dev", env.remoteWorking);

      // Second --from b — both Bm and Bm+1 halt (Bm directly; Bm+1 via propagation
      // with inherited mappedParents from Bm's halt record).
      const halt2 = runCiSync(env);
      assert(halt2.status !== 0, "expected halt after Bm+1 added");
      assert(/cannot auto-resolve replay parent tree — branch halted/.test(halt2.stdout + halt2.stderr),
        "expected halt diagnostic on second --from b");

      // Operator does the round-trip. BE.core-dev is now at Bm+1, so the
      // BE-side merge of the shadow ref produces R_be with parents [Bm+1, Mm'_on_be].
      roundTripResolution(env);

      // Third --from b — absorbs BOTH Bm and Bm+1 into the squashed shadow commit.
      const r = runCiSync(env);
      assertEqual(r.status, 0, `--from b after multi-commit halt: ${r.stderr}`);

      git("fetch origin --prune", env.localRepo);
      const sqHash = gitOut("rev-parse origin/shadow/backend/core-dev", env.localRepo);
      assert(sqHash.length === 40, "shadow ref must exist post-absorption");
      const sqMsg = gitOut(`log -1 --format=%B ${sqHash}`, env.localRepo);

      // sq must carry trailers for BOTH halted source SHAs (Bm AND Bm+1).
      assert(sqMsg.includes(`Shadow-replayed-backend-team: ${info.bm}`),
        `sq missing absorbed Bm trailer for ${info.bm}\n${sqMsg}`);
      assert(sqMsg.includes(`Shadow-replayed-backend-team: ${bmPlus1}`),
        `sq missing absorbed Bm+1 trailer for ${bmPlus1}\n${sqMsg}`);

      // post-halt.ts (Bm+1's content) must survive in sq's tree. If
      // resolveHaltAwareParents skipped Bm+1's inherited mappedParents, or if
      // collectAbsorbedHalted didn't walk through Bm+1, the squash would lose it.
      const postHalt = gitOut(`show ${sqHash}:backend/post-halt.ts`, env.localRepo);
      assert(postHalt.includes("post-halt content"),
        `post-halt.ts missing/wrong on squashed shadow: "${postHalt}"`);

      // Re-running --from b is a no-op — loadReplayedMappings sees Bm AND Bm+1
      // via the multi-trailer encoding and filters both out of the next work list.
      const rerun = runCiSync(env);
      assertEqual(rerun.status, 0, `idempotent re-run status: ${rerun.stderr}`);
      git("fetch origin --prune", env.localRepo);
      const sqHash2 = gitOut("rev-parse origin/shadow/backend/core-dev", env.localRepo);
      assertEqual(sqHash2, sqHash, "shadow tip stable across multi-trailer idempotent re-run");
    } finally {
      env.cleanup();
    }
  }

  // Bm is an octopus that directly merges two shadow refs (shadow/backend/core-dev
  // + shadow/backend/project) into core-dev. Both shadow-tip parents carry the
  // target-side echo trailer. Their mapped M-side targets (Mc and Mp) have
  // divergent outer state (frontend.txt). Engine must halt rather than silently
  // pick one echo's outer.
  function setupMultiEchoHalt(envName: string): { env: TestEnv; bm: string; mc: string; mp: string } {
    const env = createTestEnv(envName, "backend");
    git("branch -m main core-dev", env.localRepo);
    git("branch -m main core-dev", env.remoteWorking);

    setBranchFiltersForTesting(new Map([
      ["origin", [compileIgnorePattern("core-dev"), compileIgnorePattern("project")]],
      ["team",   [compileIgnorePattern("core-dev"), compileIgnorePattern("project")]],
    ]));

    // BE: Bc1 on core-dev; Bp1 on project (off the same Bc1 root).
    writeFile(env.remoteWorking, "api.ts", "v_be_initial\n");
    git("add -A", env.remoteWorking);
    git('commit -m "Bc1"', env.remoteWorking);
    git("push origin core-dev", env.remoteWorking);

    git("checkout -b project core-dev", env.remoteWorking);
    writeFile(env.remoteWorking, "extra.ts", "v_be_project\n");
    git("add -A", env.remoteWorking);
    git('commit -m "Bp1"', env.remoteWorking);
    git("push origin project", env.remoteWorking);
    git("checkout core-dev", env.remoteWorking);

    const r1 = runCiSync(env);
    if (r1.status !== 0) throw new Error(`bootstrap --from b failed: ${r1.stderr}`);

    // Mc on core-dev, Mp on project. Disjoint inner files so the BE-side
    // octopus auto-resolves; divergent outer (frontend.txt) so the M-side
    // mapped echo targets disagree.
    git("checkout core-dev", env.localRepo);
    writeFile(env.localRepo, "backend/notes.txt", "Mc notes\n");
    writeFile(env.localRepo, "frontend.txt", "v_fe_core\n");
    git("add -A", env.localRepo);
    git('commit -m "Mc"', env.localRepo);
    const mc = gitOut("rev-parse HEAD", env.localRepo);

    git("checkout -b project core-dev~1", env.localRepo);
    writeFile(env.localRepo, "backend/feat.ts", "Mp feat\n");
    writeFile(env.localRepo, "frontend.txt", "v_fe_project\n");
    git("add -A", env.localRepo);
    git('commit -m "Mp"', env.localRepo);
    const mp = gitOut("rev-parse HEAD", env.localRepo);
    git("checkout core-dev", env.localRepo);

    const r2 = runPush(env);
    if (r2.status !== 0) throw new Error(`--from a failed: ${r2.stderr}`);

    git("checkout core-dev", env.remoteWorking);
    git("fetch origin --prune", env.remoteWorking);
    git('merge --no-ff origin/shadow/backend/core-dev origin/shadow/backend/project -m "Bm (multi-echo octopus)"', env.remoteWorking);
    const bm = gitOut("rev-parse HEAD", env.remoteWorking);
    git("push origin core-dev", env.remoteWorking);

    const r3 = runCiSync(env);
    if (r3.status === 0) throw new Error("expected --from b to halt on multi-echo octopus; it succeeded");

    return { env, bm, mc, mp };
  }

  function runMultiEchoOctopusHalts(): void {
    const { env, bm } = setupMultiEchoHalt("multi-echo-halts");
    try {
      // Precondition: Bm is a 3-parent octopus whose parents 2 and 3 carry the echo trailer.
      const bmParents = gitOut(`log -1 --format=%P ${bm}`, env.remoteWorking).split(/\s+/).filter(Boolean);
      assertEqual(bmParents.length, 3, `Bm should be a 3-parent octopus; got ${bmParents.length}`);
      for (const p of [bmParents[1], bmParents[2]]) {
        const trailers = gitOut(`log -1 --format=%(trailers:only) ${p}`, env.remoteWorking);
        assert(trailers.includes("Shadow-replayed-backend-origin:"),
          `parent ${p.slice(0, 7)} missing echo trailer:\n${trailers}`);
      }

      // Re-run --from b: halt must persist with a diagnostic that names the source merge.
      const r = runCiSync(env);
      assert(r.status !== 0, "halt must persist on re-run");
      const out = r.stdout + r.stderr;
      assert(/cannot auto-resolve replay parent tree/.test(out),
        `expected halt diagnostic, got:\n${out}`);
      assert(out.includes(bm), `diagnostic should name source octopus ${bm}`);
    } finally {
      env.cleanup();
    }
  }

  function runMultiEchoOctopusRecovery(): void {
    const { env, bm } = setupMultiEchoHalt("multi-echo-recovery");
    try {
      // Operator: merge project into core-dev on mono, resolving the frontend.txt conflict.
      git("checkout core-dev", env.localRepo);
      try {
        git('merge --no-ff project -m "Mm (resolve multi-echo)"', env.localRepo);
      } catch {
        writeFile(env.localRepo, "frontend.txt", "v_fe_merged\n");
        git("add -A", env.localRepo);
        git('commit --no-edit', env.localRepo);
      }
      git("push origin core-dev", env.localRepo);

      // --from a propagates Mm onto team's shadow/backend/core-dev.
      const rA = runPush(env);
      assertEqual(rA.status, 0, `--from a propagation: ${rA.stderr}`);

      // Backend operator merges shadow back into core-dev → R_be.
      git("fetch origin --prune", env.remoteWorking);
      git("checkout core-dev", env.remoteWorking);
      try {
        git('merge --no-ff origin/shadow/backend/core-dev -m "R_be (catch-up after multi-echo)"', env.remoteWorking);
      } catch {
        git("add -A", env.remoteWorking);
        git('commit --no-edit', env.remoteWorking);
      }
      git("push origin core-dev", env.remoteWorking);
      const rbe = gitOut("rev-parse HEAD", env.remoteWorking);

      // --from b: succeeds, absorbing the halted Bm into the new shadow commit.
      const rB = runCiSync(env);
      assertEqual(rB.status, 0, `--from b after multi-echo recovery: ${rB.stderr}`);

      git("fetch origin --prune", env.localRepo);
      const sqHash = gitOut("rev-parse origin/shadow/backend/core-dev", env.localRepo);
      const sqMsg = gitOut(`log -1 --format=%B ${sqHash}`, env.localRepo);

      // Squashed shadow commit must carry trailers for BOTH R_be (its own) and Bm (absorbed halt).
      assert(sqMsg.includes(`Shadow-replayed-backend-team: ${rbe}`),
        `sq missing own R_be trailer for ${rbe}\n${sqMsg}`);
      assert(sqMsg.includes(`Shadow-replayed-backend-team: ${bm}`),
        `sq missing absorbed Bm trailer for ${bm}\n${sqMsg}`);

      // Tree content: api.ts (from Bc1) + notes.txt (from Mc) + feat.ts (from Mp).
      assertEqual(gitOut(`show ${sqHash}:backend/api.ts`, env.localRepo), "v_be_initial",
        "api.ts present in absorbed shadow tip");
      assertEqual(gitOut(`show ${sqHash}:backend/notes.txt`, env.localRepo), "Mc notes",
        "notes.txt (Mc inner) present in absorbed shadow tip");
      assertEqual(gitOut(`show ${sqHash}:backend/feat.ts`, env.localRepo), "Mp feat",
        "feat.ts (Mp inner) present in absorbed shadow tip");
    } finally {
      env.cleanup();
    }
  }

  const subs: Array<[string, () => void]> = [
    ["happy-round-trip", runHappyRoundTrip],
    ["idempotent-rerun", runIdempotentRerun],
    ["halt-persistence", runHaltPersistence],
    ["approach-a-still-works", runApproachAStillWorks],
    ["multi-commit-halt-absorption", runMultiCommitHaltAbsorption],
    ["multi-echo-octopus-halts", runMultiEchoOctopusHalts],
    ["multi-echo-octopus-recovery", runMultiEchoOctopusRecovery],
  ];
  let failed = 0;
  try {
    for (const [name, fn] of subs) {
      try { fn(); console.log(`    ✓ sht7.${name}`); }
      catch (e: any) { console.error(`    ✘ sht7.${name}: ${e.message}`); failed++; }
    }
  } finally {
    setBranchFiltersForTesting(null);
  }
  if (failed > 0) throw new Error(`sht7: ${failed}/${subs.length} sub-test(s) failed`);
}

// ── sht8: Branch filter — orphan filtered + filtered-then-merged ────────────
function runSht8() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-test-filter-"));

  try {
    const backend = createRepo(tmpDir, "backend", { email: "bea@example.com", name: "Bea" });
    const mono    = createRepo(tmpDir, "mono",    { email: "mira@example.com", name: "Mira" });
    git(`remote add backend "${backend.bare}"`, mono.working);

    // ── Phase 0: Mature backend with allowed + filtered branches ──────────
    const Bc0 = commitFiles(backend, { "src/init.txt": "init\n" }, "Bc0");
    const Bc1 = commitFiles(backend, { "src/feature.txt": "v1\n" }, "Bc1");
    git("push origin main", backend.working);

    // release/v1: allowed via release/* glob.
    git("checkout -b release/v1", backend.working);
    const Br1 = commitFiles(backend, { "src/release.txt": "1.0\n" }, "Br1");
    git("push origin release/v1", backend.working);
    git("checkout main", backend.working);

    // feature/x: filtered, but will later be merged into main.
    git("checkout -b feature/x", backend.working);
    const Bfx1 = commitFiles(backend, { "src/fx.txt": "fx v1\n" }, "Bfx1");
    const Bfx2 = commitFiles(backend, { "src/fx.txt": "fx v2\n" }, "Bfx2");
    git("push origin feature/x", backend.working);

    // feature/y: filtered, NEVER merged (orphan control case).
    git("checkout -b feature/y main", backend.working);
    const Bfy1 = commitFiles(backend, { "src/fy.txt": "fy v1\n" }, "Bfy1");
    git("push origin feature/y", backend.working);
    git("checkout main", backend.working);

    // ── Phase 1: Init monorepo ────────────────────────────────────────────
    const Mc0 = commitFiles(mono, { "README.md": "# Monorepo\n" }, "Mc0");
    git("push origin main", mono.working);

    applyTestOverrides({
      repoRoot: mono.working,
      pairs: [
        { name: "backend", a: { remote: "origin", url: mono.bare, dir: "backend" }, b: { remote: "backend", url: backend.bare, dir: "" } },
      ],
      shadowBranchPrefix: "shadow",
    });

    // Filter: backend remote allows {main, release/*}; mono (origin) allows
    // {main, release/*} too — needed so --from a is not a strict-empty no-op.
    setBranchFiltersForTesting(new Map([
      ["backend", [compileIgnorePattern("main"), compileIgnorePattern("release/*")]],
      ["origin",  [compileIgnorePattern("main"), compileIgnorePattern("release/*")]],
    ]));

    try {
      // ── Phase 2: First --from b — only main + release/v1 sync ───────────
      {
        const r = runSync({ from: "b" });
        assertEqual(r.exitCode, 0, `[sht8 P2] --from b: ${r.stderr.slice(0, 300)}`);
      }
      git("fetch origin", mono.working);
      assertRefExists(mono, "origin/shadow/backend/main",       "[sht8 P2] shadow/backend/main exists");
      assertRefExists(mono, "origin/shadow/backend/release/v1", "[sht8 P2] shadow/backend/release/v1 exists");
      assertRefAbsent(mono,  "origin/shadow/backend/feature/x", "[sht8 P2] feature/x filtered out");
      assertRefAbsent(mono,  "origin/shadow/backend/feature/y", "[sht8 P2] feature/y filtered out");

      // Filtered commits not reachable from any allowed shadow yet (no merge).
      assertEqual(findReplay(mono, "origin/shadow/backend/main", "backend", Bfx1), null,
        "[sht8 P2] Bfx1 not replayed (filtered branch, no merge yet)");
      assertEqual(findReplay(mono, "origin/shadow/backend/main", "backend", Bfy1), null,
        "[sht8 P2] Bfy1 not replayed (filtered orphan)");

      // ── Phase 3: Merge filtered feature/x into allowed main ─────────────
      git("checkout main", backend.working);
      const Bcm = mergeRef(backend, "feature/x", "Bcm");
      git("push origin main", backend.working);

      // ── Phase 4: --from b — fx commits flow via merge reachability ──────
      {
        const r = runSync({ from: "b" });
        assertEqual(r.exitCode, 0, `[sht8 P4] --from b after merge: ${r.stderr.slice(0, 300)}`);
      }
      git("fetch origin", mono.working);
      // feature/x STILL has no shadow ref of its own (filter is branch-level).
      assertRefAbsent(mono, "origin/shadow/backend/feature/x",
        "[sht8 P4] feature/x STILL filtered (no shadow ref despite merge into main)");
      assertRefAbsent(mono, "origin/shadow/backend/feature/y",
        "[sht8 P4] feature/y STILL filtered (orphan)");

      // But Bfx1/Bfx2/Bcm are all reachable from main → replayed onto shadow/backend/main.
      const Bcm_mono  = findReplayOrFail(mono, "origin/shadow/backend/main", "backend", Bcm,  "Bcm'_mono");
      const Bfx1_mono = findReplayOrFail(mono, "origin/shadow/backend/main", "backend", Bfx1, "Bfx1'_mono via merge reachability");
      const Bfx2_mono = findReplayOrFail(mono, "origin/shadow/backend/main", "backend", Bfx2, "Bfx2'_mono via merge reachability");
      // Bcm is a merge: its second parent on the shadow side is Bfx2'_mono.
      assertEqual(getParents(mono, Bcm_mono)[1], Bfx2_mono, "[sht8 P4] Bcm'_mono.parents[1] = Bfx2'_mono");
      // Tree content reaches shadow/backend/main.
      assertPathPresent(mono, "origin/shadow/backend/main", "backend/src/fx.txt", "[sht8 P4] fx.txt on shadow/main");
      // Orphan filtered branch's content stays out.
      assertPathAbsent(mono, "origin/shadow/backend/main", "backend/src/fy.txt", "[sht8 P4] fy.txt (orphan) absent from shadow/main");

      // ── Phase 5: Filter on the --from a direction ───────────────────────
      // Mono creates an allowed branch (release/v2) and a filtered branch (feature/z).
      git("checkout main", mono.working);
      git("checkout -b release/v2 main", mono.working);
      const Mr2 = commitFiles(mono, { "backend/src/release.txt": "2.0\n" }, "Mr2");
      git("push origin release/v2", mono.working);

      git("checkout -b feature/z main", mono.working);
      const Mz1 = commitFiles(mono, { "backend/src/z.txt": "z v1\n" }, "Mz1");
      git("push origin feature/z", mono.working);
      git("checkout main", mono.working);

      {
        const r = runSync({ from: "a" });
        assertEqual(r.exitCode, 0, `[sht8 P5] --from a: ${r.stderr.slice(0, 300)}`);
      }
      git("fetch origin", backend.working);
      // release/v2 (allowed on origin) propagates to backend's shadow.
      const backendRefs = git("branch -r", backend.working);
      assertEqual(backendRefs.includes("origin/shadow/backend/release/v2"), true,
        "[sht8 P5] shadow/backend/release/v2 reached backend");
      // feature/z (filtered on origin) does NOT propagate.
      assertEqual(backendRefs.includes("origin/shadow/backend/feature/z"), false,
        "[sht8 P5] feature/z (mono-side filtered) absent on backend");
      assertEqual(findReplay(backend, "origin/shadow/backend/main", "origin", Mz1), null,
        "[sht8 P5] Mz1 not replayed on main (only on feature/z, which is filtered)");
      assertEqual(findReplay(backend, "origin/shadow/backend/release/v2", "origin", Mr2)?.length, 40,
        "[sht8 P5] Mr2 replayed on shadow/backend/release/v2");

      // ── Phase 6: Idempotence on a clean end-state ───────────────────────
      for (const from of ["a", "b"] as const) {
        const r = runSync({ from });
        assertEqual(r.exitCode, 0, `[sht8 P6 idempotence] --from ${from}: ${r.stderr.slice(0, 300)}`);
        const replayLines = r.stdout.split("\n").filter(l => /^\s*Replaying /.test(l));
        if (replayLines.length > 0) {
          throw new Error(`[sht8 P6] --from ${from} re-replayed on clean state:\n  ${replayLines.join("\n  ")}`);
        }
      }

      // Silence unused-variable warnings (named for narrative clarity).
      void Bc0; void Bc1; void Br1; void Bfy1; void Mc0;
    } finally {
      setBranchFiltersForTesting(null);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export default async function run() {
  // SCENARIO=sht5,sht7 to run a subset; default = all
  const filter = (process.env.SCENARIO ?? "sht5,sht6,sht7,sht8").split(",").map(s => s.trim());
  if (filter.includes("sht5")) { runSht5();       console.log("  ✓ sht5"); }
  if (filter.includes("sht6")) { runSht6();       console.log("  ✓ sht6"); }
  if (filter.includes("sht7")) { await runSht7(); console.log("  ✓ sht7"); }
  if (filter.includes("sht8")) { runSht8();       console.log("  ✓ sht8"); }
}

if (require.main === module) {
  run().then(() => console.log("PASS  test-scenario")).catch(err => { console.error(err); process.exit(1); });
}
