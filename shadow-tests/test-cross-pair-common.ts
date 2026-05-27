/**
 * test-cross-pair-common.ts — two pairs sharing common/ on the monorepo.
 *
 * Pins behavior of the cross-pair filter in [filterNotReplayedCommits] when
 * two pairs sync the same `common/` subdir on mono via different external
 * remotes.
 *
 * Sub-tests, all run on a single timeline:
 *   1) pre-integration: --from a before the engineer's integration merge
 *      must NOT leak the cross-pair shadow commit onto the sibling pair's
 *      shadow (no premature replay).
 *   2) cross-pair filter assertion: after integration, Ff1'_mono (frontend
 *      pair's shadow commit, carrying Shadow-replayed-common-frontend-*)
 *      does NOT appear as a replay on the common-backend pair's shadow.
 *   3) content propagation: the common/ delta still reaches the backend
 *      pair's shadow via the diff applied during replay of the integration
 *      merge.
 *   4) topology collapse: the integration-merge replay on the cross-pair's
 *      shadow is a single-parent commit (second parent resolved via
 *      findEchoAnchor to the same target SHA as the first parent, then
 *      deduped). Pins the design choice — preserving cross-pair merge
 *      topology would require its own decision.
 *   5) round-trip: a subsequent backend-side change to common/ propagates
 *      back to frontend's shadow with no duplicate replays and no leak
 *      of the backend-side cross-pair commit.
 */
import { execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runSync } from "../shadow-sync";
import { applyTestOverrides, setBranchFiltersForTesting, compileIgnorePattern } from "../shadow-common";
import { assertEqual } from "./assert";

// ── Setup helpers (mirror test-scenario.ts style) ───────────────────────────

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function writeRepoConfig(workDir: string, identity: { email: string; name: string }) {
  fs.appendFileSync(
    path.join(workDir, ".git", "config"),
    `[user]\n\temail = ${identity.email}\n\tname = ${identity.name}\n[core]\n\tautocrlf = false\n`,
  );
}

interface Repo { bare: string; working: string }

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

function getParents(repo: Repo, sha: string): string[] {
  return git(`log -1 --format=%P ${sha}`, repo.working).split(/\s+/).filter(Boolean);
}

function refExists(repo: Repo, ref: string): boolean {
  try {
    git(`rev-parse --verify --quiet ${ref}`, repo.working);
    return true;
  } catch {
    return false;
  }
}

/** Find a shadow replay by its trailer. Pair name parsed from branchRef. */
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
  for (const block of log.split("---END---\n").filter(Boolean)) {
    const trimmed = block.replace(/^\s+/, "");
    const newlineIdx = trimmed.indexOf("\n");
    const sha = trimmed.slice(0, newlineIdx).trim();
    const body = trimmed.slice(newlineIdx + 1);
    if (body.includes(trailer)) return sha;
  }
  return null;
}

function readAtRef(repo: Repo, ref: string, p: string): string {
  return execSync(`git show ${ref}:${p}`, {
    cwd: repo.working, encoding: "utf8", maxBuffer: 50 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"],
  }).replace(/\r\n/g, "\n");
}

// ── Test ────────────────────────────────────────────────────────────────────

