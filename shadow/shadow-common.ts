import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ── Config ────────────────────────────────────────────────────────────────────

interface RemoteConfig {
  /** Git remote name — must match `git remote add <name> <url>` */
  remote: string;
  /** Local subdirectory in your repo that maps to the root of that remote */
  dir: string;
  /** URL for the external repo */
  url: string;
}

interface ShadowSyncConfig {
  remotes: RemoteConfig[];
  trailers: { sync: string; seed: string; forward: string; exp: string };
  gitConfigOverrides: Record<string, string>;
  maxBuffer: number;
  maxDirDepth: number;
  shadowBranchPrefix: string;
}

const CONFIG_PATH = path.join(__dirname, "shadow-config.json");

function loadConfig(): ShadowSyncConfig {
  const raw = fs.readFileSync(CONFIG_PATH, "utf8");
  const doc = JSON.parse(raw) as Record<string, unknown>;
  return {
    remotes:           (doc.remotes as RemoteConfig[]) ?? [],
    trailers: {
      sync: ((doc.trailers as Record<string, string>)?.sync) ?? "Shadow-synced-from",
      seed: ((doc.trailers as Record<string, string>)?.seed) ?? "Shadow-seed",
      forward: ((doc.trailers as Record<string, string>)?.forward) ?? "Shadow-forwarded-from",
      exp: ((doc.trailers as Record<string, string>)?.export) ?? "Shadow-export",
    },
    gitConfigOverrides: (doc.gitConfigOverrides as Record<string, string>) ?? {},
    maxBuffer:          (doc.maxBuffer as number) ?? 50 * 1024 * 1024,
    maxDirDepth:        (doc.maxDirDepth as number) ?? 100,
    shadowBranchPrefix: (doc.shadowBranchPrefix as string) ?? "shadow",
  };
}

const config = loadConfig();

export const REMOTES: RemoteConfig[] = [...config.remotes];
const SYNC_TRAILER    = config.trailers.sync;
export const SEED_TRAILER    = config.trailers.seed;
const FORWARD_TRAILER = config.trailers.forward;
const EXPORT_TRAILER  = config.trailers.exp;
export const SHADOW_BRANCH_PREFIX = config.shadowBranchPrefix;

// Allow tests to inject config via environment variable (JSON array of RemoteConfig).
if (process.env.SHADOW_TEST_REMOTES) {
  REMOTES.length = 0;
  REMOTES.push(...JSON.parse(process.env.SHADOW_TEST_REMOTES));
}

// ── Core utilities ───────────────────────────────────────────────────────────

const MAX_BUFFER = config.maxBuffer;

/** Repo root — ensures git commands use paths relative to the repo, not the cwd.
 *  When invoked via `npm --prefix shadow`, cwd is shadow/ which breaks path-based commands. */
const REPO_ROOT = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" })
  .stdout.trim();

/** Git config overrides for cross-OS consistency. */
const GIT_CONFIG_OVERRIDES = Object.entries(config.gitConfigOverrides).flatMap(
  ([key, value]) => ["-c", `${key}=${value}`],
);

export function die(msg: string): never {
  console.error(`✘ ${msg}`);
  process.exit(1);
}

/** Validate that a dir/remote name is safe for use in git commands and path construction. */
export function validateName(value: string, label: string): void {
  if (!value) die(`${label} must not be empty.`);
  if (value.includes("..")) die(`${label} must not contain '..'.`);
  if (value.startsWith("/") || value.startsWith("\\")) die(`${label} must not be an absolute path.`);
  if (value.startsWith("-")) die(`${label} must not start with '-'.`);
}

type GitResult = { stdout: string; stderr: string; status: number; ok: boolean };
type GitOpts = { cwd?: string; plain?: boolean; raw?: boolean; env?: Record<string, string>; input?: string };

/** Run a git command. Throws on non-zero exit.
 *  Use { plain: true } to skip config overrides (for working-tree ops on Windows).
 *  Use { raw: true } to skip trimming stdout (for patches where whitespace matters). */
