/**
 * Maintain in-tree path copies: each group of paths must hold identical
 * content. Editing any path and running `rebuild` propagates it to the
 * others — no designated canonical, the script picks the source for this
 * run by comparing each path to HEAD.
 *
 * Intended for monorepos where a folder needs to live at multiple paths
 * (e.g. shared code that shadow-sync's per-pair scoping pushes into
 * separate external repos as part of each pair's source dir).
 *
 * Modes:
 *   check    — verify every group is in lockstep; exit 1 on any divergence.
 *   rebuild  — propagate this run's source to siblings, stage the result.
 *
 * Configuration: `copyPaths` array in shadow-config.json:
 *
 *   "copyPaths": [
 *     { "paths": ["frontend/common", "backend/common"] }
 *   ]
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { execSync, spawnSync } from "child_process";

interface CopyGroup {
  /** Two or more paths that must hold identical content, relative to repo root. */
  paths: string[];
}

interface FileEntry {
  /** Posix-separated path relative to the folder being scanned. */
  relPath: string;
  content: Buffer;
  /** Only the executable bit is significant; line endings are preserved verbatim. */
  execBit: boolean;
}

// ── Repo discovery & config ──────────────────────────────────────────────────

function repoRoot(): string {
  return execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
}

function loadConfig(root: string): CopyGroup[] {
  const candidates = [
    process.env.SHADOW_CONFIG,
    path.join(root, "shadow-config.json"),
  ].filter((x): x is string => Boolean(x));

  for (const cfgPath of candidates) {
    if (!fs.existsSync(cfgPath)) continue;
    const raw = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as { copyPaths?: CopyGroup[] };
    return raw.copyPaths ?? [];
  }
  return [];
}