export default function run(): void {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-test-cross-pair-common-"));

  try {
    const backend  = createRepo(tmpDir, "backend",  { email: "bea@example.com",  name: "Bea"  });
    const frontend = createRepo(tmpDir, "frontend", { email: "fred@example.com", name: "Fred" });
    const mono     = createRepo(tmpDir, "mono",     { email: "mira@example.com", name: "Mira" });

    git(`remote add backend "${backend.bare}"`, mono.working);
    git(`remote add frontend "${frontend.bare}"`, mono.working);

    // Both pairs share common/ on mono; each has its own external remote.
    applyTestOverrides({
      repoRoot: mono.working,
      pairs: [
        { name: "common-backend",  a: { remote: "origin", url: mono.bare, dir: "common" }, b: { remote: "backend",  url: backend.bare,  dir: "src/common" } },
        { name: "common-frontend", a: { remote: "origin", url: mono.bare, dir: "common" }, b: { remote: "frontend", url: frontend.bare, dir: "src/common" } },
      ],
      shadowBranchPrefix: "shadow",
    });

    setBranchFiltersForTesting(new Map<string, RegExp[]>([
      ["origin",   ["main"].map(compileIgnorePattern)],
      ["backend",  ["main"].map(compileIgnorePattern)],
      ["frontend", ["main"].map(compileIgnorePattern)],
    ]));

    // ── Phase 1: seed all three repos ───────────────────────────────────────
    commitFiles(backend,  { "src/common/util.ts": "v1\n" }, "be init");
    git("push origin main", backend.working);
    commitFiles(frontend, { "src/common/util.ts": "v1\n" }, "fe init");
    git("push origin main", frontend.working);
    commitFiles(mono, { "README.md": "# Monorepo\n", "common/util.ts": "v1\n" }, "Mc0");
    git("push origin main", mono.working);

    // ── Phase 2: initial sync --from b — establish shadow refs on origin ────
    {
      const r = runSync({ from: "b" });
      assertEqual(r.exitCode, 0, `[init sync --from b] ${r.stderr.slice(0, 300)}`);
    }
    git("fetch origin", mono.working);

    // ── Phase 3: frontend dev pushes a common/ change ───────────────────────
    const Ff1 = commitFiles(frontend, { "src/common/util.ts": "v2-fe\n" }, "Ff1: common bump");
    git("push origin main", frontend.working);

    {
      const r = runSync({ from: "b" });
      assertEqual(r.exitCode, 0, `[after Ff1: sync --from b] ${r.stderr.slice(0, 300)}`);
    }
    git("fetch origin", mono.working);

    const Ff1_mono = findReplay(mono, "origin/shadow/common-frontend/main", "frontend", Ff1);
    if (!Ff1_mono) throw new Error("Ff1'_mono replay not found on origin/shadow/common-frontend/main");

    // ── Sub-test 1: PRE-INTEGRATION sync --from a ───────────────────────────
    // The engineer has NOT merged shadow/common-frontend → main yet. Ff1'_mono
    // is only reachable from origin/shadow/common-frontend/main, not from
    // origin/main, so the common-backend pair's path-filtered rev-list must
    // not see it. The sync should be a clean Mc0-only bootstrap onto backend
    // remote and frontend remote.
    {
      const r = runSync({ from: "a" });
      assertEqual(r.exitCode, 0, `[pre-integration sync --from a] ${r.stderr.slice(0, 300)}`);
    }
    git("fetch backend",  mono.working);
    git("fetch frontend", mono.working);

    assertEqual(
      refExists(mono, "backend/shadow/common-backend/main"), true,
      "[pre-integration] backend's shadow ref should be created with Mc0'_be",
    );
    assertEqual(
      readAtRef(mono, "backend/shadow/common-backend/main", "src/common/util.ts"), "v1\n",
      "[pre-integration] backend's shadow tip carries v1 only — no Ff1 leak before integration",
    );
    assertEqual(
      readAtRef(mono, "frontend/shadow/common-frontend/main", "src/common/util.ts"), "v1\n",
      "[pre-integration] frontend's shadow tip carries v1 only — Mf1 not yet on main",
    );
    assertEqual(
      findReplay(mono, "backend/shadow/common-backend/main", "origin", Ff1_mono), null,
      "[pre-integration] cross-pair Ff1'_mono must not replay onto backend's shadow",
    );

    // ── Phase 5: mono engineer integrates shadow/common-frontend → main ─────
    const Mf1 = mergeRef(mono, "origin/shadow/common-frontend/main", "Mf1: pull in frontend common");
    git("push origin main", mono.working);

    {
      const r = runSync({ from: "a" });
      assertEqual(r.exitCode, 0, `[post-integration sync --from a] ${r.stderr.slice(0, 300)}`);
    }
    git("fetch backend",  mono.working);
    git("fetch frontend", mono.working);

    // ── Sub-test 2: CROSS-PAIR FILTER ───────────────────────────────────────
    // After integration, Mg1's rev-list reaches Ff1'_mono via the merge edge.
    // The cross-pair filter must drop it: no commit on backend's shadow
    // carries a trailer pointing to Ff1'_mono.
    assertEqual(
      findReplay(mono, "backend/shadow/common-backend/main", "origin", Ff1_mono), null,
      "[cross-pair filter] Ff1'_mono must not replay onto backend's shadow",
    );

    // ── Sub-test 3: CONTENT PROPAGATION ─────────────────────────────────────
    // Mf1 is replayed and carries the common/util.ts diff to backend's shadow.
    const Mf1_be = findReplay(mono, "backend/shadow/common-backend/main", "origin", Mf1);
    if (!Mf1_be) throw new Error("Mf1'_be (integration-merge replay) not found on backend's shadow");
    assertEqual(
      readAtRef(mono, Mf1_be, "src/common/util.ts"), "v2-fe\n",
      "[content propagation] backend's shadow tip carries frontend's v2-fe via Mf1's diff",
    );

    // ── Sub-test 4: TOPOLOGY COLLAPSE ───────────────────────────────────────
    // Mf1.parents = [Mc0, Ff1'_mono]. resolveTargetParents maps:
    //   Mc0       → Mc0'_be (via shaMapping)
    //   Ff1'_mono → findEchoAnchor walks Fe_init'_mono → Mc0 → Mc0'_be
    // Both map to the same target SHA; seen-dedup collapses to 1 parent.
    // Pinning this asserts the design choice — cross-pair merge topology
    // does NOT survive on the sibling pair's shadow.
    const Mf1_be_parents = getParents(mono, Mf1_be);
    assertEqual(
      Mf1_be_parents.length, 1,
      `[topology collapse] Mf1'_be must have 1 parent (got ${Mf1_be_parents.length}: ${Mf1_be_parents.join(", ")})`,
    );

    // Own-pair sanity: on the common-frontend side, Ff1'_mono matches the
    // pair's own skipKey trailer, so it gets mapped to Ff1 (a distinct SHA on
    // the frontend remote). Mf1'_fe therefore keeps 2 parents — the merge
    // topology is preserved for the pair that originated the merge.
    const Mf1_fe = findReplay(mono, "frontend/shadow/common-frontend/main", "origin", Mf1);
    if (!Mf1_fe) throw new Error("Mf1'_fe not found on frontend's shadow");
    const Mf1_fe_parents = getParents(mono, Mf1_fe);
    assertEqual(
      Mf1_fe_parents.length, 2,
      `[own-pair sanity] Mf1'_fe should be a 2-parent merge (got ${Mf1_fe_parents.length})`,
    );

    // ── Sub-test 5: ROUND-TRIP ──────────────────────────────────────────────
    // Backend dev first pulls down mono's integrated state via the shadow (so
    // their next commit builds on top of v2-fe, not on top of v1). Then they
    // modify common/util.ts to v3-be and push.
    git("fetch origin shadow/common-backend/main", backend.working);
    git('merge --no-ff origin/shadow/common-backend/main -m "be: pull in mono shadow"', backend.working);
    const Bf1 = commitFiles(backend, { "src/common/util.ts": "v3-be\n" }, "Bf1: backend bumps common");
    git("push origin main", backend.working);
    {
      const r = runSync({ from: "b" });
      assertEqual(r.exitCode, 0, `[round-trip sync --from b] ${r.stderr.slice(0, 300)}`);
    }
    git("fetch origin", mono.working);
    const Bf1_mono = findReplay(mono, "origin/shadow/common-backend/main", "backend", Bf1);
    if (!Bf1_mono) throw new Error("Bf1'_mono not found on origin/shadow/common-backend/main");

    const Mg1 = mergeRef(mono, "origin/shadow/common-backend/main", "Mg1: pull in backend common");
    git("push origin main", mono.working);
    {
      const r = runSync({ from: "a" });
      assertEqual(r.exitCode, 0, `[round-trip sync --from a] ${r.stderr.slice(0, 300)}`);
    }
    git("fetch backend",  mono.working);
    git("fetch frontend", mono.working);

    const Mg1_fe = findReplay(mono, "frontend/shadow/common-frontend/main", "origin", Mg1);
    if (!Mg1_fe) throw new Error("Mg1'_fe (round-trip integration-merge replay) not found");
    assertEqual(
      readAtRef(mono, Mg1_fe, "src/common/util.ts"), "v3-be\n",
      "[round-trip content] frontend's shadow tip carries backend's v3-be",
    );

    assertEqual(
      findReplay(mono, "frontend/shadow/common-frontend/main", "origin", Bf1_mono), null,
      "[round-trip cross-pair filter] Bf1'_mono must not replay onto frontend's shadow",
    );

    // No duplicate replays: each shadow ref's commit history is SHA-unique.
    const feShadowCommits = git("log frontend/shadow/common-frontend/main --format=%H", mono.working)
      .split("\n").filter(Boolean);
    const beShadowCommits = git("log backend/shadow/common-backend/main --format=%H",   mono.working)
      .split("\n").filter(Boolean);
    assertEqual(
      new Set(feShadowCommits).size, feShadowCommits.length,
      "[round-trip no-dup] frontend shadow has no duplicate commit SHAs",
    );
    assertEqual(
      new Set(beShadowCommits).size, beShadowCommits.length,
      "[round-trip no-dup] backend shadow has no duplicate commit SHAs",
    );
  } finally {
    setBranchFiltersForTesting(new Map());
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-cross-pair-common");
}