export function git(args: string[], opts?: GitOpts & { safe?: false }): string;
/** Run a git command. Returns { stdout, stderr, status, ok } — never throws.
 *  Use { plain: true } to skip config overrides (for working-tree ops on Windows). */
export function git(args: string[], opts: GitOpts & { safe: true }): GitResult;
export function git(args: string[], opts?: GitOpts & { safe?: boolean }): string | GitResult {
  const fullArgs = opts?.plain ? args : [...GIT_CONFIG_OVERRIDES, ...args];
  const r = spawnSync("git", fullArgs, {
    encoding: "utf8", cwd: opts?.cwd ?? REPO_ROOT, maxBuffer: MAX_BUFFER, stdio: ["pipe", "pipe", "pipe"],
    ...(opts?.input != null ? { input: opts.input } : {}),
    ...(opts?.env ? { env: { ...process.env, ...opts.env } } : {}),
  });

  const trim = (s: string) => opts?.raw ? s : s.trim();

  if (opts?.safe) {
    if (r.error) return { stdout: "", stderr: `Failed to spawn git: ${r.error.message}`, status: 1, ok: false };
    return {
      stdout: trim(r.stdout ?? ""),
      stderr: (r.stderr ?? "").trim(),
      status: r.status ?? 1,
      ok:     r.status === 0,
    };
  }

  if (r.error) throw new Error(`Failed to spawn git: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`git ${args[0]} failed (exit ${r.status}): ${(r.stderr ?? "").trim()}`);
  return trim(r.stdout ?? "");
}

export function refExists(ref: string): boolean {
  return git(["rev-parse", "--verify", ref], { safe: true }).ok;
}

export function getCurrentBranch(): string {
  const result = git(["symbolic-ref", "--short", "HEAD"], { safe: true });
  if (!result.ok) {
    die("You are in a detached HEAD state. Check out a branch first.");
  }
  return result.stdout;
}

export function listExternalBranches(remote: string): string[] {
  return git(["branch", "-r"])
    .split("\n")
    .map(l => l.trim())
    .filter(l => l.startsWith(`${remote}/`) && !l.includes("->"))
    .map(l => l.replace(`${remote}/`, ""));
}

/** Build the canonical shadow branch name: shadow/{dir}/{branch} */
export function shadowBranchName(dir: string, branch: string): string {
  return `${SHADOW_BRANCH_PREFIX}/${dir}/${branch}`;
}

/** Append a trailer to a commit message using `git interpret-trailers`. */
export function appendTrailer(message: string, trailer: string): string {
  const result = git(["interpret-trailers", "--trailer", trailer],
    { safe: true, input: message, raw: true });
  if (!result.ok) {
    const trimmed = message.trimEnd();
    return `${trimmed}\n\n${trailer}\n`;
  }
  return result.stdout;
}

// ── Pre-flight checks ─────────────────────────────────────────────────────────

/**
 * Run pre-flight checks on an external ref before syncing.
 * Inspects the remote's tree for potential issues: shallow clones (need full
 * history for commit replay), submodules (can't be synced), symlinks (targets
 * won't be adjusted for the subdirectory), case-conflicting paths (data loss
 * on Windows/macOS), and Git LFS usage (only pointer files are transferred).
 * Returns an array of warnings/errors. Callers should abort on "error" level.
 */
export function preflightChecks(externalRef: string): { level: "error" | "warn"; code: string; message: string }[] {
  type W = { level: "error" | "warn"; code: string; message: string };
  const warnings: W[] = [];
  const warn  = (code: string, message: string) => warnings.push({ level: "warn", code, message });
  const error = (code: string, message: string) => warnings.push({ level: "error", code, message });

  const shallow = git(["rev-parse", "--is-shallow-repository"], { safe: true });
  if (shallow.ok && shallow.stdout === "true") {
    error("SHALLOW_CLONE", "This repository is a shallow clone. Shadow sync requires full history.\n  Run: git fetch --unshallow");
  }

  const tree = git(["ls-tree", "-r", "--long", externalRef], { safe: true });
  if (tree.ok && tree.stdout) {
    const paths: string[] = [];
    for (const entry of tree.stdout.split("\n").filter(Boolean)) {
      const m = entry.match(/^(\d+)\s+(\w+)\s+[0-9a-f]+\s+[\d-]+\t(.+)$/);
      if (!m) continue;
      const [, mode, , filePath] = m;
      paths.push(filePath);
      if (mode === "160000") warn("SUBMODULE", `Remote contains a submodule at '${filePath}'. Submodules cannot be synced and will be skipped.`);
      if (mode === "120000") warn("SYMLINK", `Remote contains a symlink at '${filePath}'. Symlink targets are not adjusted for the local subdirectory.`);
    }

    if (process.platform === "win32" || process.platform === "darwin") {
      const lower = new Map<string, string>();
      for (const p of paths) {
        const existing = lower.get(p.toLowerCase());
        if (existing && existing !== p) {
          error("CASE_CONFLICT", `Case conflict: '${existing}' and '${p}' differ only in case.\n  This will cause data loss on case-insensitive filesystems (Windows/macOS).`);
        }
        lower.set(p.toLowerCase(), p);
      }
    }
  }

  const attrs = git(["show", `${externalRef}:.gitattributes`], { safe: true });
  if (attrs.ok && attrs.stdout.includes("filter=lfs")) {
    warn("GIT_LFS", "Remote uses Git LFS. Shadow sync will transfer LFS pointer files, not actual content.\n  Ensure LFS is configured in the internal repo, or large files will be pointers.");
  }

  return warnings;
}

/**
 * Print preflight warnings and abort on errors.
 * Returns true if safe to continue, false if there were errors.
 */
export function handlePreflightResults(warnings: { level: "error" | "warn"; code: string; message: string }[]): boolean {
  for (const w of warnings) {
    console.error(`${w.level === "error" ? "✘" : "⚠"} [${w.code}] ${w.message}`);
  }
  const errorCount = warnings.filter(w => w.level === "error").length;
  if (errorCount > 0) console.error(`\nAborting due to ${errorCount} error(s).`);
  return errorCount === 0;
}

// ── Replay engine ─────────────────────────────────────────────────────────────

interface CommitMeta {
  hash:           string;
  authorName:     string;
  authorEmail:    string;
  authorDate:     string;
  committerName:  string;
  committerEmail: string;
  committerDate:  string;
  message:        string;
  short:          string;
  parentCount:    number;
}

function getCommitMeta(hash: string): CommitMeta {
  const SEP = "---SHADOW-SEP---";
  const format = ["%an", "%ae", "%aD", "%cn", "%ce", "%cD", "%B", "%h: %s", "%P"]
    .join(SEP);
  const raw = git(["log", "-1", `--format=${format}`, hash]);
  const parts = raw.split(SEP);
  const head = parts.slice(0, 6);
  const tail = parts.slice(-2);
  const message = parts.slice(6, -2).join(SEP);
  return {
    hash,
    authorName:     head[0],
    authorEmail:    head[1],
    authorDate:     head[2],
    committerName:  head[3],
    committerEmail: head[4],
    committerDate:  head[5],
    message,
    short:          tail[0],
    parentCount:    tail[1].split(/\s+/).filter(Boolean).length,
  };
}

/** Build the GIT_AUTHOR/COMMITTER env vars from commit metadata. */
function commitEnv(meta: CommitMeta): Record<string, string> {
  return {
    GIT_AUTHOR_NAME:      meta.authorName,
    GIT_AUTHOR_EMAIL:     meta.authorEmail,
    GIT_AUTHOR_DATE:      meta.authorDate,
    GIT_COMMITTER_NAME:   meta.committerName,
    GIT_COMMITTER_EMAIL:  meta.committerEmail,
    GIT_COMMITTER_DATE:   meta.committerDate,
  };
}

/** Strip all Shadow-* trailers from a commit message. */
function stripTrailers(message: string): string {
  const trailerPrefixes = [SYNC_TRAILER, SEED_TRAILER, FORWARD_TRAILER, EXPORT_TRAILER];
  return message.split("\n")
    .filter(l => !trailerPrefixes.some(t => l.startsWith(`${t}:`)))
    .join("\n").trimEnd();
}

const SYNCED_HASH_RE = new RegExp(`^${SYNC_TRAILER}:\\s*([0-9a-f]{7,40})`);

const SEED_HASH_RE = new RegExp(`^${SEED_TRAILER}:\\s*(\\S+)\\s+([0-9a-f]{7,40})`);

function findSeedHash(dir: string): string | null {
  const log = git(["log", "--all", `--grep=^${SEED_TRAILER}:`, "--format=%B"], { safe: true });
  if (!log.ok || !log.stdout) return null;
  for (const line of log.stdout.split("\n")) {
    const match = line.match(SEED_HASH_RE);
    if (match && match[1] === dir) return match[2];
  }
  return null;
}

/** Returns the local commit SHA of the seed commit for a directory. */
function findSeedCommit(dir: string): string | null {
  const MARKER = "SEEDCOMMIT ";
  const log = git(
    ["log", "--all", `--grep=^${SEED_TRAILER}:`, `--format=${MARKER}%H%n%B`],
    { safe: true },
  );
  if (!log.ok || !log.stdout) return null;
  let currentLocal: string | null = null;
  for (const line of log.stdout.split("\n")) {
    if (line.startsWith(MARKER)) {
      currentLocal = line.slice(MARKER.length).trim();
      continue;
    }
    const match = line.match(SEED_HASH_RE);
    if (match && match[1] === dir && currentLocal) return currentLocal;
  }
  return null;
}

// ── Shared replay helpers ────────────────────────────────────────────────────

interface TopoCommit {
  hash: string;
  parents: string[];
}

/** Parse `git rev-list --parents` output into TopoCommit[]. */
function parseRevList(output: string): TopoCommit[] {
  return output.split("\n").filter(Boolean).map(line => {
    const parts = line.split(/\s+/);
    return { hash: parts[0], parents: parts.slice(1) };
  });
}

/**
 * Scan git log for trailer-based SHA mappings.
 * Returns a Map keyed by the first capture group of trailerRe, valued by the
 * commit hash that contained the trailer. Used by both import and export to
 * track which commits have already been replayed.
 */
function buildTrailerMapping(logArgs: string[], trailerRe: RegExp): Map<string, string> {
  const mapping = new Map<string, string>();
  const MARKER = "TMAP ";
  const log = git([...logArgs, `--format=${MARKER}%H%n%B`], { safe: true });
  if (!log.ok || !log.stdout) return mapping;

  let currentHash: string | null = null;
  for (const line of log.stdout.split("\n")) {
    if (line.startsWith(MARKER)) {
      currentHash = line.slice(MARKER.length).trim();
      continue;
    }
    const match = line.match(trailerRe);
    if (match && currentHash) {
      mapping.set(match[1], currentHash);
    }
  }
  return mapping;
}

/**
 * Map source commit parents → target parents via shaMapping, falling back to
 * graftBase when no parents resolve (root commits or first commit after seed).
 */
function resolveParents(
  commit: TopoCommit,
  shaMapping: Map<string, string>,
  graftBase: string | null,
): string[] {
  const parents: string[] = [];
  for (const parentHash of commit.parents) {
    const mapped = shaMapping.get(parentHash);
    if (mapped) parents.push(mapped);
  }
  if (parents.length === 0 && graftBase) {
    parents.push(graftBase);
  }
  return parents;
}

// ── Topology-preserving replay engine ────────────────────────────────────────

/**
 * Collect all commits across multiple branches in topological order (parents first).
 * Uses `git rev-list --topo-order --reverse --parents` for a single traversal
 * that automatically deduplicates shared commits.
 */
function collectAllExternalCommits(
  remote: string,
  branches: string[],
  seedHash?: string,
): TopoCommit[] {
  const refs = branches.map(b => `${remote}/${b}`);
  const args = ["rev-list", "--topo-order", "--reverse", "--parents"];
  if (seedHash) {
    args.push(`^${seedHash}`);
  }
  args.push(...refs);

  const result = git(args, { safe: true });
  if (!result.ok || !result.stdout) return [];
  return parseRevList(result.stdout);
}

/**
 * Map each branch name to the local SHA corresponding to its external HEAD.
 */
function buildBranchMapping(
  remote: string,
  branches: string[],
  shaMapping: Map<string, string>,
): Map<string, string> {
  const branchMapping = new Map<string, string>();
  for (const branch of branches) {
    const headSHA = git(["rev-parse", `${remote}/${branch}`]);
    const localSHA = shaMapping.get(headSHA);
    if (localSHA) branchMapping.set(branch, localSHA);
  }
  return branchMapping;
}

/**
 * Replay commits from multiple external branches into a local subdirectory,
 * preserving the original DAG topology (shared ancestors stay shared).
 *
 * Instead of checking out branches and cherry-picking, this uses git plumbing:
 *   - `git read-tree --prefix` to scope external trees under {dir}/
 *   - `git commit-tree` to create commits with explicit parents
 *   - `git update-ref` (by caller) to point shadow branches at the right tips
 *
 * Returns a branchMapping so the caller can update each shadow branch ref.
 */
export function replayCommitsIncoming(opts: {
  remote: string;
  dir: string;
  branches: string[];
}): { mirrored: number; branchMapping: Map<string, string>; upToDate: boolean } {
  const { remote, dir, branches } = opts;

  console.log("Scanning local history for already-mirrored commits...");
  const shaMapping = buildTrailerMapping(
    ["log", "--all", `--grep=^${SYNC_TRAILER}:`, "--", `${dir}/`],
    SYNCED_HASH_RE,
  );
  console.log(`Found ${shaMapping.size} previously mirrored commit(s).`);

  const seedHash = findSeedHash(dir);
  if (seedHash) {
    console.log(`Found seed baseline: ${seedHash.slice(0, 10)} (skipping earlier history).`);
  }

  const allCommits = collectAllExternalCommits(remote, branches, seedHash ?? undefined);
  const newCommits = allCommits.filter(c => !shaMapping.has(c.hash));

  if (newCommits.length === 0) {
    const branchMapping = buildBranchMapping(remote, branches, shaMapping);
    return { mirrored: 0, branchMapping, upToDate: true };
  }

  console.log(`Found ${newCommits.length} new commit(s) to mirror.\n`);

  // Use the seed commit as graft base — it's on main's history, so shadow
  // branches share ancestry with main and can be merged with plain `git merge`.
  const graftBase = findSeedCommit(dir);
  if (graftBase) {
    console.log(`Using seed commit ${graftBase.slice(0, 10)} as graft base (shared ancestry with main).`);
  }

  const tmpIndex = path.join(os.tmpdir(), `shadow-topo-idx-${Date.now()}`);

  try {
    for (const commit of newCommits) {
      const meta = getCommitMeta(commit.hash);
      const isForwarded = meta.message.includes(`${FORWARD_TRAILER}:`);

      if (isForwarded) {
        console.log(`  Skipping ${meta.short} (forwarded by us).`);
      } else {
        const label = commit.parents.length > 1
          ? `merge commit ${meta.short}`
          : commit.parents.length === 0
            ? `root commit ${meta.short}`
            : meta.short;
        console.log(`  Applying ${label}...`);
      }

      const localParents = resolveParents(commit, shaMapping, graftBase);

      // Build full-repo tree: always use the seed commit tree as the base, then
      // overlay dir/ from external. This ensures shadow commits carry the full
      // repo tree so merging the shadow branch into main doesn't delete files.
      // Using seed (not parent) as base guarantees correctness even when older
      // synced commits had incomplete trees (pre-seed history).
      const baseTree = graftBase
        ? `${graftBase}^{tree}`
        : localParents.length > 0
          ? `${localParents[0]}^{tree}`
          : null;

      if (baseTree) {
        git(["read-tree", baseTree], { env: { GIT_INDEX_FILE: tmpIndex } });
        // Remove old dir/ content, then overlay new external content
        git(["rm", "-r", "--cached", "--quiet", "-f", `${dir}/`], { env: { GIT_INDEX_FILE: tmpIndex }, safe: true });
        git(["read-tree", `--prefix=${dir}/`, `${commit.hash}^{tree}`], { env: { GIT_INDEX_FILE: tmpIndex } });
      } else {
        // No base tree available — fall back to dir/-only tree (orphan)
        git(["read-tree", "--empty"], { env: { GIT_INDEX_FILE: tmpIndex } });
        git(["read-tree", `--prefix=${dir}/`, `${commit.hash}^{tree}`], { env: { GIT_INDEX_FILE: tmpIndex } });
      }
      const tree = git(["write-tree"], { env: { GIT_INDEX_FILE: tmpIndex } });

      // Build commit message with sync trailer
      let message: string;
      if (isForwarded) {
        message = appendTrailer(stripTrailers(meta.message), `${SYNC_TRAILER}: ${commit.hash}`);
      } else {
        message = appendTrailer(meta.message, `${SYNC_TRAILER}: ${commit.hash}`);
      }

      // Create commit with explicit parents via git plumbing
      const parentArgs = localParents.flatMap(p => ["-p", p]);
      const newSHA = git(["commit-tree", tree, ...parentArgs, "-m", message], {
        env: commitEnv(meta),
      });

      shaMapping.set(commit.hash, newSHA);
      console.log(isForwarded ? "  ✓ Recorded." : "  ✓ Mirrored.");
    }
  } finally {
    fs.rmSync(tmpIndex, { force: true });
  }

  const branchMapping = buildBranchMapping(remote, branches, shaMapping);

  console.log();
  console.log(`Done. ${newCommits.length} commit(s) mirrored with preserved topology.`);

  return { mirrored: newCommits.length, branchMapping, upToDate: false };
}

// ── Reverse replay (export direction) ────────────────────────────────────────

const FORWARD_HASH_RE = new RegExp(`^${FORWARD_TRAILER}:\\s*([0-9a-f]{7,40})`);

/**
 * Collect local commits that touch dir/ in topological order.
 * Uses git rev-list on the local branch, filtering to commits that touch dir/.
 */
function collectLocalCommitsForDir(
  dir: string,
  branch: string,
  seedCommit?: string,
): TopoCommit[] {
  const args = ["rev-list", "--topo-order", "--reverse", "--parents"];
  if (seedCommit) {
    args.push(`${seedCommit}..${branch}`);
  } else {
    args.push(branch);
  }
  args.push("--", `${dir}/`);

  const result = git(args, { safe: true });
  if (!result.ok || !result.stdout) return [];
  return parseRevList(result.stdout);
}

/**
 * Replay local commits to an external remote, stripping the dir/ prefix.
 * This is the reverse of replayCommitsIncoming — instead of adding a prefix,
 * we strip it. The result is pushed to a shadow branch on the external repo
 * so the external team can `git merge` to pull in changes.
 *
 * Uses git plumbing:
 *   - `git read-tree <commit>:{dir}` to strip the prefix (reads subtree at root)
 *   - `git commit-tree` to create commits with explicit parents
 *
 * Skips commits that have a SYNC_TRAILER (they came from external, no echo-back).
 */
export function replayCommitsOutgoing(opts: {
  remote: string;
  dir: string;
  localBranch: string;
  externalBranch: string;
  shadowIgnoreFile?: string;
}): { mirrored: number; tipSHA: string | null; upToDate: boolean } {
  const { remote, dir, localBranch, externalBranch } = opts;

  // The external shadow branch where we push stripped commits.
  // Convention: shadow/{localBranchName} on the external repo.
  const extShadowBranch = `${SHADOW_BRANCH_PREFIX}/${externalBranch}`;

  console.log("Scanning external history for already-forwarded commits...");
  const refs = [`${remote}/${extShadowBranch}`].filter(r => refExists(r));
  const shaMapping = refs.length > 0
    ? buildTrailerMapping(["log", ...refs, `--grep=^${FORWARD_TRAILER}:`], FORWARD_HASH_RE)
    : new Map<string, string>();
  console.log(`Found ${shaMapping.size} previously forwarded commit(s).`);

  // Find the seed commit (on local main) and the seed hash (external tip at seed time)
  const seedCommit = findSeedCommit(dir);
  const seedHash = findSeedHash(dir);
  if (seedCommit) {
    console.log(`Found seed commit: ${seedCommit.slice(0, 10)}`);
  }

  // Collect local commits that touch dir/ since the seed
  const allCommits = collectLocalCommitsForDir(dir, localBranch, seedCommit ?? undefined);
  const newCommits = allCommits.filter(c => {
    // Skip already forwarded
    if (shaMapping.has(c.hash)) return false;
    // Skip commits that came from external (have sync trailer)
    const meta = getCommitMeta(c.hash);
    if (meta.message.includes(`${SYNC_TRAILER}:`)) return false;
    return true;
  });

  if (newCommits.length === 0) {
    return { mirrored: 0, tipSHA: null, upToDate: true };
  }

  console.log(`Found ${newCommits.length} new commit(s) to forward.\n`);

  // Graft base: the external commit that the seed points to.
  // This gives the external shadow branch shared ancestry with the external main.
  const graftBase = seedHash ?? null;
  if (graftBase) {
    console.log(`Using external seed ${graftBase.slice(0, 10)} as graft base.`);
  }

  const tmpIndex = path.join(os.tmpdir(), `shadow-fwd-idx-${Date.now()}`);

  let lastSHA: string | null = null;
  try {
    for (const commit of newCommits) {
      const meta = getCommitMeta(commit.hash);
      const label = commit.parents.length > 1
        ? `merge commit ${meta.short}`
        : meta.short;
      console.log(`  Forwarding ${label}...`);

      // Build stripped tree: read dir/ subtree at root level
      const dirTree = git(["rev-parse", `${commit.hash}:${dir}`], { safe: true });
      if (!dirTree.ok) {
        console.log(`  Skipping ${meta.short} (no ${dir}/ content).`);
        continue;
      }
      git(["read-tree", "--empty"], { env: { GIT_INDEX_FILE: tmpIndex } });
      git(["read-tree", dirTree.stdout], { env: { GIT_INDEX_FILE: tmpIndex } });

      // Apply .shadowignore if provided
      if (opts.shadowIgnoreFile && fs.existsSync(opts.shadowIgnoreFile)) {
        const ignored = git(
          ["ls-files", "--cached", "-i", "--exclude-from", opts.shadowIgnoreFile],
          { env: { GIT_INDEX_FILE: tmpIndex } },
        ).split("\n").filter(Boolean);
        for (let i = 0; i < ignored.length; i += 100) {
          git(["rm", "--cached", "-f", "--", ...ignored.slice(i, i + 100)],
            { env: { GIT_INDEX_FILE: tmpIndex }, safe: true });
        }
      }

      const tree = git(["write-tree"], { env: { GIT_INDEX_FILE: tmpIndex } });

      const extParents = resolveParents(commit, shaMapping, graftBase);

      // Build commit message with forward trailer
      const message = appendTrailer(stripTrailers(meta.message), `${FORWARD_TRAILER}: ${commit.hash}`);

      const parentArgs = extParents.flatMap(p => ["-p", p]);
      const newSHA = git(["commit-tree", tree, ...parentArgs, "-m", message], {
        env: commitEnv(meta),
      });

      shaMapping.set(commit.hash, newSHA);
      lastSHA = newSHA;
      console.log("  ✓ Forwarded.");
    }
  } finally {
    fs.rmSync(tmpIndex, { force: true });
  }

  console.log();
  console.log(`Done. ${newCommits.length} commit(s) forwarded.`);

  return { mirrored: newCommits.length, tipSHA: lastSHA, upToDate: false };
}
