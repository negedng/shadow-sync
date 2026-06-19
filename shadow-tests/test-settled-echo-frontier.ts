// Settled-frontier must be anchored on DIRECT replays only, never echoes.
//
// computeSettledCommits walks each branch's first-parent line to the newest
// MAPPED commit and declares it + its ancestry "settled" — verdicts immutable,
// skipped in the load-bearing scan (treated as dropped-by-a-prior-sync). That
// claim is sound only for commits a prior SAME-FROM sync actually replayed: their
// whole ancestry was given a keep/drop verdict back then. An echo (a source
// commit carrying this pair's target-direction trailer) is pre-mapped by
// addEchoMappings, but it was authored by the REVERSE direction and carries no
// such guarantee. If an echo sits on the first-parent line ABOVE a genuinely-new
// source commit, anchoring the frontier on it marks that new commit settled and
// silently drops it from the scan — it never replays.
//
// Repro: backend trunk  R - C_new - E'  where sync 1 maps R (a direct replay),
// C_new is a genuine new backend commit, and E' is an echo (real
// target-direction trailer pointing at a live mono commit) stacked on top. On
// sync 2, C_new must be scanned as load-bearing, replayed, AND land on the shadow
// branch. Two coupled defects, both anchoring a first-parent walk on the echo:
//   1. computeSettledCommits marks C_new "settled" -> it's never scanned/replayed.
//   2. mapBranchesToTargetTips picks the echo's foreign target as the shadow tip,
//      so even a replayed C_new' never reaches the branch (non-ff push).
// The fixes: settled is computed from direct replays only (pre-echo), and the
// tip walk is monotonic (rejects an echo whose target diverges from C_new').
import { execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runSync } from "../shadow-sync";
import { applyTestOverrides, setBranchFiltersForTesting, compileIgnorePattern } from "../shadow-common";
import { assertEqual, assertIncludes, AssertionError } from "./assert";

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}
function writeRepoConfig(workDir: string, id: { email: string; name: string }) {
  fs.appendFileSync(path.join(workDir, ".git", "config"),
    `[user]\n\temail = ${id.email}\n\tname = ${id.name}\n[core]\n\tautocrlf = false\n`);
}
interface Repo { bare: string; working: string }
function createRepo(tmp: string, name: string, id: { email: string; name: string }): Repo {
  const bare = path.join(tmp, `${name}-bare`).replace(/\\/g, "/");
  const working = path.join(tmp, `${name}-working`).replace(/\\/g, "/");
  fs.mkdirSync(bare);
  git("init --bare --initial-branch=main", bare);
  execSync(`git clone "${bare}" "${working}"`, { stdio: "pipe" });
  writeRepoConfig(working, id);
  git("symbolic-ref HEAD refs/heads/main", working);
  return { bare, working };
}
function commit(repo: Repo, files: Record<string, string>, msg: string): string {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(repo.working, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  git("add -A", repo.working);
  git(`commit -m "${msg}"`, repo.working);
  return git("rev-parse HEAD", repo.working);
}

function run(): void {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-test-settled-echo-"));
  try {
    const backend = createRepo(tmp, "backend", { email: "be@x.com", name: "Be" });
    const mono = createRepo(tmp, "mono", { email: "mo@x.com", name: "Mo" });
    git(`remote add backend "${backend.bare}"`, mono.working);

    // Root source on the b side: backend root -> mono be/.
    applyTestOverrides({
      repoRoot: mono.working,
      pairs: [{ name: "be", a: { remote: "origin", url: mono.bare, label: "a-be" }, b: { remote: "backend", url: backend.bare, label: "b-be" }, mappings: [{ a: "be", b: "" }] }],
      shadowBranchPrefix: "shadow",
    });
    setBranchFiltersForTesting(new Map<string, RegExp[]>([
      ["origin", ["main"].map(compileIgnorePattern)],
      ["backend", ["main"].map(compileIgnorePattern)],
    ]));

    // mono target seed + a real commit object the echo trailer can point at.
    const monoSeed = commit(mono, { "README.md": "# mono\n" }, "mono seed");
    git("push origin main", mono.working);

    // Backend base R, then sync 1 maps it (R becomes a DIRECT replay on the shadow).
    commit(backend, { "f0.ts": "v0\n" }, "R base");
    git("push origin main", backend.working);
    const r1 = runSync({ from: "b" });
    assertEqual(r1.exitCode, 0, `sync 1 --from b failed: ${r1.stderr.slice(0, 300)}`);
    git("fetch origin", mono.working);
    const f0 = execSync("git show origin/b-be/main:be/f0.ts", { cwd: mono.working, encoding: "utf8" }).replace(/\r\n/g, "\n");
    assertEqual(f0, "v0\n", "R content must reach the shadow on sync 1");

    // A genuinely-new backend commit that MUST be scanned + replayed on sync 2.
    commit(backend, { "f1.ts": "v1\n" }, "C_new genuine backend change");

    // An echo stacked on top: a backend commit carrying this pair's
    // target-direction trailer (a-be-to-b-be) pointing at a live mono commit.
    // This is exactly what addEchoMappings keys on; on the first-parent line ABOVE
    // C_new it becomes the (unsound) settled frontier.
    commit(backend, { "f2.ts": "v2\n" }, "echo placeholder");
    git(`commit --amend -m "echo of mono seed" -m "a-be-to-b-be: ${monoSeed}"`, backend.working);
    git("push origin main", backend.working);

    // Sanity: the echo really carries the trailer git (and the engine) will parse.
    const echoTrailer = git('log -1 --format=%(trailers:key=a-be-to-b-be,valueonly)', backend.working);
    assertEqual(echoTrailer, monoSeed, "echo commit must carry the a-be-to-b-be trailer git can read");

    // ── Sync 2: C_new sits BELOW the echo on the first-parent line. It must be
    //    scanned as load-bearing and replayed, NOT settled-dropped behind the echo.
    const r2 = runSync({ from: "b" });
    assertEqual(r2.exitCode, 0, `sync 2 --from b failed: ${r2.stderr.slice(0, 300)}`);

    // C_new must not be classified as settled-dropped (the bug drops it here).
    const dropped = r2.stdout.match(/(\d+) settled-dropped/);
    if (!dropped) throw new AssertionError(`no scan summary in:\n${r2.stdout.slice(-800)}`);
    assertEqual(+dropped[1], 0,
      `C_new must not be settled-dropped behind the echo (got ${dropped[1]} settled-dropped)\n${r2.stdout.slice(-800)}`);

    // And it must actually replay.
    assertIncludes(r2.stdout, "C_new genuine backend change",
      `C_new must be replayed on sync 2, not skipped\n${r2.stdout.slice(-800)}`);

    const loadBearing = r2.stdout.match(/(\d+) new load-bearing commit/);
    if (!loadBearing || +loadBearing[1] < 1) {
      throw new AssertionError(`expected >= 1 new load-bearing commit (C_new), got ${loadBearing?.[1]}\n${r2.stdout.slice(-800)}`);
    }

    // End-to-end: C_new's content must actually reach the shadow branch — the tip
    // walk must follow C_new', not jump to the echo's foreign target.
    git("fetch origin", mono.working);
    const f1 = (() => {
      try {
        return execSync("git show origin/b-be/main:be/f1.ts", { cwd: mono.working, encoding: "utf8" }).replace(/\r\n/g, "\n");
      } catch { return null; }
    })();
    assertEqual(f1, "v1\n", "C_new's file must reach the shadow branch tip (tip walk must not anchor on the echo)");

    console.log("PASS — settled-echo-frontier: a genuine commit below an echo is replayed and reaches the shadow tip.");
  } finally {
    setBranchFiltersForTesting(new Map());
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

run();
