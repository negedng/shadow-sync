/**
 * test-cross-pair-common.ts — full-circle propagation of one common/ commit.
 *
 * Follows a single frontend commit (Ff1 by Fred, mutates common/util.ts at
 * v1 → v2-fe) all the way around: frontend → mono → backend → mono → frontend.
 * Asserts that Fred's authorship is preserved on every shadow ref the commit
 * reaches, and that v2-fe lands at each repo's main after the integrating
 * merge.
 *
 * Two pairs share `common/` on mono via different external remotes:
 *   common-frontend: origin/common <-> frontend/src/common
 *   common-backend:  origin/common <-> backend/src/common
 *
 * Timeline:
 *    1. Seed three repos at v1.
 *    2. Bootstrap (--from b) to create the mono-side shadow refs.
 *    3. Fred commits Ff1 on frontend (v2-fe).
 *    4. --from b: Ff1'_mono appears on mono's shadow/common-frontend/main.
 *       Pre-integration --from a must NOT leak Ff1 onto backend's shadow yet
 *       (Ff1'_mono is not yet reachable from origin/main).
 *    5. Mira merges shadow/common-frontend/main → mono/main as Mf1.
 *    6. --from a: Ff1'_be appears on backend's shadow (Fred-authored — the
 *       core authorship-preservation invariant). Mf1'_be is a 2-parent merge
 *       by Mira whose 2nd parent IS Ff1'_be.
 *    7. Bea merges shadow/common-backend/main → backend/main as Bm1.
 *       backend/main now carries v2-fe.
 *    8. --from b: Bm1'_mono appears on mono's shadow/common-backend/main
 *       (Bea-authored). Mf1'_be is dropped as an echo (its origin-trailer
 *       maps it back to Mf1).
 *    9. Mira merges shadow/common-backend/main → mono/main as Mb1.
 *   10. --from a: Mb1'_fe appears on frontend's shadow/common-frontend/main
 *       (Mira-authored merge). Bm1'_mono replays onto frontend's shadow as
 *       Bm1'_fe (Bea-authored — cross-pair, mirror of Ff1'_be's case).
 *   11. Fred merges shadow/common-frontend/main → frontend/main as Fm1.
 *       frontend/main now carries the full round-trip view at v2-fe.
 *   12. --from b: Fm1'_mono appears on mono's shadow/common-frontend/main.
 *       Cycle complete — no duplicate Ff1 anywhere along the way.
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
        { name: "common-backend",  a: { remote: "origin", url: mono.bare }, b: { remote: "backend",  url: backend.bare  }, mappings: [{ a: "common", b: "src/common" }] },
        { name: "common-frontend", a: { remote: "origin", url: mono.bare }, b: { remote: "frontend", url: frontend.bare }, mappings: [{ a: "common", b: "src/common" }] },
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

    // ── Phase 2: initial sync --from b then --from a ────────────────────────
    // Bootstrap creates the mono-side shadow refs; --from a follow-up creates
    // them on backend & frontend so later round-trip syncs see prior state.
    {
      const r = runSync({ from: "b" });
      assertEqual(r.exitCode, 0, `[bootstrap --from b] ${r.stderr.slice(0, 300)}`);
    }
    {
      const r = runSync({ from: "a" });
      assertEqual(r.exitCode, 0, `[bootstrap --from a] ${r.stderr.slice(0, 300)}`);
    }
    git("fetch origin",   mono.working);
    git("fetch backend",  mono.working);
    git("fetch frontend", mono.working);

    // ── Phase 3: Fred commits Ff1 on a frontend feature branch ──────────────
    // Ff1 is authored on a side branch (not in any filter), then folded into
    // main via a merge — exercising the "branch not synced, but reachable via
    // merge into a synced branch" path.
    git("checkout -b feature-fred", frontend.working);
    const Ff1 = commitFiles(frontend, { "src/common/util.ts": "v2-fe\n" }, "Ff1: common bump");
    git("checkout main", frontend.working);
    mergeRef(frontend, "feature-fred", "fe: merge feature-fred into main");
    git("push origin main", frontend.working);

    // ── Phase 4: --from b — Ff1 reaches mono's frontend-pair shadow ─────────
    {
      const r = runSync({ from: "b" });
      assertEqual(r.exitCode, 0, `[Phase 4 sync --from b] ${r.stderr.slice(0, 300)}`);
    }
    git("fetch origin", mono.working);

    const Ff1_mono = findReplay(mono, "origin/shadow/common-frontend/main", "frontend", Ff1);
    if (!Ff1_mono) throw new Error("Ff1'_mono not found on origin/shadow/common-frontend/main");
    assertEqual(
      git(`log -1 --format=%ae ${Ff1_mono}`, mono.working), "fred@example.com",
      "[Phase 4] Ff1'_mono carries Fred's authorship on mono's common-frontend shadow",
    );

    // Pre-integration check: backend's shadow must NOT yet see Ff1, because
    // Ff1'_mono lives only on origin/shadow/common-frontend/main and not on
    // origin/main. The branch-filter ["main"] rules out the shadow ref as a
    // walk root.
    {
      const r = runSync({ from: "a" });
      assertEqual(r.exitCode, 0, `[Phase 4 pre-integration --from a] ${r.stderr.slice(0, 300)}`);
    }
    git("fetch backend", mono.working);
    assertEqual(
      readAtRef(mono, "backend/shadow/common-backend/main", "src/common/util.ts"), "v1\n",
      "[Phase 4] backend's shadow tip stays at v1 before integration",
    );
    assertEqual(
      findReplay(mono, "backend/shadow/common-backend/main", "origin", Ff1_mono), null,
      "[Phase 4] Ff1'_mono must not leak onto backend's shadow before integration",
    );

    // ── Phase 5: Mira integrates frontend's view via a side branch ──────────
    git("checkout -b pull-frontend", mono.working);
    mergeRef(mono, "origin/shadow/common-frontend/main", "mira: merge frontend shadow");
    git("checkout main", mono.working);
    const Mf1 = mergeRef(mono, "pull-frontend", "Mf1: merge pull-frontend into main");
    git("push origin main", mono.working);
    assertEqual(
      readAtRef(mono, "main", "common/util.ts"), "v2-fe\n",
      "[Phase 5] mono/main carries v2-fe after Mf1",
    );

    // ── Phase 6: --from a — Ff1 reaches backend with Fred's authorship ──────
    {
      const r = runSync({ from: "a" });
      assertEqual(r.exitCode, 0, `[Phase 6 sync --from a] ${r.stderr.slice(0, 300)}`);
    }
    git("fetch backend",  mono.working);
    git("fetch frontend", mono.working);

    // Core authorship invariant: Ff1'_mono carries a sibling-pair trailer but
    // is load-bearing for common-backend (touches common/), so it replays
    // onto backend's shadow as Ff1'_be with Fred's authorship intact.
    const Ff1_be = findReplay(mono, "backend/shadow/common-backend/main", "origin", Ff1_mono);
    if (!Ff1_be) throw new Error("Ff1'_be must replay onto backend's shadow");
    assertEqual(
      git(`log -1 --format=%ae ${Ff1_be}`, mono.working), "fred@example.com",
      "[Phase 6] Ff1'_be carries Fred's authorship on backend's shadow",
    );

    const Mf1_be = findReplay(mono, "backend/shadow/common-backend/main", "origin", Mf1);
    if (!Mf1_be) throw new Error("Mf1'_be not found on backend's shadow");
    assertEqual(
      readAtRef(mono, Mf1_be, "src/common/util.ts"), "v2-fe\n",
      "[Phase 6] backend shadow tip carries v2-fe",
    );
    assertEqual(
      git(`log -1 --format=%ae ${Mf1_be}`, mono.working), "mira@example.com",
      "[Phase 6] Mf1'_be (integration merge) is authored by Mira",
    );

    // ── Phase 7: Bea integrates via side branch + her own tweak ─────────────
    // The tweak (Bb1) gives the round-trip a real content delta to ride on,
    // so the rest of the cycle's merges aren't path-pruned as TREESAME.
    git("fetch origin shadow/common-backend/main", backend.working);
    git("checkout -b pull-mono", backend.working);
    mergeRef(backend, "origin/shadow/common-backend/main", "bea: merge mono shadow");
    const Bb1 = commitFiles(backend, { "src/common/util.ts": "v2-fe\n// be-confirmed\n" }, "Bb1: backend confirms");
    git("checkout main", backend.working);
    const Bm1 = mergeRef(backend, "pull-mono", "Bm1: merge pull-mono into main");
    git("push origin main", backend.working);
    assertEqual(
      readAtRef(backend, "main", "src/common/util.ts"), "v2-fe\n// be-confirmed\n",
      "[Phase 7] backend/main carries v2-fe + Bea's tweak",
    );

    // ── Phase 8: --from b — Bm1 + Bb1 return to mono via common-backend ─────
    {
      const r = runSync({ from: "b" });
      assertEqual(r.exitCode, 0, `[Phase 8 sync --from b] ${r.stderr.slice(0, 300)}`);
    }
    git("fetch origin", mono.working);

    const Bb1_mono = findReplay(mono, "origin/shadow/common-backend/main", "backend", Bb1);
    if (!Bb1_mono) throw new Error("Bb1'_mono not found on origin/shadow/common-backend/main");
    assertEqual(
      git(`log -1 --format=%ae ${Bb1_mono}`, mono.working), "bea@example.com",
      "[Phase 8] Bb1'_mono is authored by Bea",
    );
    assertEqual(
      readAtRef(mono, "origin/shadow/common-backend/main", "common/util.ts"),
      "v2-fe\n// be-confirmed\n",
      "[Phase 8] mono's common-backend shadow tip carries Bea's tweak",
    );

    // ── Phase 9: Mira integrates backend's view back via side branch ────────
    git("checkout -b pull-backend", mono.working);
    mergeRef(mono, "origin/shadow/common-backend/main", "mira: merge backend shadow");
    git("checkout main", mono.working);
    const Mb1 = mergeRef(mono, "pull-backend", "Mb1: merge pull-backend into main");
    git("push origin main", mono.working);
    assertEqual(
      readAtRef(mono, "main", "common/util.ts"), "v2-fe\n// be-confirmed\n",
      "[Phase 9] mono/main carries Bea's tweak after Mb1",
    );

    // ── Phase 10: --from a — Bb1 reaches frontend's shadow as cross-pair ────
    {
      const r = runSync({ from: "a" });
      assertEqual(r.exitCode, 0, `[Phase 10 sync --from a] ${r.stderr.slice(0, 300)}`);
    }
    git("fetch frontend", mono.working);
    git("fetch backend",  mono.working);

    // Cross-pair flow mirror of Phase 6: Bb1'_mono carries the common-backend
    // sibling-pair trailer, replays onto frontend's shadow with Bea's author.
    const Bb1_fe = findReplay(mono, "frontend/shadow/common-frontend/main", "origin", Bb1_mono);
    if (!Bb1_fe) throw new Error("Bb1'_fe must replay onto frontend's shadow (cross-pair)");
    assertEqual(
      git(`log -1 --format=%ae ${Bb1_fe}`, mono.working), "bea@example.com",
      "[Phase 10] Bb1'_fe carries Bea's authorship on frontend's shadow",
    );

    const Mb1_fe = findReplay(mono, "frontend/shadow/common-frontend/main", "origin", Mb1);
    if (!Mb1_fe) throw new Error("Mb1'_fe not found on frontend's shadow");
    assertEqual(
      readAtRef(mono, Mb1_fe, "src/common/util.ts"), "v2-fe\n// be-confirmed\n",
      "[Phase 10] frontend shadow tip carries the round-trip content",
    );
    assertEqual(
      git(`log -1 --format=%ae ${Mb1_fe}`, mono.working), "mira@example.com",
      "[Phase 10] Mb1'_fe is authored by Mira",
    );

    // ── Phase 11: Fred integrates the round-trip via side branch ────────────
    git("fetch origin shadow/common-frontend/main", frontend.working);
    git("checkout -b pull-mono", frontend.working);
    mergeRef(frontend, "origin/shadow/common-frontend/main", "fred: merge mono shadow");
    git("checkout main", frontend.working);
    const Fm1 = mergeRef(frontend, "pull-mono", "Fm1: merge pull-mono into main");
    git("push origin main", frontend.working);
    assertEqual(
      readAtRef(frontend, "main", "src/common/util.ts"), "v2-fe\n// be-confirmed\n",
      "[Phase 11] frontend/main carries the full round-trip content",
    );

    // ── Phase 12: --from b — Fm1 closes the circle on mono ──────────────────
    {
      const r = runSync({ from: "b" });
      assertEqual(r.exitCode, 0, `[Phase 12 sync --from b] ${r.stderr.slice(0, 300)}`);
    }
    git("fetch origin", mono.working);

    const Fm1_mono = findReplay(mono, "origin/shadow/common-frontend/main", "frontend", Fm1);
    if (!Fm1_mono) throw new Error("Fm1'_mono not found on origin/shadow/common-frontend/main");
    assertEqual(
      git(`log -1 --format=%ae ${Fm1_mono}`, mono.working), "fred@example.com",
      "[Phase 12] Fm1'_mono is authored by Fred (the integrator)",
    );

    // ── Cycle-wide invariants ───────────────────────────────────────────────
    // Fred's original Ff1 must not be duplicated when the cycle returns to
    // frontend: Ff1'_mono is an echo on the common-frontend pair (its trailer
    // maps it back to Ff1), so re-syncing mono→frontend does not create a
    // Ff1'_fe alias on frontend's shadow.
    const Ff1_trailer = `Shadow-replayed-common-frontend-frontend: ${Ff1}`;
    const feShadowLog = git("log frontend/shadow/common-frontend/main --format=%H%n%B%n---END---", mono.working);
    const Ff1_aliases = feShadowLog.split("---END---").filter(b => b.includes(Ff1_trailer)).length;
    assertEqual(
      Ff1_aliases, 0,
      `[cycle] Fred's original Ff1 must not be re-replayed onto frontend's shadow (found ${Ff1_aliases} alias(es))`,
    );

    // No duplicate commit SHAs on any shadow ref across the full cycle.
    for (const ref of [
      "frontend/shadow/common-frontend/main",
      "backend/shadow/common-backend/main",
      "origin/shadow/common-frontend/main",
      "origin/shadow/common-backend/main",
    ]) {
      const commits = git(`log ${ref} --format=%H`, mono.working).split("\n").filter(Boolean);
      assertEqual(
        new Set(commits).size, commits.length,
        `[cycle no-dup] ${ref} has no duplicate commit SHAs`,
      );
    }
  } finally {
    setBranchFiltersForTesting(new Map());
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-cross-pair-common");
}
