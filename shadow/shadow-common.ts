import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ── Config ────────────────────────────────────────────────────────────────────

export interface RepoEndpoint {
  /** Git remote name */
  remote: string;
  /** URL for the repo. If absent, the remote must already exist. */
  url?: string;
  /** Path prefix in this repo ("backend", "" for root) */
  dir: string;
  /** Path to a .shadowignore file — filters what this endpoint sends to the other side. */
  ignore?: string;
}

export interface SyncPair {
  /** Stable identifier — used in seed trailers and shadow branch names. */
  name: string;
  /** The two repo endpoints. Symmetric — direction is chosen at runtime via --from. */
  a: RepoEndpoint;
  b: RepoEndpoint;
}

interface ShadowSyncConfig {
  pairs: SyncPair[];
  trailers: { replayed: string; seed: string };
  gitConfigOverrides: Record<string, string>;
  maxBuffer: number;
  shadowBranchPrefix: string;
}

const CONFIG_PATH = path.join(__dirname, "shadow-config.json");

function loadConfig(): ShadowSyncConfig {
  const raw = fs.readFileSync(CONFIG_PATH, "utf8");
  const doc = JSON.parse(raw) as Record<string, unknown>;

  const trailers = {
    replayed: ((doc.trailers as Record<string, string>)?.replayed) ?? "Shadow-replayed",
    seed: ((doc.trailers as Record<string, string>)?.seed) ?? "Shadow-seed",
  };
  const gitConfigOverrides = (doc.gitConfigOverrides as Record<string, string>) ?? {};
  const maxBuffer = (doc.maxBuffer as number) ?? 50 * 1024 * 1024;
  const shadowBranchPrefix = (doc.shadowBranchPrefix as string) ?? "shadow";

  let pairs: SyncPair[];
  if (doc.pairs) {
    pairs = (doc.pairs as SyncPair[]);
  } else {
    pairs = [];
  }

  return { pairs, trailers, gitConfigOverrides, maxBuffer, shadowBranchPrefix };
}

const config = loadConfig();

export const PAIRS: SyncPair[] = [...config.pairs];
const REPLAYED_TRAILER = config.trailers.replayed;
export const SEED_TRAILER = config.trailers.seed;
export const SHADOW_BRANCH_PREFIX = config.shadowBranchPrefix;

// Allow tests to inject config via environment variable.
if (process.env.SHADOW_TEST_PAIRS) {
  PAIRS.length = 0;
  PAIRS.push(...JSON.parse(process.env.SHADOW_TEST_PAIRS));
}

// ── Core utilities ───────────────────────────────────────────────────────────

const MAX_BUFFER = config.maxBuffer;

/** Workspace root — ensures git commands use paths relative to the repo, not the cwd. */
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

/** Validate that a name is safe for use in git commands and path construction. */
export function validateName(value: string, label: string): void {
  if (!value) die(`${label} must not be empty.`);
  if (value.includes("..")) die(`${label} must not contain '..'.`);
  if (value.startsWith("/") || value.startsWith("\\")) die(`${label} must not be an absolute path.`);
  if (value.startsWith("-")) die(`${label} must not start with '-'.`);
}

type GitResult = { stdout: string; stderr: string; status: number; ok: boolean };
type GitOpts = { cwd?: string; plain?: boolean; raw?: boolean; env?: Record<string, string>; input?: string };

export function git(args: string[], opts?: GitOpts & { safe?: false }): string;
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

export function listBranches(remote: string): string[] {
  return git(["branch", "-r"])
    .split("\n")
    .map(l => l.trim())
    .filter(l => l.startsWith(`${remote}/`) && !l.includes("->"))
    .map(l => l.replace(`${remote}/`, ""));
}

