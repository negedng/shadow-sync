// Incremental settled-skip: on a second sync of an unchanged source, commits a
// prior sync already settled as DROPPED (inert merges, empty commits) must not be
// re-run through the load-bearing diff-tree check. They're reachable from the
// per-branch frontier of newest-replayed commits, so their immutable drop verdict
// is skipped. Exercises the root-source (--from b) direction, where every merge is
// a candidate and inert merges otherwise hit the expensive sliceChangedVsParent
// path every sync. Asserts: nothing new replays on sync 2 (shadow tip unchanged),
// and the scan reports a non-zero settled-dropped skip count.
import { execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runSync } from "../shadow-sync";
import { applyTestOverrides, setBranchFiltersForTesting, compileIgnorePattern } from "../shadow-common";
import { assertEqual, AssertionError } from "./assert";

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-test-settled-skip-"));
  try {
    const backend = createRepo(tmp, "backend", { email: "be@x.com", name: "Be" });
    const mono = createRepo(tmp, "mono", { email: "mo@x.com", name: "Mo" });
    git(`remote add backend "${backend.bare}"`, mono.working);

    // Root source on the b side: backend's whole tree -> mono's be/. So `--from b`
    // is root-sourced (anyRootSource true) and the candidate filter is a no-op.
    applyTestOverrides({
      repoRoot: mono.working,
      pairs: [{ name: "be", a: { remote: "origin", url: mono.bare }, b: { remote: "backend", url: backend.bare }, mappings: [{ a: "be", b: "" }] }],
      shadowBranchPrefix: "shadow",
    });
    setBranchFiltersForTesting(new Map<string, RegExp[]>([
      ["origin", ["main"].map(compileIgnorePattern)],
      ["backend", ["main"].map(compileIgnorePattern)],
    ]));

    // Target needs an init commit on main for the anchor/fallback root.
    commit(mono, { "README.md": "# mono\n" }, "mono seed");
    git("push origin main", mono.working);

    // Backend trunk with provably-DROPPED commits below a kept tip:
    //   c0(real) - c1(real) - e1(empty,drop) - c2(real) - m(inert -s ours,drop) - c3(real)
    // plus an empty side commit folded by the inert merge.
    commit(backend, { "f0.ts": "v0\n" }, "c0 real");
    const c1 = commit(backend, { "f1.ts": "v1\n" }, "c1 real");
    git('commit --allow-empty -m "e1 empty"', backend.working);       // non-merge drop
    commit(backend, { "f2.ts": "v2\n" }, "c2 real");
    // Inert merge: side has only an empty commit; -s ours keeps trunk's tree, so
    // the merge is treesame-to-first-parent => dropped, and the side commit is
    // empty => dropped. Neither contributes kept content.
    git(`checkout -b side ${c1}`, backend.working);
    git('commit --allow-empty -m "se empty side"', backend.working);
    git("checkout main", backend.working);
    git('merge -s ours side -m "m inert merge"', backend.working);    // merge drop
    commit(backend, { "f3.ts": "v3\n" }, "c3 real");
    git("push origin main", backend.working);

    // ── Sync 1: import backend -> mono shadow. Kept commits get mapped; the empty
    //    commits and the inert merge are dropped (not replayed).
    const r1 = runSync({ from: "b" });
    assertEqual(r1.exitCode, 0, `sync 1 --from b failed: ${r1.stderr.slice(0, 300)}`);
    git("fetch origin", mono.working);
    const tip1 = git("rev-parse origin/shadow/be/main", mono.working);

    // Synced content reached the shadow (root -> be/).
    const f3 = execSync("git show origin/shadow/be/main:be/f3.ts", { cwd: mono.working, encoding: "utf8" }).replace(/\r\n/g, "\n");
    assertEqual(f3, "v3\n", "c3 content must reach the shadow on sync 1");

    // ── Sync 2: no source change. The dropped commits are now settled (reachable
    //    from the frontier = newest-replayed c3) and must be skipped, not re-diffed.
    const r2 = runSync({ from: "b" });
    assertEqual(r2.exitCode, 0, `sync 2 --from b failed: ${r2.stderr.slice(0, 300)}`);
    git("fetch origin", mono.working);
    const tip2 = git("rev-parse origin/shadow/be/main", mono.working);

    // Behavior-preserving: nothing new replayed, shadow tip unchanged.
    assertEqual(tip2, tip1, "sync 2 must not advance the shadow tip (no new replays)");

    // The scan must report the dropped commits as settled-skipped (>= 2: the empty
    // commit + the inert merge; the empty side commit may add to this).
    const m = r2.stdout.match(/(\d+) settled-dropped/);
    if (!m) throw new AssertionError(`no settled-dropped count in scan summary:\n${r2.stdout.slice(-800)}`);
    const settledDropped = +m[1];
    console.log(`settled-dropped skipped on sync 2: ${settledDropped}`);
    if (settledDropped < 2) throw new AssertionError(`expected >= 2 settled-dropped, got ${settledDropped}`);

    // And no commit was re-scanned anew (source unchanged since the frontier).
    const newScan = r2.stdout.match(/Scanning (\d+) new source commit/);
    if (newScan && +newScan[1] !== 0) {
      throw new AssertionError(`expected 0 new commits to scan on sync 2, got ${newScan[1]}`);
    }

    console.log("PASS — settled-skip: dropped commits skipped on re-sync, shadow tip stable.");
  } finally {
    setBranchFiltersForTesting(new Map());
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

run();
