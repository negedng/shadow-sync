import { execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runSync } from "../shadow-sync";
import { applyTestOverrides } from "../shadow-common";
import { assertEqual } from "./assert";

/**
 * Walks the full scenario in scenario.md. The branch named "main" here stands
 * in for "core-dev" — the engine's targetInit lookup is hard-coded to
 * `${target.remote}/main`, so we use that name instead of core-dev. Topology
 * matches scenario.md.
 */

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

/** Find a shadow replay by its trailer. Returns the replay SHA or null. */
function findReplay(repo: Repo, branchRef: string, sourceRemoteName: string, sourceSha: string): string | null {
  const trailer = `Shadow-replayed-${sourceRemoteName}: ${sourceSha}`;
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

// ── Main test ────────────────────────────────────────────────────────────────

export default function run() {
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

    // Bc4's 2nd parent = Mc6'_be<noop> (the kept noop merge — branch tip is Mc6 → Mc6'_be).
    const Mc6_be = findReplayOrFail(backend, "origin/shadow/backend/main", "origin", Mc6, "Mc6'_be");
    assertParents(backend, Bc4, [Bc3, Mc6_be], "Bc4 = merge(Bc3, Mc6'_be<noop>)");

    const Mr1_be = findReplayOrFail(backend, "origin/shadow/backend/core-2.0", "origin", Mr1, "Mr1'_be");
    assertParents(backend, Br2, [Bc4, Mr1_be], "Br2 = merge(Bc4, Mr1'_be)");

    assertParents(backend, Bt2, [Bt1, Br2], "Bt2 = merge(Bt1, Br2)");

    const Mf1_be = findReplayOrFail(backend, "origin/shadow/backend/bug/core-2.0/fix", "origin", Mf1, "Mf1'_be");
    assertParents(backend, Bf1, [Bt2, Mf1_be], "Bf1 = merge(Bt2, Mf1'_be)");

    assertParents(backend, Bt3, [Bt2, Bf1], "Bt3 = merge(Bt2, Bf1)");

    // Backend working branches at end
    assertTip(backend, "main",              Bc4, "backend/main = Bc4");
    assertTip(backend, "core-1.0",          Br1, "backend/core-1.0 = Br1");
    assertTip(backend, "core-2.0",          Br2, "backend/core-2.0 = Br2");
    assertTip(backend, "project",           Bt3, "backend/project = Bt3");
    assertTip(backend, "bug/core-2.0/fix",  Bf1, "backend/bug/core-2.0/fix = Bf1");

    // Backend shadow: tips on main/core-2.0 are the engine's noop-merge replays.
    assertTip(backend, "origin/shadow/backend/main",     Mc6_be, "shadow/backend/main → Mc6'_be<noop>");
    assertTip(backend, "origin/shadow/backend/core-2.0", Mr1_be, "shadow/backend/core-2.0 → Mr1'_be");
    assertRefAbsent(backend, "origin/shadow/backend/core-1.0", "no shadow/backend/core-1.0 on backend (mono never had core-1.0)");

    // Backend shadow: M-merges with at least one non-TREESAME parent under be/ are kept.
    findReplayOrFail(backend, "origin/shadow/backend/main",    "origin", Mc1, "Mc1'_be");
    findReplayOrFail(backend, "origin/shadow/backend/main",    "origin", Mc2, "Mc2'_be<noop-tree>");
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

    // Frontend shadow: M-merges with at least one non-TREESAME parent under frontend/ are kept.
    // The new Mc3 (fe-only single-parent) IS replayed here — that's the test the user asked for.
    findReplayOrFail(frontend, "origin/shadow/frontend/main", "origin", Mc2, "Mc2'_fe");
    findReplayOrFail(frontend, "origin/shadow/frontend/main", "origin", Mc3, "Mc3'_fe (frontend-only Mc3 IS replayed)");
    findReplayOrFail(frontend, "origin/shadow/frontend/main", "origin", Mc5, "Mc5'_fe<noop-tree>");

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

    assertTip(mono, "origin/shadow/backend/main",             Bc4_mono, "mono shadow/backend/main → Bc4'_mono");
    assertTip(mono, "origin/shadow/backend/core-1.0",         Br1_mono, "mono shadow/backend/core-1.0 → Br1'");
    assertTip(mono, "origin/shadow/backend/core-2.0",         Br2_mono, "mono shadow/backend/core-2.0 → Br2'_mono");
    assertTip(mono, "origin/shadow/backend/project",          Bt3_mono, "mono shadow/backend/project → Bt3'_mono");
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
    assertTreeContents(mono, Bc4_mono, monoTree(OUTER_MC4, BE_BC4, FE_MC6),
      "Bc4'_mono (Mc6 outer + Bc4 be + Mc6 fe via Mc6'_be echo)");
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
    const Mc1_be = findReplayOrFail(backend, "origin/shadow/backend/main", "origin", Mc1, "Mc1'_be");
    const Mc2_be = findReplayOrFail(backend, "origin/shadow/backend/main", "origin", Mc2, "Mc2'_be");
    const Mc5_be = findReplayOrFail(backend, "origin/shadow/backend/main", "origin", Mc5, "Mc5'_be");
    const Mt1_be = findReplayOrFail(backend, "origin/shadow/backend/project", "origin", Mt1, "Mt1'_be");
    assertTreeContents(backend, Mc1_be, BE_BC2,  "Mc1'_be tree (= Bc2 content via merge-tree FF)");
    assertTreeContents(backend, Mc2_be, BE_BC2,  "Mc2'_be tree (no-op, same as Mc1'_be)");
    assertTreeContents(backend, Mc4_be, BE_MC4,  "Mc4'_be tree (Bc2 + shared)");
    assertTreeContents(backend, Mc5_be, BE_MC6,  "Mc5'_be tree (Mc4 + Bt1 = Mc6 era)");
    assertTreeContents(backend, Mc6_be, BE_MC6,  "Mc6'_be tree (no-op, = Mc5'_be)");
    assertTreeContents(backend, Mr1_be, BE_MR1,  "Mr1'_be tree (Mc6 + release v2)");
    assertTreeContents(backend, Mt1_be, BE_BT1,  "Mt1'_be tree (Bt1 content)");
    assertTreeContents(backend, Mf1_be, BE_MF1,  "Mf1'_be tree (Mr1 + bugfix)");

    // ── Shadow replays on frontend ────────────────────────────────────────
    const Mc2_fe = findReplayOrFail(frontend, "origin/shadow/frontend/main", "origin", Mc2, "Mc2'_fe");
    const Mc3_fe = findReplayOrFail(frontend, "origin/shadow/frontend/main", "origin", Mc3, "Mc3'_fe");
    const Mc5_fe = findReplayOrFail(frontend, "origin/shadow/frontend/main", "origin", Mc5, "Mc5'_fe");
    assertTreeContents(frontend, Mc2_fe, FE_FC2,  "Mc2'_fe tree (Fc2 content)");
    assertTreeContents(frontend, Mc3_fe, FE_MC3,  "Mc3'_fe tree (Fc2 + feature-flag)");
    assertTreeContents(frontend, Mc4_fe, FE_MC4,  "Mc4'_fe tree (Mc3 + shared)");
    assertTreeContents(frontend, Mc5_fe, FE_MC4,  "Mc5'_fe tree (no-op fe, = Mc4'_fe)");
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

    assertTreeContents(mono, "origin/shadow/backend/main",     monoTree(OUTER_MC4, BE_BC4, FE_MC6), "mono shadow/backend/main tip");
    assertTreeContents(mono, "origin/shadow/backend/core-1.0", monoTree(OUTER_MC0, BE_BR1, EMPTY),  "mono shadow/backend/core-1.0 tip");
    assertTreeContents(mono, "origin/shadow/backend/core-2.0", monoTree(OUTER_MC4, BE_BR2, FE_MR1), "mono shadow/backend/core-2.0 tip");
    assertTreeContents(mono, "origin/shadow/backend/project",  monoTree(OUTER_MC4, BE_BT3, FE_FT2), "mono shadow/backend/project tip");
    assertTreeContents(mono, "origin/shadow/backend/bug/core-2.0/fix", monoTree(OUTER_MC4, BE_BF1, FE_FT2), "mono shadow/backend/bug tip");
    assertTreeContents(mono, "origin/shadow/frontend/main",     monoTree(OUTER_MC4, BE_MC6, FE_FC4), "mono shadow/frontend/main tip");
    assertTreeContents(mono, "origin/shadow/frontend/core-1.0", monoTree(OUTER_MC0, EMPTY,  FE_FR1), "mono shadow/frontend/core-1.0 tip");
    assertTreeContents(mono, "origin/shadow/frontend/core-2.0", monoTree(OUTER_MC4, BE_MR1, FE_FR2), "mono shadow/frontend/core-2.0 tip");
    assertTreeContents(mono, "origin/shadow/frontend/project",  monoTree(OUTER_MC4, BE_MR1, FE_FT2), "mono shadow/frontend/project tip");

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
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-scenario");
}
