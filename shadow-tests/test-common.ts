import { execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runSync } from "../shadow-sync";
import { applyTestOverrides } from "../shadow-common";
import { assertEqual } from "./assert";

/**
 * Walks the sht6 extension in scenario.md (after the `---` separator).
 * Tests the dedicated common-pair mechanism with nested `dir` mappings:
 *   - backend canonical common at src/evntcore/common/
 *   - frontend canonical common at src/app/common/
 *   - monorepo carries one common/ at root
 *   - parent pairs shadowignore the canonical paths so common flows only
 *     via the dedicated common-* pairs
 *   - variant common files (eventus/edu-src/app/common/) stay in the parent
 *     pair and never reach monorepo/common/
 *
 * Branch named "main" stands in for "core-dev" — the engine's targetInit
 * lookup is hard-coded to `${target.remote}/main`.
 */

// ── Setup helpers (mirrors test-scenario.ts patterns) ───────────────────────

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

function listTreePaths(repo: Repo, ref: string): string[] {
  return git(`ls-tree -r --name-only ${ref}`, repo.working).split("\n").filter(Boolean);
}

function readAtRef(repo: Repo, ref: string, p: string): string {
  const raw = execSync(`git show ${ref}:${p}`, {
    cwd: repo.working, encoding: "utf8", maxBuffer: 50 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"],
  });
  return raw.replace(/\r\n/g, "\n");
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

// ── Main test ────────────────────────────────────────────────────────────────

export default function run() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-test-common-"));

  try {
    const backend  = createRepo(tmpDir, "backend",  { email: "bea@example.com",  name: "Bea"  });
    const frontend = createRepo(tmpDir, "frontend", { email: "fred@example.com", name: "Fred" });
    const mono     = createRepo(tmpDir, "mono",     { email: "mira@example.com", name: "Mira" });

    git(`remote add backend "${backend.bare}"`, mono.working);
    git(`remote add frontend "${frontend.bare}"`, mono.working);

    // ── Phase 0: Mature backend (Bc0) — common pre-existing at canonical path
    // .shadowignore at root excludes src/evntcore/common/ so the parent pair
    // never carries it (in either direction — see scenario.md A13).
    const Bc0 = commitFiles(backend, {
      "src/init.txt": "init\n",
      "src/evntcore/common/util.ts": "util v1\n",
      ".shadowignore": "src/evntcore/common/**\n",
    }, "Bc0");
    git("push origin main", backend.working);

    // ── Phase 0: Mature frontend (Fc0) — mirror; common util byte-identical
    const Fc0 = commitFiles(frontend, {
      "src/init.txt": "init\n",
      "src/app/common/util.ts": "util v1\n",
      ".shadowignore": "src/app/common/**\n",
    }, "Fc0");
    git("push origin main", frontend.working);

    // ── Phase 0: Init monorepo (Mc0) — parent shadowignores in place
    const Mc0 = commitFiles(mono, {
      "README.md": "# Monorepo\n",
      ".claude/settings.json": "{}\n",
      "backend/.shadowignore": "src/evntcore/common/**\n",
      "frontend/.shadowignore": "src/app/common/**\n",
    }, "Mc0");
    git("push origin main", mono.working);

    // 4-pair config: parent + dedicated common pairs, nested dir on the leaf side.
    applyTestOverrides({
      repoRoot: mono.working,
      pairs: [
        { name: "backend",         a: { remote: "origin", url: mono.bare, dir: "backend"  }, b: { remote: "backend",  url: backend.bare,  dir: "" } },
        { name: "frontend",        a: { remote: "origin", url: mono.bare, dir: "frontend" }, b: { remote: "frontend", url: frontend.bare, dir: "" } },
        { name: "common-backend",  a: { remote: "origin", url: mono.bare, dir: "common"   }, b: { remote: "backend",  url: backend.bare,  dir: "src/evntcore/common"   } },
        { name: "common-frontend", a: { remote: "origin", url: mono.bare, dir: "common"   }, b: { remote: "frontend", url: frontend.bare, dir: "src/app/common"        } },
      ],
      shadowBranchPrefix: "shadow",
    });
    void Bc0; void Fc0; void Mc0;

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
    assertPathAbsent(mono,  "origin/shadow/backend/main",  "backend/src/evntcore/common/util.ts", "[Phase 1 backend shadow] canonical common excluded");
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
    assertPathAbsent(mono, Mcm4, "backend/src/evntcore/common/util.ts", "[Phase 1 monorepo state] no nested canonical common under backend/");
    assertPathAbsent(mono, Mcm4, "frontend/src/app/common/util.ts", "[Phase 1 monorepo state] no nested canonical common under frontend/");

    // Leaves still hold their canonical common (sync did not touch them).
    assertContent(backend,  "main", "src/evntcore/common/util.ts", "util v1\n", "[Phase 1] backend canonical common preserved");
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

    assertContent(backend,  Bcm1, "src/evntcore/common/util.ts", "util v2\n", "[Phase 2] backend canonical = v2");
    assertContent(frontend, Fcm1, "src/app/common/util.ts",      "util v2\n", "[Phase 2] frontend canonical = v2");
    // Confirm v2 did NOT land at the leaves' roots or under unexpected paths.
    assertPathAbsent(backend,  Bcm1, "common/util.ts",    "[Phase 2] backend has no root-level common/");
    assertPathAbsent(backend,  Bcm1, "src/common/util.ts","[Phase 2] backend has no src/common/");
    assertPathAbsent(frontend, Fcm1, "common/util.ts",    "[Phase 2] frontend has no root-level common/");
    assertPathAbsent(frontend, Fcm1, "src/common/util.ts","[Phase 2] frontend has no src/common/");

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
    assertContent(backend, Bcm3, "src/evntcore/common/util.ts", "util v3\n", "[Phase 3] backend canonical common = v3");
    assertPathAbsent(backend, Bcm3, "src/component.ts", "[Phase 3] frontend slice did NOT leak to backend");

    assertPathPresent(frontend, Fcm3, "src/component.ts", "[Phase 3] frontend got component.ts via parent pair");
    assertContent(frontend, Fcm3, "src/component.ts", "component v1\n", "[Phase 3] frontend component.ts content");
    assertContent(frontend, Fcm3, "src/app/common/util.ts", "util v3\n", "[Phase 3] frontend canonical common = v3");
    assertPathAbsent(frontend, Fcm3, "src/api.ts", "[Phase 3] backend slice did NOT leak to frontend");

    // ── Phase 4: Variant non-interference ───────────────────────────────────
    // A file under backend/eventus/edu-src/app/common/ is a *variant* common file.
    // It must flow via the parent pair (because it's outside src/evntcore/common/),
    // and it must NOT appear in the common pair's shadow chain or in monorepo/common/.
    const Mcm7 = commitFiles(mono, {
      "backend/eventus/edu-src/app/common/variant-only.ts": "variant only\n",
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
    assertContent(backend, Bcm4, "eventus/edu-src/app/common/variant-only.ts", "variant only\n",
      "[Phase 4] variant file landed at variant path via parent pair");
    // Canonical common is unchanged by the variant addition.
    assertContent(backend, Bcm4, "src/evntcore/common/util.ts", "util v3\n",
      "[Phase 4] canonical common still at v3, variant did not leak in");

    // The common pair must not have picked up the variant file. On the
    // common-backend shadow (mono-shaped), the leaf's src/evntcore/common/
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
      "src/evntcore/common/util.ts": "util v3 leaf-stray\n",
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
    assertContent(backend,  "main", "src/evntcore/common/util.ts", "util v3 leaf-stray\n", "[Phase 5] backend (origin)");
    assertContent(mono,     "main", "common/util.ts",              "util v3 leaf-stray\n", "[Phase 5] monorepo");
    assertContent(frontend, Fcm4,   "src/app/common/util.ts",      "util v3 leaf-stray\n", "[Phase 5] frontend (propagated)");

    // ── Idempotence: a clean end state must produce no replays on re-sync ───
    for (const from of ["a", "b"] as const) {
      const r = runSync({ from });
      assertEqual(r.exitCode, 0, `[idempotence] --from ${from}: ${r.stderr.slice(0, 300)}`);
      const replayLines = r.stdout.split("\n").filter(l => /^\s*Replaying /.test(l));
      if (replayLines.length > 0) {
        throw new Error(
          `[idempotence] --from ${from} re-replayed commits on a clean end state:\n  ${replayLines.join("\n  ")}`,
        );
      }
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-common");
}
