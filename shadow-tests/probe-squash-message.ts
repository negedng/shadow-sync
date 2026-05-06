import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execSync } from "child_process";

// Probe: confirm what `git merge --squash` writes into the default commit
// message, and whether SHAs of the squashed commits (including a buried
// merge-shadow commit) survive into the resulting commit's %B.
//
// Topology mirrors test-squash-merges Phase D:
//
//   main:    A ── B ──────────────── SQUASH
//                  \                 /
//   feature:        C ── D ── M ── E
//                            /
//   shadow:        S1 ── S2
//
// M = merge of `shadow` into feature. SQUASH = `merge --squash feature`
// committed with the default message (-F .git/SQUASH_MSG).
//
// Question: does %B contain the SHAs of C, D, M, E (and S1/S2)?
// Answer drives the design of the auto-anchor replay path.

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function commit(dir: string, file: string, content: string, msg: string): string {
  fs.writeFileSync(path.join(dir, file), content);
  git(`add "${file}"`, dir);
  git(`commit -m "${msg}"`, dir);
  return git("rev-parse HEAD", dir);
}

function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "probe-squash-"));
  try {
    git("init", dir);
    // Match harness: identity + disable autocrlf (Windows).
    fs.appendFileSync(
      path.join(dir, ".git", "config"),
      `[user]\n\temail = probe@test.com\n\tname = Probe\n[core]\n\tautocrlf = false\n`,
    );

    // Initial commits on the default branch; rename to main for clarity.
    const A = commit(dir, "a.txt", "A\n", "A: bootstrap");
    git("branch -M main", dir);
    const B = commit(dir, "b.txt", "B\n", "B: another on main");

    // Simulate a shadow ref as a separate branch off main@A.
    git(`checkout -b shadow ${A}`, dir);
    const S1 = commit(dir, "s1.txt", "S1\n", "S1: shadow content");
    const S2 = commit(dir, "s2.txt", "S2\n", "S2: more shadow content");

    // Feature branch off main@B.
    git(`checkout -b feature ${B}`, dir);
    const C = commit(dir, "c.txt", "C\n", "C: feature work 1");
    const D = commit(dir, "d.txt", "D\n", "D: feature work 2");

    // Pull "shadow" into feature.
    git('merge --no-ff shadow -m "Merge shadow into feature"', dir);
    const M = git("rev-parse HEAD", dir);

    // More feature work after the shadow merge.
    const E = commit(dir, "e.txt", "E\n", "E: feature work after shadow merge");

    // Squash-merge feature into main, accepting the default squash message.
    git("checkout main", dir);
    git("merge --squash feature", dir);
    git("commit -F .git/SQUASH_MSG", dir);

    const msg = git("log -1 --format=%B", dir);
    console.log("=== Squash commit message (%B) ===");
    console.log(msg);
    console.log("=== /message ===\n");

    const refs: [string, string][] = [
      ["A",  A],  ["B",  B],
      ["C",  C],  ["D",  D],  ["M",  M],  ["E",  E],
      ["S1", S1], ["S2", S2],
    ];
    console.log("SHA presence in %B:");
    for (const [name, sha] of refs) {
      const present = msg.includes(sha);
      const tag =
        ["C","D","M","E"].includes(name) ? "feature (squashed)" :
        ["S1","S2"].includes(name)        ? "shadow (pulled into feature via M)" :
                                            "main (NOT squashed)";
      console.log(`  ${name.padEnd(2)} ${sha.slice(0,12)}  in message: ${present ? "YES" : "no "}  [${tag}]`);
    }

    // Useful follow-up: split the message into individual `commit <sha>` blocks
    // to see what default formatting we'd parse against.
    const blocks = msg.match(/^commit [0-9a-f]{40}/gm) ?? [];
    console.log(`\nFound ${blocks.length} "commit <sha>" header line(s) in the message.`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main();
