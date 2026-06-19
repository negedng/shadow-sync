// Cherry-pick of an echo must still propagate. git cherry-pick copies the
// message verbatim, so the new commit keeps the *-to-* trailer (pointing at the
// ORIGINAL hash) but gets a fresh SHA. Echo detection keys on the trailer value,
// so a naive mapping would treat the cherry-pick as an echo of the original and
// DROP it — silently failing to propagate the reintroduced change.
//
// Repro: import backend -> mono (echoes carry b-be-to-a-be). Integrate into
// main. Then on mono main: (D) delete be/f1.ts, then cherry-pick the echo commit
// that ADDED be/f1.ts (re-adding it; new hash; same trailer). Export --from a.
// The genuine echo is the FIRST commit pointing at the target, so it is dropped;
// the cherry-pick is a SECOND commit pointing at the same target, so it must
// replay and reach the backend shadow.
import { execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runSync } from "../shadow-sync";
import { applyTestOverrides, setBranchFiltersForTesting, compileIgnorePattern } from "../shadow-common";
import { assertEqual } from "./assert";

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-test-cherrypick-echo-"));
  try {
    const backend = createRepo(tmp, "backend", { email: "be@x.com", name: "Be" });
    const mono = createRepo(tmp, "mono", { email: "mo@x.com", name: "Mo" });
    git(`remote add backend "${backend.bare}"`, mono.working);

    applyTestOverrides({
      repoRoot: mono.working,
      pairs: [{ name: "be", a: { remote: "origin", url: mono.bare, label: "a-be" }, b: { remote: "backend", url: backend.bare, label: "b-be" }, mappings: [{ a: "be", b: "" }] }],
      shadowBranchPrefix: "shadow",
    });
    setBranchFiltersForTesting(new Map<string, RegExp[]>([
      ["origin", ["main"].map(compileIgnorePattern)],
      ["backend", ["main"].map(compileIgnorePattern)],
    ]));

    // Backend history: f0, then c1 adds f1.ts.
    commit(backend, { "f0.ts": "v0\n" }, "be init");
    git("push origin main", backend.working);
    const c1 = commit(backend, { "f1.ts": "v1\n" }, "be c1 adds f1");
    git("push origin main", backend.working);

    // mono seed + import (backend -> mono shadow b-be/main, echoes carry b-be-to-a-be).
    commit(mono, { "README.md": "# mono\n" }, "mono seed");
    git("push origin main", mono.working);
    assertEqual(runSync({ from: "b" }).exitCode, 0, "import --from b failed");

    // Integrate the import into mono main: be/f0.ts, be/f1.ts now on main.
    git("fetch origin", mono.working);
    git("checkout main", mono.working);
    git('merge --no-ff origin/b-be/main -m "integrate backend"', mono.working);
    git("push origin main", mono.working);

    // The echo commit that ADDED be/f1.ts (carries b-be-to-a-be: <c1>).
    const echoAddF1 = git('log -1 --format=%H --grep="be c1 adds f1" origin/b-be/main', mono.working);
    const echoTrailer = git(`log -1 --format=%(trailers:key=b-be-to-a-be,valueonly) ${echoAddF1}`, mono.working);
    assertEqual(echoTrailer, c1, "echo commit's trailer must point at the original backend c1");

    // (D) genuine mono change: delete be/f1.ts (no trailer). Exports normally.
    git("rm be/f1.ts", mono.working);
    git('commit -m "remove f1 on mono"', mono.working);

    // Cherry-pick the echo -> re-adds be/f1.ts as a NEW commit still carrying
    // b-be-to-a-be: <c1>. The operator deliberately reintroduces the change.
    git(`cherry-pick ${echoAddF1}`, mono.working);
    const cpTrailer = git('log -1 --format=%(trailers:key=b-be-to-a-be,valueonly)', mono.working);
    assertEqual(cpTrailer, c1, "cherry-pick must carry the copied trailer pointing at c1");
    git("push origin main", mono.working);

    // Export.
    const r = runSync({ from: "a" });
    assertEqual(r.exitCode, 0, `export --from a failed: ${r.stderr.slice(0, 300)}`);

    // Ground truth: the re-added f1 must reach the backend shadow (mapping be -> root).
    git("fetch backend", mono.working);
    let backendF1: string | null;
    try {
      backendF1 = execSync("git show backend/a-be/main:f1.ts", { cwd: mono.working, encoding: "utf8" }).replace(/\r\n/g, "\n");
    } catch { backendF1 = null; }
    assertEqual(backendF1, "v1\n",
      "cherry-pick of an echo must propagate to the backend shadow (treated as a new change, not dropped as an echo)");

    console.log("PASS — cherrypick-echo: a cherry-picked echo replays instead of being dropped.");
  } finally {
    setBranchFiltersForTesting(new Map());
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

run();
