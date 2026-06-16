/**
 * test-blame-noop-flicker.ts — what `git blame` / path-scoped `git log` attribute
 * when a net-no-op side carries a commit-by-commit flicker, under FF vs --no-ff.
 *
 * Scenario (the "backend & frontend both reach the same common" case):
 *   - backend reaches common/util.ts = "v2"  DIRECTLY            (Bb,   by Bea)
 *   - frontend reaches the SAME "v2" via a detour v1->mid->v2    (Fmid+Ffin, by Fred)
 *   - mono merges backend's shadow first, then frontend's shadow (frontend = net no-op)
 *
 * Findings (proven via the real runSync engine, not synthetic git):
 *   MONO:  the frontend merge is TREESAME to its first parent (the backend side),
 *          so blame(common) -> backend's commit, and path-log(common) hides "mid".
 *   BACKEND LEAF (merge-order WINNER): the frontend flicker is in backend's shadow
 *          but on the SECOND parent of a replayed TREESAME merge (the engine
 *          preserves mono's topology — it does NOT linearize). So --no-ff AND a
 *          fast-forward both give blame(common) -> backend's own commit; the leaf's
 *          merge mode is irrelevant for the winner.
 *   FRONTEND LEAF (merge-order LOSER): the asymmetry. frontend sits on a SECOND
 *          parent everywhere (mono merged backend first), so:
 *            --no-ff -> the integration merge re-asserts frontend/main as first
 *                       parent  -> blame stays on frontend's own commit.
 *            FF      -> frontend/main adopts the shadow tip whose first-parent
 *                       chain is the backend side -> blame FLIPS to backend.
 *          => --no-ff is load-bearing for the loser. This is why mergeShadow/
 *             mergeRef integrate with --no-ff.
 *   The flicker surfaces ONLY in the unscoped whole-repo `git log` (no pathspec ->
 *   no history simplification) and in `git log --full-history -- <file>`.
 *   IDE GRAPH: VS Code's Source Control Graph does NOT run `git log --graph`.
 *          Per microsoft/vscode (historyProvider.ts -> git.ts log()), it fetches
 *          `git log --format='%H%n%aN%n%aE%n%at%n%ct%n%P%n%D%n%B' -z --shortstat
 *          <refs>` (git's DEFAULT order, %P = parent hashes) and lays out the lanes
 *          CLIENT-SIDE. The visual result — the merged-in lane grouped together,
 *          ABOVE your own commit REGARDLESS of commit date — matches `--topo-order`
 *          on the CLI (used here as a proxy), NOT `--date-order`. It is a full-DAG
 *          view: both sides visible, no path simplification. Own-only = --first-parent.
 */
import { execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runSync } from "../shadow-sync";
import { applyTestOverrides, setBranchFiltersForTesting, compileIgnorePattern } from "../shadow-common";
import { assertEqual, assertIncludes, assertNotIncludes } from "./assert";

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}
function tryGit(cmd: string, cwd: string): { ok: boolean; out: string } {
  try { return { ok: true, out: git(cmd, cwd) }; }
  catch (e: any) { return { ok: false, out: String(e?.stderr ?? e?.message ?? e) }; }
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

/** `date` pins author+committer date (replay preserves both), making --date-order assertions deterministic. */
function commitFiles(repo: Repo, files: Record<string, string | null>, msg: string, date?: string): string {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(repo.working, rel);
    if (content === null) { if (fs.existsSync(full)) fs.unlinkSync(full); }
    else { fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, content); }
  }
  git("add -A", repo.working);
  if (date) {
    execSync(`git commit -m "${msg}"`, { cwd: repo.working, encoding: "utf8", stdio: "pipe",
      env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
  } else {
    git(`commit -m "${msg}"`, repo.working);
  }
  return git("rev-parse HEAD", repo.working);
}

function mergeRef(repo: Repo, ref: string, msg: string): string {
  git(`merge --no-ff ${ref} -m "${msg}"`, repo.working);
  return git("rev-parse HEAD", repo.working);
}

/** Summary line of the commit that blame attributes a given line to, at `ref`. */
function blameSummary(repo: Repo, ref: string, file: string, line: number): string {
  const out = execSync(`git blame ${ref} -L ${line},${line} --line-porcelain -- ${file}`, {
    cwd: repo.working, encoding: "utf8", maxBuffer: 50 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"],
  });
  const s = out.split("\n").find(l => l.startsWith("summary "));
  return s ? s.slice("summary ".length).trim() : "(none)";
}
function blameAuthorEmail(repo: Repo, ref: string, file: string, line: number): string {
  const out = execSync(`git blame ${ref} -L ${line},${line} --line-porcelain -- ${file}`, {
    cwd: repo.working, encoding: "utf8", maxBuffer: 50 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"],
  });
  const s = out.split("\n").find(l => l.startsWith("author-mail "));
  return s ? s.slice("author-mail ".length).trim().replace(/[<>]/g, "") : "(none)";
}
/** Path-scoped subjects (history simplification ON, like VS Code file history). */
function pathLog(repo: Repo, ref: string, file: string): string {
  return git(`log ${ref} --format=%s -- ${file}`, repo.working);
}
function pathLogFull(repo: Repo, ref: string, file: string): string {
  return git(`log --full-history ${ref} --format=%s -- ${file}`, repo.working);
}
/** Is the tip of `ref` a merge whose tree equals its first parent's, on `file`? */
function isTreesameToFirstParent(repo: Repo, ref: string, file: string): boolean {
  const parents = git(`rev-list --parents -1 ${ref}`, repo.working).split(" ").slice(1);
  if (parents.length < 2) return false;
  // ~1 == first parent (^1), but avoids the `^` that Windows cmd would strip.
  return git(`diff ${ref}~1 ${ref} -- ${file}`, repo.working) === "";
}

export default function run(): void {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-test-blame-noop-flicker-"));
  const MONO_FILE = "common/util.ts";
  const EXT_FILE = "src/common/util.ts";

  try {
    const backend  = createRepo(tmpDir, "backend",  { email: "bea@example.com",  name: "Bea"  });
    const frontend = createRepo(tmpDir, "frontend", { email: "fred@example.com", name: "Fred" });
    const mono     = createRepo(tmpDir, "mono",     { email: "mira@example.com", name: "Mira" });

    git(`remote add backend "${backend.bare}"`, mono.working);
    git(`remote add frontend "${frontend.bare}"`, mono.working);

    applyTestOverrides({
      repoRoot: mono.working,
      pairs: [
        { name: "common-backend",  a: { remote: "origin", url: mono.bare, label: "a-common-backend"  }, b: { remote: "backend",  url: backend.bare,  label: "b-common-backend"  }, mappings: [{ a: "common", b: "src/common" }] },
        { name: "common-frontend", a: { remote: "origin", url: mono.bare, label: "a-common-frontend" }, b: { remote: "frontend", url: frontend.bare, label: "b-common-frontend" }, mappings: [{ a: "common", b: "src/common" }] },
      ],
      shadowBranchPrefix: "shadow",
    });
    setBranchFiltersForTesting(new Map<string, RegExp[]>([
      ["origin", ["main"].map(compileIgnorePattern)],
      ["backend", ["main"].map(compileIgnorePattern)],
      ["frontend", ["main"].map(compileIgnorePattern)],
    ]));

    // ── Phase 1: seed all three at v1, bootstrap shadow refs both directions ──
    commitFiles(backend,  { [EXT_FILE]: "v1\n" }, "be init");
    git("push origin main", backend.working);
    commitFiles(frontend, { [EXT_FILE]: "v1\n" }, "fe init");
    git("push origin main", frontend.working);
    commitFiles(mono, { "README.md": "# Monorepo\n", [MONO_FILE]: "v1\n" }, "Mc0");
    git("push origin main", mono.working);
    assertEqual(runSync({ from: "b" }).exitCode, 0, "[bootstrap --from b]");
    assertEqual(runSync({ from: "a" }).exitCode, 0, "[bootstrap --from a]");

    // ── Phase 2: backend reaches v2 DIRECTLY ─────────────────────────────────
    // Pin backend NEWER than frontend so date-order and topo-order DISAGREE:
    // date-order would float Bb (newest) to the top; topo-order keeps the
    // frontend lane grouped on its second parent. This is how we tell which
    // ordering VS Code's graph actually uses.
    commitFiles(backend, { [EXT_FILE]: "v2\n" }, "Bb backend sets v2 (direct)", "2026-01-01T10:20:00");
    git("push origin main", backend.working);

    // ── Phase 3: frontend reaches the SAME v2 via a mid flicker (OLDER dates) ─
    commitFiles(frontend, { [EXT_FILE]: "mid\n" }, "Fmid frontend detour to mid", "2026-01-01T10:05:00");
    commitFiles(frontend, { [EXT_FILE]: "v2\n" }, "Ffin frontend lands on v2", "2026-01-01T10:10:00");
    git("push origin main", frontend.working);

    // ── Phase 4: pull both into mono's shadows ───────────────────────────────
    assertEqual(runSync({ from: "b" }).exitCode, 0, "[Phase 4 --from b]");
    git("fetch origin", mono.working);

    // ── Phase 5: Mira merges BACKEND shadow first, then FRONTEND shadow ───────
    mergeRef(mono, "origin/b-common-backend/main",  "Mb mira merges backend shadow");
    mergeRef(mono, "origin/b-common-frontend/main", "Mf mira merges frontend shadow (net no-op)");
    git("push origin main", mono.working);

    assertEqual(git(`show main:${MONO_FILE}`, mono.working).trim(), "v2", "[Phase 5] mono/main common == v2");

    console.log("── MONO after backend-then-frontend merge ──");
    console.log("  Mf TREESAME-to-first-parent on common:", isTreesameToFirstParent(mono, "main", MONO_FILE));
    console.log("  blame(mono common) summary:", JSON.stringify(blameSummary(mono, "main", MONO_FILE, 1)));
    console.log("  blame(mono common) author:", blameAuthorEmail(mono, "main", MONO_FILE, 1));
    console.log("  path-log(mono common):\n" + pathLog(mono, "main", MONO_FILE).replace(/^/gm, "      "));
    console.log("  full-history(mono common):\n" + pathLogFull(mono, "main", MONO_FILE).replace(/^/gm, "      "));

    assertEqual(blameAuthorEmail(mono, "main", MONO_FILE, 1), "bea@example.com",
      "[MONO] blame on common points to BACKEND (Bea), frontend merge is the no-op");
    assertNotIncludes(pathLog(mono, "main", MONO_FILE), "mid",
      "[MONO] path-log hides the frontend 'mid' flicker (pruned at the TREESAME merge)");
    assertIncludes(pathLogFull(mono, "main", MONO_FILE), "mid",
      "[MONO] --full-history still reveals the 'mid' flicker");

    // ── Phase 6: round-trip --from a — frontend flicker lands in backend shadow ─
    assertEqual(runSync({ from: "a" }).exitCode, 0, "[Phase 6 --from a]");
    git("fetch origin a-common-backend/main", backend.working);

    // Sanity: the frontend-origin flicker really reached backend's shadow.
    const beShadow = "origin/a-common-backend/main";
    assertIncludes(pathLogFull(backend, beShadow, EXT_FILE), "mid",
      "[Phase 6] backend's shadow carries the frontend 'mid' flicker (full-history)");

    // ── Phase 7a: backend leaf integrates with --no-ff (the design default) ──
    git("checkout -b int-noff main", backend.working);
    git(`merge --no-ff ${beShadow} -m "Bea integrates (no-ff)"`, backend.working);
    console.log("\n── BACKEND LEAF: --no-ff integration ──");
    const noffTreesame = isTreesameToFirstParent(backend, "int-noff", EXT_FILE);
    console.log("  merge TREESAME-to-first-parent on common:", noffTreesame);
    console.log("  blame(common) summary:", JSON.stringify(blameSummary(backend, "int-noff", EXT_FILE, 1)));
    console.log("  blame(common) author:", blameAuthorEmail(backend, "int-noff", EXT_FILE, 1));
    console.log("  path-log(common):\n" + pathLog(backend, "int-noff", EXT_FILE).replace(/^/gm, "      "));

    assertIncludes(git(`log int-noff --format=%s`, backend.working), "Fmid",
      "[BACKEND no-ff] the flicker is still present in the UNSCOPED whole-repo log");
    console.log("  'mid' in UNSCOPED whole-repo log: true (path simplification is off without a pathspec)");
    console.log("  topology:\n" + git(`log int-noff --graph --oneline --format=%s`, backend.working).replace(/^/gm, "      "));

    // ── Phase 7b: backend leaf integrates with a FAST-FORWARD ────────────────
    // The surprise: the engine replays mono's merge topology into the shadow,
    // so the frontend flicker sits on the SECOND parent of a TREESAME merge
    // (the shadow's own tip). A fast-forward therefore lands backend/main ONTO
    // that pruning merge — it does NOT linearize the flicker. So blame + path
    // log behave identically to --no-ff. (My earlier "FF leaks the flicker"
    // claim only holds for a hand-built LINEAR shadow, which the engine never
    // produces.)
    git("checkout -b int-ff main", backend.working);
    const ff = tryGit(`merge --ff-only ${beShadow}`, backend.working);
    console.log("\n── BACKEND LEAF: --ff-only integration ──");
    console.log("  fast-forward possible:", ff.ok);
    assertEqual(ff.ok, true, "[BACKEND ff] backend/main is an ancestor of the shadow, so FF is possible");
    console.log("  blame(common) author:", blameAuthorEmail(backend, "int-ff", EXT_FILE, 1));
    console.log("  path-log(common):\n" + pathLog(backend, "int-ff", EXT_FILE).replace(/^/gm, "      "));
    console.log("  topology:\n" + git(`log int-ff --graph --oneline --format=%s`, backend.working).replace(/^/gm, "      "));

    // Even under FF: blame stays on backend, path-log hides the flicker — because
    // the pruning merge is baked into the shadow, not the leaf's merge mode.
    assertEqual(blameAuthorEmail(backend, "int-ff", EXT_FILE, 1), "bea@example.com",
      "[BACKEND ff] blame STILL points to backend's own commit (engine preserved the merge)");
    assertNotIncludes(pathLog(backend, "int-ff", EXT_FILE), "mid",
      "[BACKEND ff] path-log STILL hides the 'mid' flicker even after a fast-forward");
    assertIncludes(git(`log int-ff --format=%s`, backend.working), "Fmid",
      "[BACKEND ff] the flicker remains visible only in the UNSCOPED whole-repo log");

    // ── Phase 7c: which ordering does the IDE commit graph use? ──────────────
    // backend's Bb is the NEWEST commit now, so date-order and topo-order
    // disagree. Print both and let the output decide the model.
    console.log("\n── BACKEND LEAF: ordering comparison (Bb is newest) ──");
    const dateOrder = git(`log --graph --date-order --format=%s int-noff`, backend.working);
    const topoOrder = git(`log --graph --topo-order --format=%s int-noff`, backend.working);
    console.log("  --date-order:\n" + dateOrder.replace(/^/gm, "      "));
    console.log("  --topo-order:\n" + topoOrder.replace(/^/gm, "      "));
    console.log("  Fmid-before-Bb? date:", dateOrder.indexOf("Fmid") < dateOrder.indexOf("Bb backend"),
                "topo:", topoOrder.indexOf("Fmid") < topoOrder.indexOf("Bb backend"));

    // date-order floats the NEWEST commit (backend Bb) to the top:
    assertEqual(dateOrder.indexOf("Fmid") > dateOrder.indexOf("Bb backend"), true,
      "[date-order] newest commit (backend Bb) draws ABOVE the older frontend lane");
    // topo-order keeps the merged-in frontend lane grouped on its 2nd parent,
    // ABOVE backend's newer commit — DATE-INDEPENDENT. VS Code fetches with git's
    // DEFAULT order and lays out lanes client-side from %P; --topo-order is the
    // CLI proxy that reproduces what you SEE (it does NOT run `git log --graph`).
    assertEqual(topoOrder.indexOf("Fmid") < topoOrder.indexOf("Bb backend"), true,
      "[topo-order ~ VS Code layout] frontend lane stays grouped ABOVE backend's NEWER commit (date-independent)");
    assertIncludes(topoOrder, "Fmid",
      "[VS Code graph] the other side is visible — full DAG, no path simplification");
    assertNotIncludes(git(`log --topo-order --first-parent int-noff --format=%s`, backend.working), "Fmid",
      "[--first-parent] own-side only — the other lane disappears");

    // ── Phase 8: FRONTEND leaf — the merge-order LOSER ───────────────────────
    // mono merged backend FIRST, so on every shadow the frontend side sits on a
    // SECOND parent. Diagnostics-only for now: let git tell us whether FF vs
    // --no-ff actually changes blame on the losing side.
    const feShadow = "origin/a-common-frontend/main";
    git(`fetch origin a-common-frontend/main`, frontend.working);
    console.log("\n── FRONTEND SHADOW (after round-trip) full-history(common): ──");
    console.log(pathLogFull(frontend, feShadow, EXT_FILE).replace(/^/gm, "      "));

    git("checkout -b fe-int-noff main", frontend.working);
    git(`merge --no-ff ${feShadow} -m "Fred integrates (no-ff)"`, frontend.working);
    console.log("\n── FRONTEND LEAF: --no-ff integration ──");
    console.log("  TREESAME-to-first-parent on common:", isTreesameToFirstParent(frontend, "fe-int-noff", EXT_FILE));
    console.log("  blame(common) author:", blameAuthorEmail(frontend, "fe-int-noff", EXT_FILE, 1));
    console.log("  blame(common) summary:", JSON.stringify(blameSummary(frontend, "fe-int-noff", EXT_FILE, 1)));
    console.log("  path-log(common):\n" + pathLog(frontend, "fe-int-noff", EXT_FILE).replace(/^/gm, "      "));
    console.log("  topology:\n" + git(`log fe-int-noff --graph --oneline --format=%s`, frontend.working).replace(/^/gm, "      "));

    git("checkout -b fe-int-ff main", frontend.working);
    const feFf = tryGit(`merge --ff-only ${feShadow}`, frontend.working);
    console.log("\n── FRONTEND LEAF: --ff-only integration ──");
    console.log("  fast-forward possible:", feFf.ok);
    if (feFf.ok) {
      console.log("  blame(common) author:", blameAuthorEmail(frontend, "fe-int-ff", EXT_FILE, 1));
      console.log("  blame(common) summary:", JSON.stringify(blameSummary(frontend, "fe-int-ff", EXT_FILE, 1)));
      console.log("  path-log(common):\n" + pathLog(frontend, "fe-int-ff", EXT_FILE).replace(/^/gm, "      "));
    } else {
      console.log("  ff aborted:", feFf.out.split("\n")[0]);
    }

    // --no-ff: the integration merge re-asserts frontend/main as FIRST parent,
    // so blame stays on frontend's own commit even though frontend is the loser.
    assertEqual(blameAuthorEmail(frontend, "fe-int-noff", EXT_FILE, 1), "fred@example.com",
      "[FRONTEND no-ff] blame stays on frontend's OWN commit");
    // FF: frontend/main adopts the shadow tip, whose first-parent chain runs
    // through the BACKEND side (mono merged backend first) -> blame FLIPS to
    // backend. The merge-order loser loses its authorship under a fast-forward.
    assertEqual(feFf.ok, true,
      "[FRONTEND ff] FF is possible (frontend/main is an ancestor of the shadow)");
    assertEqual(blameAuthorEmail(frontend, "fe-int-ff", EXT_FILE, 1), "bea@example.com",
      "[FRONTEND ff] blame FLIPS to backend — frontend loses authorship under fast-forward");

    // ── Can plain whole-repo log be made own-only? Yes: --first-parent. ──────
    // The --no-ff integration makes the leaf's own branch the FIRST parent, so
    // walking only first parents never enters the other side.
    const beFP = git(`log --first-parent int-noff --format=%s`, backend.working);
    const feFP = git(`log --first-parent fe-int-noff --format=%s`, frontend.working);
    console.log("\n── git log --first-parent (own-only) ──");
    console.log("  backend  :", JSON.stringify(beFP.split("\n")));
    console.log("  frontend :", JSON.stringify(feFP.split("\n")));
    assertNotIncludes(beFP, "Fmid", "[backend --first-parent] frontend flicker excluded");
    assertNotIncludes(beFP, "Ffin", "[backend --first-parent] frontend final excluded");
    assertIncludes(beFP, "Bb backend", "[backend --first-parent] backend's own commit present");
    assertNotIncludes(feFP, "backend sets v2", "[frontend --first-parent] backend's commit excluded");
    assertIncludes(feFP, "Ffin", "[frontend --first-parent] frontend's own commit present");

    // ── Probe: shadow-branch blame across repos (for the who-do-I-see table) ──
    git("fetch origin", mono.working);
    for (const ref of ["origin/b-common-backend/main", "origin/b-common-frontend/main"]) {
      console.log(`\n── MONO shadow ref ${ref} ──`);
      console.log("  blame(common) author:", blameAuthorEmail(mono, ref, MONO_FILE, 1));
      console.log("  path-log(common):\n" + pathLog(mono, ref, MONO_FILE).replace(/^/gm, "      "));
      console.log("  whole-repo log has Fmid:", /(^|\n)Fmid/.test(git(`log ${ref} --format=%s`, mono.working)),
                  "/ Bb:", /(^|\n)Bb/.test(git(`log ${ref} --format=%s`, mono.working)));
    }

    console.log("\nSUMMARY");
    console.log("  BACKEND (merge-order WINNER): blame stays on backend in BOTH FF and --no-ff.");
    console.log("  FRONTEND (merge-order LOSER): --no-ff keeps frontend's authorship; FF flips it");
    console.log("    to backend. => the leaf's merge mode is load-bearing for the loser, which is");
    console.log("    why mergeShadow/mergeRef use --no-ff.");
    console.log("  Per-file log + blame prune the no-op side; the UNSCOPED whole-repo `git log`");
    console.log("  never simplifies, so it lists every commit regardless.");
  } finally {
    setBranchFiltersForTesting(new Map());
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  run();
  console.log("\nPASS  test-blame-noop-flicker");
}