function validateConfig(groups: CopyGroup[]): void {
  const seen = new Set<string>();
  for (const g of groups) {
    if (!Array.isArray(g.paths) || g.paths.length < 2) {
      fail(`copy-paths: each group must have at least two paths; got ${JSON.stringify(g)}`);
    }
    for (const p of g.paths) {
      if (typeof p !== "string" || p === "" || p === "." || p.includes("..") || path.isAbsolute(p)) {
        fail(`copy-paths: '${p}' is not a safe relative path inside the repo.`);
      }
      const norm = normalizePath(p);
      if (seen.has(norm)) {
        fail(`copy-paths: '${p}' appears in more than one place — paths must be unique across all groups.`);
      }
      seen.add(norm);
    }
  }
  // Reject any nesting between paths anywhere across the config — would race
  // on rebuild and create ambiguous fingerprints (a parent's tree includes
  // the child's tree).
  const all = groups.flatMap(g => g.paths.map(normalizePath));
  for (const a of all) {
    for (const b of all) {
      if (a === b) continue;
      if (isAncestorPath(a, b)) {
        fail(`copy-paths: '${a}' is an ancestor of '${b}' — nested copy paths are not allowed.`);
      }
    }
  }
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

function isAncestorPath(maybeAncestor: string, descendant: string): boolean {
  return descendant.startsWith(`${maybeAncestor}/`);
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(2);
}

// ── Folder fingerprinting ────────────────────────────────────────────────────

function readDirRecursive(folder: string): FileEntry[] {
  if (!fs.existsSync(folder)) return [];
  const entries: FileEntry[] = [];
  const stack: string[] = [""];
  while (stack.length) {
    const sub = stack.pop()!;
    const here = path.join(folder, sub);
    for (const name of fs.readdirSync(here)) {
      const childRel = sub ? `${sub}/${name}` : name;
      const childFull = path.join(here, name);
      const stat = fs.lstatSync(childFull);
      if (stat.isSymbolicLink()) {
        // Symlinks behave inconsistently across OSes (Windows materialises
        // them as text on default config) and would make rebuild
        // non-deterministic. Refuse them at the source.
        fail(`copy-paths: symlink at '${path.relative(repoRoot(), childFull)}' is not supported.`);
      }
      if (stat.isDirectory()) {
        stack.push(childRel);
      } else if (stat.isFile()) {
        entries.push({
          relPath: childRel,
          content: fs.readFileSync(childFull),
          execBit: (stat.mode & 0o100) !== 0,
        });
      } else {
        fail(`copy-paths: unsupported entry type at '${path.relative(repoRoot(), childFull)}'.`);
      }
    }
  }
  entries.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return entries;
}

function fingerprint(entries: FileEntry[]): string {
  const h = crypto.createHash("sha256");
  for (const e of entries) {
    h.update(e.relPath);
    h.update("\0");
    h.update(e.execBit ? "x" : "-");
    h.update("\0");
    h.update(e.content);
    h.update("\0");
  }
  return h.digest("hex");
}

// ── HEAD comparison ──────────────────────────────────────────────────────────

function isModifiedVsHead(root: string, p: string): boolean {
  // `git status --porcelain -- <path>` lists tracked changes AND untracked
  // files in one call; empty output means working tree matches HEAD.
  const r = spawnSync("git", ["status", "--porcelain", "--", p], {
    cwd: root, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
  });
  if (r.status !== 0) {
    fail(`copy-paths: 'git status' failed for '${p}': ${(r.stderr ?? "").trim()}`);
  }
  return (r.stdout ?? "").trim().length > 0;
}

function hasHead(root: string): boolean {
  const r = spawnSync("git", ["rev-parse", "--verify", "HEAD"], {
    cwd: root, stdio: ["pipe", "pipe", "pipe"],
  });
  return r.status === 0;
}

// ── Per-file diff (printed by check) ────────────────────────────────────────

interface PerFileDiff {
  relPath: string;
  inPaths: string[];
  kind: "missing" | "content-differs" | "mode-differs";
}

function describeGroupDiffs(
  root: string,
  group: CopyGroup,
): PerFileDiff[] {
  const all = new Map<string, Map<string, FileEntry>>();
  for (const p of group.paths) {
    const entries = readDirRecursive(path.join(root, p));
    const m = new Map<string, FileEntry>();
    for (const e of entries) m.set(e.relPath, e);
    all.set(p, m);
  }
  const allRels = new Set<string>();
  for (const m of all.values()) for (const k of m.keys()) allRels.add(k);

  const out: PerFileDiff[] = [];
  for (const rel of allRels) {
    const present: string[] = [];
    const contents = new Set<string>();
    const modes = new Set<string>();
    for (const p of group.paths) {
      const e = all.get(p)!.get(rel);
      if (!e) continue;
      present.push(p);
      contents.add(e.content.toString("base64"));
      modes.add(e.execBit ? "x" : "-");
    }
    if (present.length !== group.paths.length) {
      out.push({ relPath: rel, inPaths: present, kind: "missing" });
    } else if (contents.size > 1) {
      out.push({ relPath: rel, inPaths: present, kind: "content-differs" });
    } else if (modes.size > 1) {
      out.push({ relPath: rel, inPaths: present, kind: "mode-differs" });
    }
  }
  out.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return out;
}

// ── Mode implementations ─────────────────────────────────────────────────────

interface GroupCheckResult {
  groupIndex: number;
  paths: string[];
  inLockstep: boolean;
  perFile: PerFileDiff[];
}

function checkAll(root: string, groups: CopyGroup[]): GroupCheckResult[] {
  return groups.map((g, i) => {
    const fps = g.paths.map(p => fingerprint(readDirRecursive(path.join(root, p))));
    const inLockstep = fps.every(fp => fp === fps[0]);
    return {
      groupIndex: i,
      paths: g.paths,
      inLockstep,
      perFile: inLockstep ? [] : describeGroupDiffs(root, g),
    };
  });
}

interface RebuildResult {
  /** Paths that had their content rewritten (does not include the source). */
  changedTargets: string[];
  /** Paths that should be staged after rebuild — both source and rewritten targets. */
  stagePaths: string[];
  warnings: string[];
}

function rebuildAll(root: string, groups: CopyGroup[]): RebuildResult {
  const changed: string[] = [];
  const staged: string[] = [];
  const warnings: string[] = [];
  const headExists = hasHead(root);

  for (const g of groups) {
    const entriesByPath = new Map<string, FileEntry[]>();
    const fpsByPath = new Map<string, string>();
    for (const p of g.paths) {
      const entries = readDirRecursive(path.join(root, p));
      entriesByPath.set(p, entries);
      fpsByPath.set(p, fingerprint(entries));
    }

    const distinctFps = new Set(fpsByPath.values());
    if (distinctFps.size === 1) {
      // Already in lockstep. Still stage any path the dev modified vs HEAD
      // — e.g., they edited multiple mirrors to identical content by hand.
      // Without staging, the modification is left out of the next commit.
      if (headExists) {
        for (const p of g.paths) {
          if (isModifiedVsHead(root, p) && !staged.includes(p)) staged.push(p);
        }
      }
      continue;
    }

    let sourcePath: string;
    if (!headExists) {
      // No HEAD to compare against — pick the path with non-empty content if
      // exactly one such path exists; otherwise refuse.
      const nonEmpty = g.paths.filter(p => entriesByPath.get(p)!.length > 0);
      if (nonEmpty.length === 1) {
        sourcePath = nonEmpty[0];
        warnings.push(`copy-paths: no HEAD; treating '${sourcePath}' (only non-empty path) as source for group [${g.paths.join(", ")}].`);
      } else {
        fail(
          `copy-paths: paths in group [${g.paths.join(", ")}] differ and there is no HEAD to compare against; ` +
          `populate one path and leave the others empty before first commit, then re-run.`,
        );
      }
    } else {
      const modified = g.paths.filter(p => isModifiedVsHead(root, p));
      if (modified.length === 0) {
        // Paths differ but none differ from HEAD — i.e. they were committed
        // diverging. Script can't choose a side without overwriting committed
        // history; require human to decide.
        fail(
          `copy-paths: paths in group [${g.paths.join(", ")}] differ from each other but match HEAD individually. ` +
          `This means HEAD itself is divergent — pick which version is correct, edit one path to match it, then re-run.`,
        );
      }
      const modifiedFps = new Set(modified.map(p => fpsByPath.get(p)!));
      if (modifiedFps.size > 1) {
        fail(
          `copy-paths: multiple paths in group [${g.paths.join(", ")}] were edited with different content:\n` +
          modified.map(p => `  ${p}: ${fpsByPath.get(p)!.slice(0, 12)}`).join("\n") +
          `\nPick which version is correct, revert the others, then re-run.`,
        );
      }
      sourcePath = modified[0];
    }

    const sourceEntries = entriesByPath.get(sourcePath)!;
    const sourceFp = fpsByPath.get(sourcePath)!;
    for (const p of g.paths) {
      if (p === sourcePath) continue;
      if (fpsByPath.get(p) === sourceFp) continue;
      writeFolderContents(path.join(root, p), sourceEntries);
      changed.push(p);
    }
    // Track the source for staging too — the dev's own edit on the source
    // is unstaged otherwise and would be left out of the next commit.
    if (!staged.includes(sourcePath)) staged.push(sourcePath);
    for (const p of changed) if (!staged.includes(p)) staged.push(p);
  }
  return { changedTargets: changed, stagePaths: staged, warnings };
}

function writeFolderContents(folder: string, entries: FileEntry[]): void {
  if (fs.existsSync(folder)) {
    fs.rmSync(folder, { recursive: true, force: true });
  }
  fs.mkdirSync(folder, { recursive: true });
  for (const e of entries) {
    const dest = path.join(folder, e.relPath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, e.content);
    if (e.execBit) {
      try { fs.chmodSync(dest, 0o755); } catch { /* Windows: chmod is a no-op */ }
    }
  }
}

function stageTargets(root: string, paths: string[]): void {
  if (paths.length === 0) return;
  const r = spawnSync("git", ["add", "--", ...paths], {
    cwd: root, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
  });
  if (r.status !== 0) {
    fail(`copy-paths: failed to stage rebuilt targets: ${(r.stderr ?? "").trim()}`);
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function printCheckResults(results: GroupCheckResult[]): void {
  for (const r of results) {
    if (r.inLockstep) continue;
    console.error(`  group [${r.paths.join(", ")}]: ${r.perFile.length} divergent file(s)`);
    for (const f of r.perFile.slice(0, 20)) {
      const detail = f.kind === "missing"
        ? `present in: ${f.inPaths.join(", ") || "(none)"}`
        : f.kind;
      console.error(`      ${f.relPath} — ${detail}`);
    }
    if (r.perFile.length > 20) {
      console.error(`      … and ${r.perFile.length - 20} more`);
    }
  }
}

function main(argv: string[]): number {
  const mode = argv[2] ?? "check";
  const root = repoRoot();
  const groups = loadConfig(root);

  if (groups.length === 0) {
    console.log("copy-paths: no groups configured (shadow-config.json:copyPaths). Nothing to do.");
    return 0;
  }
  validateConfig(groups);

  if (mode === "check") {
    const results = checkAll(root, groups);
    const divergent = results.filter(r => !r.inLockstep);
    if (divergent.length === 0) {
      console.log(`copy-paths: ${groups.length} group(s) up to date.`);
      return 0;
    }
    console.error("copy-paths: divergence detected:");
    printCheckResults(results);
    console.error(`\nTo propagate the modified path to its siblings, run: tsx copy-paths.ts rebuild`);
    return 1;
  }

  if (mode === "rebuild") {
    const r = rebuildAll(root, groups);
    for (const w of r.warnings) console.warn(w);
    // Stage even when nothing was rewritten — the dev may have hand-edited
    // multiple mirrors identically, and we still want their changes staged.
    if (r.stagePaths.length > 0) stageTargets(root, r.stagePaths);

    if (r.changedTargets.length === 0) {
      console.log("copy-paths: groups already in lockstep.");
      return 0;
    }
    console.log(`copy-paths: rebuilt and staged ${r.changedTargets.length} path(s):`);
    for (const t of r.changedTargets) console.log(`  ${t}`);
    return 0;
  }

  console.error(`copy-paths: unknown mode '${mode}'. Use one of: check, rebuild.`);
  return 2;
}

// Exports for tests; CLI runs only when invoked directly.
export {
  loadConfig, validateConfig, checkAll, rebuildAll,
  fingerprint, readDirRecursive, describeGroupDiffs,
  isModifiedVsHead, hasHead,
};
export type {
  CopyGroup, GroupCheckResult, RebuildResult, PerFileDiff, FileEntry,
};

if (require.main === module) {
  process.exit(main(process.argv));
}
