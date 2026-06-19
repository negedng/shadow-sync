// Cherry-pick of a commit carrying OUR OWN replay trailer must still replay.
// Export --from a stamps backend-shadow commits with a-be-to-b-be. git cherry-pick
// copies the message verbatim, so cherry-picking a shadow commit back onto mono
// produces a mono source commit carrying a-be-to-b-be. That hits the
// isCherryPickedCopy branch in replayCommits: it must strip the duplicated
// trailer and STILL replay (the pick re-introduces content the target lost),
// rather than being dropped.
//
// Repro: export `feature` (mono -> backend shadow, carries a-be-to-b-be). Delete
// feature.ts on mono, then cherry-pick the shadow commit back (re-adds it, same
// trailer). Re-export: feature.ts must reach the backend shadow again.
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-test-cp-own-"));
  try {
    const backend = createRepo(tmp, "backend", { email: "be@x.com", name: "Be" });
    const mono = createRepo(tmp, "mono", { email: "mo@x.com", name: "Mo" });
    git(`remote add backend "${backend.bare}"`, mono.working);

    // Root <-> root: cherry-picked backend-shadow content stays mapped on mono.
    applyTestOverrides({
      repoRoot: mono.working,
      pairs: [{ name: "be", a: { remote: "origin", url: mono.bare, label: "a-be" }, b: { remote: "backend", url: backend.bare, label: "b-be" }, mappings: [{ a: "", b: "" }] }],
      shadowBranchPrefix: "shadow",
    });
    setBranchFiltersForTesting(new Map<string, RegExp[]>([
      ["origin", ["main"].map(compileIgnorePattern)],
      ["backend", ["main"].map(compileIgnorePattern)],
    ]));

    // mono seed + a feature commit, exported to backend shadow (carries a-be-to-b-be).
    commit(mono, { "README.md": "# mono\n" }, "mono seed");
    git("push origin main", mono.working);
    const feature = commit(mono, { "feature.ts": "feat-v1\n" }, "add feature");
    git("push origin main", mono.working);
    assertEqual(runSync({ from: "a" }).exitCode, 0, "export 1 --from a failed");

    // The backend-shadow replay of `feature`, carrying our own trailer.
    git("fetch backend", mono.working);
    const featureShadow = git('log -1 --format=%H --grep="add feature" backend/a-be/main', mono.working);
    const shadowTrailer = git(`log -1 --format=%(trailers:key=a-be-to-b-be,valueonly) ${featureShadow}`, mono.working);
    assertEqual(shadowTrailer, feature, "backend-shadow feature commit must carry a-be-to-b-be: <feature>");

    // Delete feature.ts on mono, then cherry-pick the shadow commit back onto main
    // -> a mono source commit carrying OUR OWN trailer (hits isCherryPickedCopy).
    git("rm feature.ts", mono.working);
    git('commit -m "remove feature on mono"', mono.working);
    git(`cherry-pick ${featureShadow}`, mono.working);
    const cpTrailer = git('log -1 --format=%(trailers:key=a-be-to-b-be,valueonly)', mono.working);
    assertEqual(cpTrailer, feature, "cherry-pick must carry the copied a-be-to-b-be trailer");
    git("push origin main", mono.working);

    // Re-export: the cherry-pick replays (trailer stripped), re-adding feature.ts.
    const r = runSync({ from: "a" });
    assertEqual(r.exitCode, 0, `export 2 --from a failed: ${r.stderr.slice(0, 300)}`);

    git("fetch backend", mono.working);
    let backendFeature: string | null;
    try {
      backendFeature = execSync("git show backend/a-be/main:feature.ts", { cwd: mono.working, encoding: "utf8" }).replace(/\r\n/g, "\n");
    } catch { backendFeature = null; }
    assertEqual(backendFeature, "feat-v1\n",
      "cherry-pick of an own-trailer commit must replay (re-add feature.ts on the backend shadow), not be dropped");

    // The re-emitted shadow commit must not carry a duplicated a-be-to-b-be trailer.
    const reShadow = git('log --format=%H --grep="add feature" backend/a-be/main', mono.working).split("\n").filter(Boolean);
    const newest = reShadow[0];
    const trailerCount = git(`log -1 --format=%(trailers:key=a-be-to-b-be,valueonly,separator=%x0A) ${newest}`, mono.working)
      .split("\n").filter(Boolean).length;
    assertEqual(trailerCount, 1, "re-emitted commit must carry exactly one a-be-to-b-be trailer (copied one stripped)");

    console.log("PASS — cherrypick-own-trailer: a cherry-picked own-trailer commit replays with the copied trailer stripped.");
  } finally {
    setBranchFiltersForTesting(new Map());
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

run();