/** Build the canonical shadow branch name: shadow/{pairName}/{branch} */
export function shadowBranchName(pairName: string, branch: string): string {
  return `${SHADOW_BRANCH_PREFIX}/${pairName}/${branch}`;
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

/** Ensure a git remote is configured. If the endpoint has a url, add or update it. */
export function ensureRemote(endpoint: RepoEndpoint): void {
  if (!endpoint.url) return;
  const existing = git(["remote", "get-url", endpoint.remote], { safe: true });
  if (!existing.ok) {
    git(["remote", "add", endpoint.remote, endpoint.url]);
  } else if (existing.stdout !== endpoint.url) {
    git(["remote", "set-url", endpoint.remote, endpoint.url]);
  }
}

// ── Pre-flight checks ─────────────────────────────────────────────────────────

export function preflightChecks(ref: string): { level: "error" | "warn"; code: string; message: string }[] {
  type W = { level: "error" | "warn"; code: string; message: string };
  const warnings: W[] = [];
  const warn  = (code: string, message: string) => warnings.push({ level: "warn", code, message });
  const error = (code: string, message: string) => warnings.push({ level: "error", code, message });

  const shallow = git(["rev-parse", "--is-shallow-repository"], { safe: true });
  if (shallow.ok && shallow.stdout === "true") {
    error("SHALLOW_CLONE", "This repository is a shallow clone. Shadow sync requires full history.\n  Run: git fetch --unshallow");
  }

  const tree = git(["ls-tree", "-r", "--long", ref], { safe: true });
  if (tree.ok && tree.stdout) {
    const paths: string[] = [];
    for (const entry of tree.stdout.split("\n").filter(Boolean)) {
      const m = entry.match(/^(\d+)\s+(\w+)\s+[0-9a-f]+\s+[\d-]+\t(.+)$/);
      if (!m) continue;
      const [, mode, , filePath] = m;
      paths.push(filePath);
      if (mode === "160000") warn("SUBMODULE", `Contains a submodule at '${filePath}'. Submodules cannot be synced and will be skipped.`);
      if (mode === "120000") warn("SYMLINK", `Contains a symlink at '${filePath}'. Symlink targets are not adjusted for the subdirectory.`);
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

  const attrs = git(["show", `${ref}:.gitattributes`], { safe: true });
  if (attrs.ok && attrs.stdout.includes("filter=lfs")) {
    warn("GIT_LFS", "Uses Git LFS. Shadow sync will transfer LFS pointer files, not actual content.");
  }

  return warnings;
}

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

function stripTrailers(message: string): string {
  const trailerPrefixes = [REPLAYED_TRAILER, SEED_TRAILER];
  return message.split("\n")
    .filter(l => !trailerPrefixes.some(t => l.startsWith(t)))
    .join("\n").trimEnd();
}

/** Build a regex to match replay trailers: Shadow-replayed ({remote}): {hash} */
function replayedHashRe(remote: string): RegExp {
  const esc = remote.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${REPLAYED_TRAILER} \\(${esc}\\):\\s*([0-9a-f]{7,40})`);
}

const SEED_HASH_RE = new RegExp(`^${SEED_TRAILER}:\\s*(\\S+)\\s+([0-9a-f]{7,40})`);

function findSeedHash(pairName: string): string | null {
  const log = git(["log", "--all", `--grep=^${SEED_TRAILER}:`, "--format=%B"], { safe: true });
  if (!log.ok || !log.stdout) return null;
  for (const line of log.stdout.split("\n")) {
    const match = line.match(SEED_HASH_RE);
    if (match && match[1] === pairName) return match[2];
  }
  return null;
}

function findSeedCommit(pairName: string): string | null {
  const MARKER = "SEEDCOMMIT ";
  const log = git(
    ["log", "--all", `--grep=^${SEED_TRAILER}:`, `--format=${MARKER}%H%n%B`],
    { safe: true },
  );
  if (!log.ok || !log.stdout) return null;
  let currentCommit: string | null = null;
  for (const line of log.stdout.split("\n")) {
    if (line.startsWith(MARKER)) {
      currentCommit = line.slice(MARKER.length).trim();
      continue;
    }
    const match = line.match(SEED_HASH_RE);
    if (match && match[1] === pairName && currentCommit) return currentCommit;
  }
  return null;
}

// ── Shared helpers ──────────────────────────────────────────────────────────

interface TopoCommit {
  hash: string;
  parents: string[];
}

function parseRevList(output: string): TopoCommit[] {
  return output.split("\n").filter(Boolean).map(line => {
    const parts = line.split(/\s+/);
    return { hash: parts[0], parents: parts.slice(1) };
  });
}

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

function buildRemappedTree(opts: {
  commitHash: string;
  sourceDir: string;
  targetDir: string;
  baseTree: string | null;
  tmpIndex: string;
  shadowIgnoreFile?: string;
}): string | null {
  const { commitHash, sourceDir, targetDir, baseTree, tmpIndex } = opts;
  const idxEnv = { GIT_INDEX_FILE: tmpIndex };

  if (baseTree) {
    git(["read-tree", baseTree], { env: idxEnv });
    if (targetDir) {
      git(["rm", "-r", "--cached", "--quiet", "-f", `${targetDir}/`], { env: idxEnv, safe: true });
    }
  } else {
    git(["read-tree", "--empty"], { env: idxEnv });
  }

  let sourceTreeRef: string;
  if (sourceDir) {
    const subtree = git(["rev-parse", `${commitHash}:${sourceDir}`], { safe: true });
    if (!subtree.ok) return null;
    sourceTreeRef = subtree.stdout;
  } else {
    sourceTreeRef = `${commitHash}^{tree}`;
  }

  if (targetDir) {
    git(["read-tree", `--prefix=${targetDir}/`, sourceTreeRef], { env: idxEnv });
  } else {
    git(["read-tree", sourceTreeRef], { env: idxEnv });
  }

  if (opts.shadowIgnoreFile && fs.existsSync(opts.shadowIgnoreFile)) {
    const ignored = git(
      ["ls-files", "--cached", "-i", "--exclude-from", opts.shadowIgnoreFile],
      { env: idxEnv },
    ).split("\n").filter(Boolean);
    for (let i = 0; i < ignored.length; i += 100) {
      git(["rm", "--cached", "-f", "--", ...ignored.slice(i, i + 100)],
        { env: idxEnv, safe: true });
    }
  }

  return git(["write-tree"], { env: idxEnv });
}

/** Collect commits from remote-tracking branches in topo order. */
function collectBranchCommits(
  refs: string[],
  seedHash?: string,
): TopoCommit[] {
  const args = ["rev-list", "--topo-order", "--reverse", "--parents"];
  if (seedHash) args.push(`^${seedHash}`);
  args.push(...refs);

  const result = git(args, { safe: true });
  if (!result.ok || !result.stdout) return [];
  return parseRevList(result.stdout);
}

/** Collect commits from branches, optionally filtered to those touching dir/. */
function collectCommitsForDir(
  refs: string[],
  dir: string,
  seedBoundary?: string,
): TopoCommit[] {
  const args = ["rev-list", "--topo-order", "--reverse", "--parents"];
  if (seedBoundary) {
    // For remote refs use ^exclude, for branch ranges use seedBoundary..ref
    if (refs.length === 1 && !refs[0].includes("/")) {
      args.push(`${seedBoundary}..${refs[0]}`);
    } else {
      args.push(`^${seedBoundary}`, ...refs);
    }
  } else {
    args.push(...refs);
  }
  if (dir) args.push("--", `${dir}/`);

  const result = git(args, { safe: true });
  if (!result.ok || !result.stdout) return [];
  return parseRevList(result.stdout);
}

function buildBranchMapping(
  remote: string,
  branches: string[],
  shaMapping: Map<string, string>,
): Map<string, string> {
  const branchMapping = new Map<string, string>();
  for (const branch of branches) {
    const headSHA = git(["rev-parse", `${remote}/${branch}`]);
    const replayedSHA = shaMapping.get(headSHA);
    if (replayedSHA) branchMapping.set(branch, replayedSHA);
  }
  return branchMapping;
}

// ── Unified replay ──────────────────────────────────────────────────────────

/**
 * Build direction config from remote names.
 * Trailer format: "Shadow-replayed: {sourceRemote} {hash}"
 * When replaying from source, skip commits tagged with the target's remote
 * (they originated from the target and were already replayed back).
 */
function directionConfig(sourceRemote: string, targetRemote: string) {
  return {
    /** Trailer key to add: "Shadow-replayed ({sourceRemote})" — value is the hash */
    addTrailerKey: `${REPLAYED_TRAILER} (${sourceRemote})`,
    /** Regex to scan for already-replayed commits from this source */
    scanRe: replayedHashRe(sourceRemote),
    /** Trailer prefix to skip: commits tagged with the target's remote came from there */
    skipPrefix: `${REPLAYED_TRAILER} (${targetRemote})`,
  };
}

/**
 * Replay commits from one side of a pair to the other.
 *
 * @param from - "a" or "b": which side's commits to replay
 * @param branches - branches to replay (remote-tracking refs for the source)
 * @param sourceBranch - when replaying from a workspace branch (not remote refs),
 *                       the branch name to collect commits from
 */
export function replayCommits(opts: {
  pair: SyncPair;
  from: "a" | "b";
  branches: string[];
  sourceBranch?: string;
}): { mirrored: number; branchMapping: Map<string, string>; upToDate: boolean } {
  const { pair, from, branches } = opts;
  const source = from === "a" ? pair.a : pair.b;
  const target = from === "a" ? pair.b : pair.a;
  const dc = directionConfig(source.remote, target.remote);

  // 1. Scan target history for already-replayed commits
  console.log("Scanning history for already-replayed commits...");

  // For remote-based scanning (target has shadow branches on its remote)
  const shadowRefs = branches
    .map(b => `${target.remote}/${shadowBranchName(pair.name, b)}`)
    .filter(r => refExists(r));

  let shaMapping: Map<string, string>;
  if (shadowRefs.length > 0) {
    shaMapping = buildTrailerMapping(
      ["log", ...shadowRefs, `--grep=^${dc.addTrailerKey}`],
      dc.scanRe,
    );
  } else {
    // Fallback: scan all history (for shadow branches on our side)
    const logArgs = ["log", "--all", `--grep=^${dc.addTrailerKey}`];
    if (target.dir) logArgs.push("--", `${target.dir}/`);
    shaMapping = buildTrailerMapping(logArgs, dc.scanRe);
  }
  console.log(`Found ${shaMapping.size} previously replayed commit(s).`);

  // 2. Find seed
  const seedHash = findSeedHash(pair.name);
  if (seedHash) {
    console.log(`Found seed baseline: ${seedHash.slice(0, 10)} (skipping earlier history).`);
  }

  // 3. Collect commits from source.
  // If sourceBranch is set AND source has a url (it's a remote), use remote-tracking refs.
  // If sourceBranch is set and source has no url (it's the workspace), use bare branch name.
  const sourceRefs = opts.sourceBranch
    ? [source.url ? `${source.remote}/${opts.sourceBranch}` : opts.sourceBranch]
    : branches.map(b => `${source.remote}/${b}`);

  // Seed boundary: limits how far back we scan.
  // For remote refs (--from b with remote source), use seedHash (the source's tip at seed time).
  // For workspace branches (--from a with sourceBranch), use the seed commit if it's
  // in the source's history; otherwise scan everything (dedup handles the rest).
  let seedBoundary: string | undefined;
  if (opts.sourceBranch) {
    const sc = findSeedCommit(pair.name);
    const ref = sourceRefs[0];
    if (sc && git(["merge-base", "--is-ancestor", sc, ref], { safe: true }).ok) {
      seedBoundary = sc;
    }
    // No boundary = scan all commits on source branch (dedup handles the rest)
  } else {
    seedBoundary = seedHash ?? undefined;
  }

  const allCommits = source.dir
    ? collectCommitsForDir(sourceRefs, source.dir, seedBoundary)
    : collectBranchCommits(sourceRefs, seedBoundary);

  // 4. Filter: skip already replayed + skip commits that came from the other side
  const newCommits = allCommits.filter(c => {
    if (shaMapping.has(c.hash)) return false;
    const meta = getCommitMeta(c.hash);
    if (meta.message.includes(`${dc.skipPrefix}`)) return false;
    return true;
  });

  if (newCommits.length === 0) {
    const branchMapping = opts.sourceBranch
      ? new Map<string, string>()
      : buildBranchMapping(source.remote, branches, shaMapping);
    return { mirrored: 0, branchMapping, upToDate: true };
  }

  console.log(`Found ${newCommits.length} new commit(s) to replay.\n`);

  // 5. Graft base — for merge-compatible shadow branches.
  // The graft base gives shadow branches shared ancestry with the target repo
  // so `git merge` works cleanly. We try (in order):
  //   a) The seed commit in workspace history (when workspace IS the target repo)
  //   b) The target repo's main branch tip (when running from an orchestrator)
  //   c) The seed hash from the source side (when target.dir is empty)
  const seedCommit = findSeedCommit(pair.name);
  let graftBase: string | null;
  let baseTreeSource: string | null;

  if (target.dir) {
    // Target has a subdir — shadow commits need full-repo tree overlay.
    // Use seed commit if it exists in the target repo's history (workspace IS
    // the target). Otherwise fall back to the target's main branch tip (orchestrator).
    const seedInTarget = seedCommit && refExists(`${target.remote}/main`)
      && git(["merge-base", "--is-ancestor", seedCommit, `${target.remote}/main`], { safe: true }).ok;
    graftBase = seedInTarget
      ? seedCommit
      : (refExists(`${target.remote}/main`) ? git(["rev-parse", `${target.remote}/main`]) : null);
    baseTreeSource = graftBase;
  } else {
    // Target is at root — no full-repo overlay needed.
    graftBase = seedHash ?? null;
    baseTreeSource = null;
  }

  if (graftBase) {
    console.log(`Using graft base ${graftBase.slice(0, 10)} for shared ancestry.`);
  }

  // 6. Replay loop
  const tmpIndex = path.join(os.tmpdir(), `shadow-replay-${Date.now()}`);

  let lastSHA: string | null = null;
  try {
    for (const commit of newCommits) {
      const meta = getCommitMeta(commit.hash);

      // Commits that carry the skip trailer came from the other direction
      // (e.g. forwarded by us then echoed back) — record but don't replay content
      const isEcho = meta.message.includes(`${dc.addTrailerKey}`);

      if (isEcho) {
        console.log(`  Skipping ${meta.short} (echo from other direction).`);
      } else {
        const label = commit.parents.length > 1
          ? `merge commit ${meta.short}`
          : commit.parents.length === 0
            ? `root commit ${meta.short}`
            : meta.short;
        console.log(`  Replaying ${label}...`);
      }

      const mappedParents = resolveParents(commit, shaMapping, graftBase);

      const baseTree = baseTreeSource
        ? `${baseTreeSource}^{tree}`
        : mappedParents.length > 0 && target.dir
          ? `${mappedParents[0]}^{tree}`
          : null;

      const tree = buildRemappedTree({
        commitHash: commit.hash,
        sourceDir: source.dir,
        targetDir: target.dir,
        baseTree,
        tmpIndex,
        shadowIgnoreFile: source.ignore,
      });

      if (!tree) {
        console.log(`  Skipping ${meta.short} (source content missing).`);
        continue;
      }

      const msg = isEcho
        ? appendTrailer(stripTrailers(meta.message), `${dc.addTrailerKey}: ${commit.hash}`)
        : appendTrailer(meta.message, `${dc.addTrailerKey}: ${commit.hash}`);

      const parentArgs = mappedParents.flatMap(p => ["-p", p]);
      const newSHA = git(["commit-tree", tree, ...parentArgs, "-m", msg], {
        env: commitEnv(meta),
      });

      shaMapping.set(commit.hash, newSHA);
      lastSHA = newSHA;
      console.log(isEcho ? "  ✓ Recorded." : "  ✓ Replayed.");
    }
  } finally {
    fs.rmSync(tmpIndex, { force: true });
  }

  const branchMapping = opts.sourceBranch
    ? new Map([[branches[0] ?? "main", lastSHA!]])
    : buildBranchMapping(source.remote, branches, shaMapping);

  console.log();
  console.log(`Done. ${newCommits.length} commit(s) replayed.`);

  return { mirrored: newCommits.length, branchMapping, upToDate: false };
}
