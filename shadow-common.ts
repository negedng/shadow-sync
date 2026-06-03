import { spawnSync } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ── Module setup ──────────────────────────────────────────────────────────────

export interface RepoEndpoint {
  remote: string;
  url: string;
  anchorBranch?: string;
}

/** One folder pair: a.dir on side a ↔ b.dir on side b. "" = repo root. */
export interface DirMapping {
  a: string;
  b: string;
}

export interface SyncPair {
  /** Baked into shadow branch names — renaming breaks dedup. */
  name: string;
  /** Symmetric: direction is chosen at runtime via --from. */
  a: RepoEndpoint;
  b: RepoEndpoint;
  /** 1..N folder mappings. Dirs on each side must be disjoint. */
  mappings: DirMapping[];
}

interface ShadowSyncConfig {
  pairs: SyncPair[];
  trailers: { replayed: string };
  gitConfigOverrides: Record<string, string>;
  maxBuffer: number;
  shadowBranchPrefix: string;
}

interface DirMappingDirected {
  source: string;
  target: string;
}

interface DirectionConfig {
  pair: SyncPair;
  source: RepoEndpoint;
  target: RepoEndpoint;
  /** Direction-flipped pair.mappings. */
  mappings: DirMappingDirected[];
  /**
   * Per-mapping auto-ignore patterns derived from intra-pair nested mappings.
   * When one mapping's source path is the empty string or a strict prefix of
   * another mapping's source path, the inner path's content is "owned" by the
   * sibling mapping and must be stripped from the outer mapping's source slice.
   * Same logic on the target side. Indexed by mapping idx; each entry has
   * patterns for source-side reads and target-side reads.
   */
  autoIgnoreBySourceIdx: RegExp[][];
  autoIgnoreByTargetIdx: RegExp[][];
}

// Build patterns to strip `innerPath/...` content from a tree rooted at `outerPath`.
// `outerPath === ""` means tree root; `innerPath` must be non-empty and (when
// outerPath is non-empty) start with `outerPath + "/"`. Returns null if inner
// is not nested under outer.
function nestedRelativeIgnorePatterns(outerPath: string, innerPath: string): RegExp[] | null {
  let rel: string | null = null;
  if (outerPath === "") {
    if (innerPath === "") return null;
    rel = innerPath;
  } else if (innerPath.startsWith(outerPath + "/")) {
    rel = innerPath.slice(outerPath.length + 1);
  } else {
    return null;
  }
  const escaped = escapeRegex(rel);
  // Match the directory entry itself and anything under it.
  return [new RegExp(`^${escaped}$`), new RegExp(`^${escaped}/.*$`)];
}

// Per-pair, per-mapping auto-ignore: a mapping's source/target slice excludes
// content owned by sibling mappings nested under it. Trigger is intra-pair
// nested mappings (e.g. primary at "" with a sibling at "src/common"); the
// old trigger (multiple pairs on the same remote with overlapping dirs) is
// gone now that SyncPair.mappings carries N folder mappings per pair.
function computeAutoIgnorePatterns(
  pair: SyncPair,
): { a: RegExp[]; b: RegExp[] }[] {
  return pair.mappings.map(m => {
    const a: RegExp[] = [];
    const b: RegExp[] = [];
    for (const sibling of pair.mappings) {
      if (sibling === m) continue;
      const aPats = nestedRelativeIgnorePatterns(m.a, sibling.a);
      if (aPats) a.push(...aPats);
      const bPats = nestedRelativeIgnorePatterns(m.b, sibling.b);
      if (bPats) b.push(...bPats);
    }
    return { a, b };
  });
}

function buildDirectionConfig(pair: SyncPair, from: "a" | "b"): DirectionConfig {
  const source = from === "a" ? pair.a : pair.b;
  const target = from === "a" ? pair.b : pair.a;
  const mappings = pair.mappings.map(m =>
    from === "a" ? { source: m.a, target: m.b } : { source: m.b, target: m.a });
  const autoByMapping = computeAutoIgnorePatterns(pair);
  const autoIgnoreBySourceIdx = autoByMapping.map(p => from === "a" ? p.a : p.b);
  const autoIgnoreByTargetIdx = autoByMapping.map(p => from === "a" ? p.b : p.a);
  return { pair, source, target, mappings, autoIgnoreBySourceIdx, autoIgnoreByTargetIdx };
}

// Derived projections of dc.mappings — recomputed at each call site,
// matching the on-demand pattern of sourceTrailerKey/targetTrailerKey.
function sourceDirsOf(dc: DirectionConfig): string[] { return dc.mappings.map(m => m.source); }
function targetDirsOf(dc: DirectionConfig): string[] { return dc.mappings.map(m => m.target); }
function anyRootSource(dc: DirectionConfig): boolean { return dc.mappings.some(m => m.source === ""); }
/** True iff every mapping's target is a confined subdir (none at repo root).
 * Drives cross-repo outer-state preservation in composeMergeBaseTree. */
function allTargetsConfined(dc: DirectionConfig): boolean { return !dc.mappings.some(m => m.target === ""); }

function validatePair(pair: SyncPair): void {
  if (!pair.mappings || pair.mappings.length === 0) {
    fail(`pair "${pair.name}" must declare at least one mapping`);
  }
  // Only exact-duplicate source/target dirs within a side are ambiguous —
  // nested dirs (e.g. "" + "src/common") route deterministically via
  // longest-prefix in buildReplayedTree.
  const aDirs = new Set<string>();
  const bDirs = new Set<string>();
  for (const m of pair.mappings) {
    if (aDirs.has(m.a)) fail(`pair "${pair.name}" has duplicate a-dir "${m.a}"`);
    if (bDirs.has(m.b)) fail(`pair "${pair.name}" has duplicate b-dir "${m.b}"`);
    aDirs.add(m.a);
    bDirs.add(m.b);
  }
}

const CONFIG_PATH = process.env.SHADOW_CONFIG ?? path.join(__dirname, "shadow-config.json");

function loadConfig(): ShadowSyncConfig {
  if (!fs.existsSync(CONFIG_PATH)) {
    return {
      pairs: [],
      trailers: { replayed: "Shadow-replayed" },
      gitConfigOverrides: {},
      maxBuffer: 50 * 1024 * 1024,
      shadowBranchPrefix: "shadow",
    };
  }

  const raw = fs.readFileSync(CONFIG_PATH, "utf8");
  const doc = JSON.parse(raw) as Record<string, unknown>;

  const trailers = {
    replayed: ((doc.trailers as Record<string, string>)?.replayed) ?? "Shadow-replayed",
  };
  const gitConfigOverrides = (doc.gitConfigOverrides as Record<string, string>) ?? {};
  const maxBuffer = (doc.maxBuffer as number) ?? 50 * 1024 * 1024;
  const shadowBranchPrefix = (doc.shadowBranchPrefix as string) ?? "shadow";

  const pairs = (doc.pairs as SyncPair[]) ?? [];
  for (const pair of pairs) validatePair(pair);

  return { pairs, trailers, gitConfigOverrides, maxBuffer, shadowBranchPrefix };
}

const config = loadConfig();

export const PAIRS: SyncPair[] = [...config.pairs];
const REPLAYED_TRAILER = config.trailers.replayed;
let _shadowBranchPrefix = config.shadowBranchPrefix;
const MAX_BUFFER = config.maxBuffer;

/** Orchestrator repo root — git commands use paths relative to it, not the cwd. */
let _repoRoot = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" })
  .stdout.trim();

/** Git config overrides for cross-OS consistency. */
const GIT_CONFIG_OVERRIDES = Object.entries(config.gitConfigOverrides).flatMap(
  ([key, value]) => ["-c", `${key}=${value}`],
);

export class ShadowSyncError extends Error {
  constructor(msg: string) { super(msg); this.name = "ShadowSyncError"; }
}

/** Mutates module state — call before each in-process runSync(). */
export function applyTestOverrides(opts: {
  repoRoot: string;
  pairs: SyncPair[];
  shadowBranchPrefix?: string;
}): void {
  _repoRoot = opts.repoRoot;
  for (const pair of opts.pairs) validatePair(pair);
  PAIRS.length = 0;
  PAIRS.push(...opts.pairs);
  if (opts.shadowBranchPrefix != null) _shadowBranchPrefix = opts.shadowBranchPrefix;
}

export function fail(msg: string): never {
  throw new ShadowSyncError(`✘ ${msg}`);
}

/** Validate that a name is safe for use in git commands and path construction. */
export function validateName(value: string, label: string): void {
  if (!value) fail(`${label} must not be empty.`);
  if (value.includes("..")) fail(`${label} must not contain '..'.`);
  if (value.startsWith("/") || value.startsWith("\\")) fail(`${label} must not be an absolute path.`);
  if (value.startsWith("-")) fail(`${label} must not start with '-'.`);
}

// ── Git primitives ────────────────────────────────────────────────────────────

type GitResult = { stdout: string; stderr: string; status: number; ok: boolean };
type GitOpts = { cwd?: string; plain?: boolean; raw?: boolean; env?: Record<string, string>; input?: string };

export function git(args: string[], opts?: GitOpts & { safe?: false }): string;
export function git(args: string[], opts: GitOpts & { safe: true }): GitResult;
export function git(args: string[], opts?: GitOpts & { safe?: boolean }): string | GitResult {
  const fullArgs = opts?.plain ? args : [...GIT_CONFIG_OVERRIDES, ...args];
  const trim = (s: string) => opts?.raw ? s : s.trim();

  const r = spawnSync("git", fullArgs, {
    encoding: "utf8", cwd: opts?.cwd ?? _repoRoot, maxBuffer: MAX_BUFFER, stdio: ["pipe", "pipe", "pipe"],
    ...(opts?.input != null ? { input: opts.input } : {}),
    ...(opts?.env ? { env: { ...process.env, ...opts.env } } : {}),
  });

  if (opts?.safe) {
    if (r.error) return { stdout: "", stderr: `Failed to spawn git: ${r.error.message}`, status: 1, ok: false };
    return {
      stdout: trim(r.stdout ?? ""),
      stderr: (r.stderr ?? "").trim(),
      status: r.status ?? 1,
      ok: r.status === 0,
    };
  }

  if (r.error) throw new Error(`Failed to spawn git: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`git ${args[0]} failed (exit ${r.status}): ${(r.stderr ?? "").trim()}`);
  return trim(r.stdout ?? "");
}

export function refExists(ref: string): boolean {
  return git(["rev-parse", "--verify", ref], { safe: true }).ok;
}

/** Keep refs from list that exists locally */
function filterExistingRefs(refs: string[]): string[] {
  if (refs.length === 0) return [];
  const result = git(
    ["for-each-ref", "--format=%(refname)", ...refs.map(r => `refs/remotes/${r}`)],
    { safe: true },
  );
  if (!result.ok || !result.stdout) return [];
  const existing = new Set(
    result.stdout.split("\n").filter(Boolean).map(l => l.replace(/^refs\/remotes\//, "")),
  );
  return refs.filter(r => existing.has(r));
}

export function listRemoteBranches(remote: string): string[] {
  return git(["branch", "-r"])
    .split("\n")
    .map(l => l.trim())
    .filter(l => l.startsWith(`${remote}/`) && !l.includes("->"))
    .map(l => l.replace(`${remote}/`, ""))
    .filter(b => !b.startsWith(`${_shadowBranchPrefix}/`));
}

export function shadowBranchName(pairName: string, branch: string): string {
  return `${_shadowBranchPrefix}/${pairName}/${branch}`;
}

/** Ensure a git remote is configured at the endpoint's URL — add or update as needed. */
export function ensureRemote(endpoint: RepoEndpoint): void {
  const existing = git(["remote", "get-url", endpoint.remote], { safe: true });
  if (!existing.ok) {
    git(["remote", "add", endpoint.remote, endpoint.url]);
  } else if (existing.stdout !== endpoint.url) {
    git(["remote", "set-url", endpoint.remote, endpoint.url]);
  }
}

// ── Trailer machinery ─────────────────────────────────────────────────────────

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sanitizeTrailerToken(s: string): string {
  return s.replace(/[^A-Za-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

// Pair name is included so two pairs sharing a source remote (e.g. parent pair
// `backend` and dedicated common pair `common-backend`, both with b.remote =
// "backend-repo") get distinct trailers. Without it, scanning a shadow ref's
// history would match the sibling pair's replays brought in via cross-pair
// merges on the monorepo, polluting shaMapping with the wrong-shape replay.
function replayedTrailerKey(pairName: string, remote: string): string {
  return `${REPLAYED_TRAILER}-${sanitizeTrailerToken(`${pairName}-${remote}`)}`;
}

// This direction WRITES this trailer onto target commits: source→target SHA mapping.
function sourceTrailerKey(dc: DirectionConfig): string {
  return replayedTrailerKey(dc.pair.name, dc.source.remote);
}

// The opposite direction's trailer. Encountering it on a source commit means it's
// an echo of something this pair already replayed back from the target side.
function targetTrailerKey(dc: DirectionConfig): string {
  return replayedTrailerKey(dc.pair.name, dc.target.remote);
}

/** Build a regex to match replay trailers: Shadow-replayed-{pair}-{remote}: {hash} */
function replayedTrailerRegex(pairName: string, remote: string): RegExp {
  return new RegExp(`^${escapeRegex(replayedTrailerKey(pairName, remote))}:\\s*([0-9a-f]{7,40})`);
}

function targetTrailerRegex(dc: DirectionConfig): RegExp {
  return replayedTrailerRegex(dc.pair.name, dc.target.remote);
}


export function appendTrailer(message: string, trailer: string): string {
  const result = git(["interpret-trailers", "--trailer", trailer],
    { safe: true, input: message, raw: true });
  if (!result.ok) {
    const trimmed = message.trimEnd();
    return `${trimmed}\n\n${trailer}\n`;
  }
  return result.stdout;
}

function hasTrailer(trailers: string, key: string): boolean {
  return new RegExp(`^${escapeRegex(key)}:`, "m").test(trailers);
}

function stripReplayedTrailers(message: string): string {
  return message.split("\n")
    .filter(l => !l.startsWith(REPLAYED_TRAILER))
    .join("\n").trimEnd();
}

/**
 * Build source→target SHA mapping from commits carrying `<trailerKey>: <sha>`
 * trailers. One target commit may carry multiple such trailers (primary +
 * absorbed-halted ancestors), so we emit all values space-separated per line.
 */
function extractTrailerMapping(logArgs: string[], trailerKey: string): Map<string, string> {
  const mapping = new Map<string, string>();
  const result = git(
    [...logArgs, `--format=%H %(trailers:key=${trailerKey},valueonly,separator=%x20)`],
    { safe: true },
  );
  if (!result.ok || !result.stdout) return mapping;
  for (const line of result.stdout.split("\n")) {
    const parts = line.split(/\s+/).filter(Boolean);
    if (parts.length < 2) continue;
    const targetHash = parts[0];
    for (const src of parts.slice(1)) {
      if (/^[0-9a-f]{7,40}$/.test(src)) mapping.set(src, targetHash);
    }
  }
  return mapping;
}

// ── Preflight checks ──────────────────────────────────────────────────────────

type PreflightWarning = { level: "error" | "warn"; code: string; message: string };

export function runPreflightChecks(ref: string): PreflightWarning[] {
  const warnings: PreflightWarning[] = [];
  const error = (code: string, message: string) => warnings.push({ level: "error", code, message });

  const shallow = git(["rev-parse", "--is-shallow-repository"], { safe: true });
  if (shallow.ok && shallow.stdout === "true") {
    error("SHALLOW_CLONE", "This repository is a shallow clone. Shadow sync requires full history.\n  Run: git fetch --unshallow");
  }

  // core.ignorecase=true (Windows/macOS default) folds case-conflicting paths
  // in update-index --index-info, silently dropping one of them from the
  // replayed tree. Skip the walk on Linux where the index preserves both.
  if (process.platform === "win32" || process.platform === "darwin") {
    const tree = git(["ls-tree", "-r", "--name-only", ref], { safe: true });
    if (tree.ok && tree.stdout) {
      const lower = new Map<string, string>();
      for (const filePath of tree.stdout.split("\n").filter(Boolean)) {
        const existing = lower.get(filePath.toLowerCase());
        if (existing && existing !== filePath) {
          error("CASE_CONFLICT", `Case conflict: '${existing}' and '${filePath}' differ only in case.\n  This will cause data loss on case-insensitive filesystems (Windows/macOS).`);
        }
        lower.set(filePath.toLowerCase(), filePath);
      }
    }
  }

  return warnings;
}

/** Pure (no I/O) — see printPreflightResults for the side-effecting version. */
export function formatPreflightResults(warnings: PreflightWarning[]): { lines: string[]; errorCount: number; ok: boolean } {
  const lines = warnings.map(w => `${w.level === "error" ? "✘" : "⚠"} [${w.code}] ${w.message}`);
  const errorCount = warnings.filter(w => w.level === "error").length;
  if (errorCount > 0) lines.push(`\nAborting due to ${errorCount} error(s).`);
  return { lines, errorCount, ok: errorCount === 0 };
}

export function printPreflightResults(warnings: PreflightWarning[]): boolean {
  const { lines, ok } = formatPreflightResults(warnings);
  for (const line of lines) console.error(line);
  return ok;
}

// ── Commit metadata & collection ──────────────────────────────────────────────

interface CommitMeta {
  hash: string;
  authorName: string;
  authorEmail: string;
  authorDate: string;
  committerName: string;
  committerEmail: string;
  committerDate: string;
  message: string;
  trailers: string;
  short: string;
}

interface TopoCommit {
  hash: string;
  parents: string[];
}

// Small LRU keyed by commit hash (immutable). The confined-mapping echo check
// in composeMergeBaseTree re-reads each commit's first parent — on a linear
// chain that's the previous iteration's commit, so a handful of recent entries
// captures nearly all hits without retaining every commit's meta.
const META_CACHE_MAX = 256;
const _commitMetaCache = new Map<string, CommitMeta>();
function getCommitMeta(hash: string): CommitMeta {
  const cached = _commitMetaCache.get(hash);
  if (cached) {
    _commitMetaCache.delete(hash);     // bump to most-recently-used
    _commitMetaCache.set(hash, cached);
    return cached;
  }
  // NUL-separated; %B last so its newlines can't shift fields.
  const format = ["%an", "%ae", "%aD", "%cn", "%ce", "%cD", "%h: %s", "%(trailers:only,unfold=true)", "%B"]
    .join("%x00");
  const raw = git(["log", "-1", `--format=${format}`, hash]);
  const parts = raw.split("\0");
  const meta: CommitMeta = {
    hash,
    authorName: parts[0],
    authorEmail: parts[1],
    authorDate: parts[2],
    committerName: parts[3],
    committerEmail: parts[4],
    committerDate: parts[5],
    short: parts[6],
    trailers: parts[7],
    message: parts[8],
  };
  _commitMetaCache.set(hash, meta);
  if (_commitMetaCache.size > META_CACHE_MAX) {
    _commitMetaCache.delete(_commitMetaCache.keys().next().value!);  // evict LRU
  }
  return meta;
}

function buildCommitEnv(meta: CommitMeta): Record<string, string> {
  return {
    GIT_AUTHOR_NAME: meta.authorName,
    GIT_AUTHOR_EMAIL: meta.authorEmail,
    GIT_AUTHOR_DATE: meta.authorDate,
    GIT_COMMITTER_NAME: meta.committerName,
    GIT_COMMITTER_EMAIL: meta.committerEmail,
    GIT_COMMITTER_DATE: meta.committerDate,
  };
}

/**
 * `--no-walk` bypasses path-filter simplification, which would silently drop
 * merge parents TREESAME at the path. Chunked for argv limits.
 */
function fetchTrueParents(hashes: string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  if (hashes.length === 0) return map;
  const CHUNK = 500;
  for (let i = 0; i < hashes.length; i += CHUNK) {
    const chunk = hashes.slice(i, i + CHUNK);
    const result = git(["log", "--no-walk", "--format=%H %P", ...chunk], { safe: true });
    if (!result.ok) {
      fail(`Failed to fetch parents for ${chunk.length} commit(s): ${result.stderr}`);
    }
    for (const line of result.stdout.split("\n").filter(Boolean)) {
      const parts = line.split(/\s+/).filter(Boolean);
      map.set(parts[0], parts.slice(1));
    }
  }
  return map;
}

function collectSourceCommits(dc: DirectionConfig, branches: string[]): TopoCommit[] {
  // --full-history surfaces all merges in the path-filtered reachable set;
  // filterLoadBearingCommits drops the non-load-bearing ones afterward.
  const args = ["log", "--topo-order", "--reverse", "--full-history", "--format=%H",
    ...branches.map(b => `${dc.source.remote}/${b}`)];
  // Path filter only when no mapping is at root. Any root source means the
  // whole commit graph is in-scope and no `--` is added.
  if (dc.mappings.length > 0 && !anyRootSource(dc)) {
    args.push("--", ...sourceDirsOf(dc).map(d => `${d}/`));
  }
  const result = git(args, { safe: true });
  if (!result.ok) fail(`log failed (${args.join(" ")}): ${result.stderr}`);
  if (!result.stdout) return [];
  const hashes = result.stdout.split("\n").filter(Boolean);
  const parentsMap = fetchTrueParents(hashes);
  return hashes.map(hash => ({ hash, parents: parentsMap.get(hash) ?? [] }));
}

// Log "<label>: P% (i/total)" each time i crosses a 10% boundary — for long
// phases (>100 items) where per-item logging would be noise.
const PROGRESS_THRESHOLD = 100;
function logDecileProgress(label: string, i: number, total: number): void {
  const step = Math.ceil(total / 10);
  if (step > 0 && (i % step === 0 || i === total)) {
    console.log(`  ${label}: ${Math.round((i / total) * 100)}% (${i}/${total})`);
  }
}

function filterLoadBearingCommits(
  commits: TopoCommit[],
  dc: DirectionConfig,
  alreadyReplayed: Set<string>,
): TopoCommit[] {
  // commits arrive --topo-order --reverse (oldest first), so by the time we
  // evaluate a merge, every ancestor's keep/drop decision is already in keptSet.
  const keptSet = new Set<string>();
  const kept: TopoCommit[] = [];
  const total = commits.length;
  const showProgress = total > PROGRESS_THRESHOLD;
  let i = 0;
  for (const c of commits) {
    i++;
    // An already-replayed commit was load-bearing-kept in a prior run.
    if (alreadyReplayed.has(c.hash)) {
      keptSet.add(c.hash);
    } else if (isLoadBearing(c, dc, keptSet)) {
      keptSet.add(c.hash);
      kept.push(c);
    }
    if (showProgress) logDecileProgress("Scanned", i, total);
  }
  return kept;
}

/**
 * Drop iff the commit's effective source tree (composed across all mappings)
 * matches the 1st parent's AND (for merges) every non-first parent's
 * exclusive ancestry above its merge-base with the 1st parent is empty of
 * kept commits. P1 is the trunk; any Pi (i>=1) contributing a kept commit
 * anchors the merge.
 */
// True iff `<hash>:<sourceDir>` resolves to a tree. Root ("") is always
// present; memoized since a non-root slice's presence rarely changes.
const _slicePresentCache = new Map<string, boolean>();
function slicePresent(hash: string, sourceDir: string): boolean {
  if (!sourceDir) return true;
  const key = `${hash}:${sourceDir}`;
  const hit = _slicePresentCache.get(key);
  if (hit !== undefined) return hit;
  const r = git(["cat-file", "-t", `${hash}:${sourceDir}`], { safe: true });
  const present = r.ok && r.stdout === "tree";
  _slicePresentCache.set(key, present);
  return present;
}

// True iff the commit's diff vs `parent`, after mapping + ignore filtering,
// has any surviving path — i.e. it changes content that flows to the target.
// O(changed files), mirroring buildReplayedTree's ownership/ignore rules.
function sliceChangedVsParent(
  parent: string,
  commit: string,
  dc: DirectionConfig,
  ignoreBySrc: RegExp[][],
): boolean {
  const args = ["diff-tree", "-r", parent, commit];
  if (!anyRootSource(dc)) args.push("--", ...sourceDirsOf(dc).map(d => `${d}/`));
  const res = git(args, { safe: true });
  if (!res.ok) return true;
  if (!res.stdout) return false;
  const sorted = dc.mappings.map((m, i) => ({ source: m.source, idx: i }))
    .sort((a, b) => b.source.length - a.source.length);
  for (const line of res.stdout.split("\n")) {
    const m = line.match(/^:\d+ \d+ [0-9a-f]+ [0-9a-f]+ [AMDT]\t(.+)$/);
    if (!m) continue;
    const filePath = m[1];
    const owner = sorted.find(o => o.source === "" || filePath === o.source || filePath.startsWith(`${o.source}/`));
    if (!owner) continue;
    const srcRelative = owner.source ? filePath.slice(owner.source.length + 1) : filePath;
    if ((ignoreBySrc[owner.idx] ?? []).some(p => p.test(srcRelative))) continue;
    return true;
  }
  return false;
}

function isLoadBearing(
  c: TopoCommit,
  dc: DirectionConfig,
  keptSet: Set<string>,
): boolean {
  if (c.parents.length === 0) return true;
  const p1 = c.parents[0];

  // Missing source slice (at c or p1) load-bears, matching the old fingerprint
  // "" escape. Root is always present, so this only fires for a non-root
  // mapping whose dir hasn't appeared yet (or just vanished).
  for (const m of dc.mappings) {
    if (!slicePresent(c.hash, m.source) || !slicePresent(p1, m.source)) return true;
  }

  const ignoreBySrc = dc.mappings.map((m, i) =>
    readShadowIgnorePatterns(c.hash, m.source, dc.autoIgnoreBySourceIdx[i] ?? []));
  if (sliceChangedVsParent(p1, c.hash, dc, ignoreBySrc)) return true;

  if (c.parents.length === 1) return false;
  for (let i = 1; i < c.parents.length; i++) {
    if (hasKeptExclusiveAncestor(c.parents[i], p1, keptSet)) return true;
  }
  return false;
}

// Returns true iff `git log pi ^p1` contains any commit in keptSet —
// i.e., Pi contributes at least one kept commit not already reachable from P1.
function hasKeptExclusiveAncestor(pi: string, p1: string, keptSet: Set<string>): boolean {
  if (keptSet.size === 0) return false;
  const result = git(["log", "--format=%H", pi, `^${p1}`], { safe: true });
  if (!result.ok) return false;
  for (const line of result.stdout.split("\n")) {
    const h = line.trim();
    if (h && keptSet.has(h)) return true;
  }
  return false;
}


/**
 * Drop already-replayed and echoed commits. Echoes get echo→original recorded
 * in shaMapping so parent resolution reuses the real target SHA rather than
 * re-replaying or falling back to the branch tip.
 *
 * Cross-pair shadow commits (carrying a sibling pair's trailer) are NOT
 * dropped here: when two pairs share a source dir on mono (e.g. common/), a
 * frontend-originated commit reaching backend's pair via the monorepo must
 * replay onto backend's shadow so the original author's commit appears in
 * backend's history rather than being flattened into the integrating merge.
 */
// Batched trailer fetch (one `git log` per ~500 commits, NUL-separated).
function fetchTrailersBatch(hashes: string[]): Map<string, string> {
  const map = new Map<string, string>();
  if (hashes.length === 0) return map;
  const CHUNK = 500;
  for (let i = 0; i < hashes.length; i += CHUNK) {
    const chunk = hashes.slice(i, i + CHUNK);
    const res = git(["log", "--no-walk", "-z", "--format=%H%n%(trailers:only,unfold=true)", ...chunk],
      { safe: true, raw: true });
    if (!res.ok) fail(`Failed to fetch trailers for ${chunk.length} commit(s): ${res.stderr}`);
    for (const rec of res.stdout.split("\0")) {
      if (!rec) continue;
      const nl = rec.indexOf("\n");
      const hash = (nl < 0 ? rec : rec.slice(0, nl)).trim();
      if (hash) map.set(hash, nl < 0 ? "" : rec.slice(nl + 1));
    }
  }
  return map;
}

function filterNotReplayedCommits(
  allCommits: TopoCommit[],
  shaMapping: Map<string, string>,
  dc: DirectionConfig,
): TopoCommit[] {
  const skipKey = targetTrailerKey(dc);
  const skipRe = targetTrailerRegex(dc);
  const trailersByHash = fetchTrailersBatch(allCommits.filter(c => !shaMapping.has(c.hash)).map(c => c.hash));
  return allCommits.filter(c => {
    if (shaMapping.has(c.hash)) return false;
    const trailers = trailersByHash.get(c.hash) ?? "";
    if (hasTrailer(trailers, skipKey)) {
      const match = trailers.split("\n")
        .map(l => l.match(skipRe))
        .find(m => m);
      if (match && refExists(match[1])) {
        shaMapping.set(c.hash, match[1]);
      }
      return false;
    }
    return true;
  });
}

/**
 * Drops candidates whose replay would orphan: pass 1 walks each branch
 * topo-order newest-first stopping at the first mapped ancestor (mirroring
 * mapBranchesToTargetTips) — anything seen anchors a tip; pass 2 pulls in
 * unmapped candidate parents of kept commits so resolveTargetParents won't
 * fall back to findEchoAnchor with a different topology.
 */
function dropOrphanedCommits(
  newCommits: TopoCommit[],
  branches: string[],
  shaMapping: Map<string, string>,
  remote: string,
  sourceCommits: TopoCommit[],
): TopoCommit[] {
  const newSet = new Set(newCommits.map(c => c.hash));
  const kept = new Set<string>();

  for (const branch of branches) {
    const log = git(["log", "--first-parent", "--format=%H", `${remote}/${branch}`], { safe: true });
    if (!log.ok) fail(`log ${remote}/${branch} failed while dropping orphaned commits: ${log.stderr}`);
    for (const line of log.stdout.split("\n")) {
      const hash = line.trim();
      if (!hash) continue;
      if (shaMapping.has(hash)) break;
      if (newSet.has(hash)) kept.add(hash);
    }
  }

  // Parents are already on the TopoCommit objects (collectSourceCommits ran
  // `log %P` over the whole set); reuse them instead of a git query per commit.
  // Fall back per-commit only for passthrough hashes outside the set.
  const parentsByHash = new Map(sourceCommits.map(c => [c.hash, c.parents]));
  const parentsOf = (hash: string): string[] => {
    const cached = parentsByHash.get(hash);
    if (cached) return cached;
    const res = git(["log", "-1", "--format=%P", hash], { safe: true });
    if (!res.ok) fail(`log -1 --format=%P ${hash} failed: ${res.stderr}`);
    return res.stdout ? res.stdout.split(/\s+/).filter(Boolean) : [];
  };

  const visited = new Set<string>();
  const stack = Array.from(kept);
  while (stack.length) {
    const hash = stack.pop()!;
    if (visited.has(hash)) continue;
    visited.add(hash);
    for (const p of parentsOf(hash)) {
      if (shaMapping.has(p) || visited.has(p)) continue;
      if (newSet.has(p) && !kept.has(p)) kept.add(p);
      // Walk through even when p isn't in newSet — passthrough commits
      // (non-mapped, non-path-touching) can sit between a kept merge and
      // a deeper kept ancestor on a non-first-parent edge.
      stack.push(p);
    }
  }

  return newCommits.filter(c => kept.has(c.hash));
}

// ── Ignore patterns ──────────────────────────────────────────────

// Always strip .shadowignore files themselves from the synced tree — they're
// source-side metadata for shadow-sync, never replayed onto the target.
const SHADOWIGNORE_SELF_RE = /^(?:.*\/)?\.shadowignore$/;

// Read .shadowignore files at every level from sourceDir up to the repo root
// (gitignore-style: deeper files layer on top of root-level files). File
// contents are read at the commit's snapshot so patterns can evolve through
// history. `extraPatterns` (e.g. auto-derived intra-pair nested-mapping
// patterns) are prepended so the .shadowignore-file layer composes on top.
function readShadowIgnorePatterns(
  commitHash: string,
  sourceDir: string,
  extraPatterns: RegExp[] = [],
): RegExp[] {
  const patterns: RegExp[] = [SHADOWIGNORE_SELF_RE, ...extraPatterns];

  const dirs: string[] = [];
  if (sourceDir) {
    const parts = sourceDir.split("/");
    for (let i = parts.length; i > 0; i--) dirs.push(parts.slice(0, i).join("/"));
  }
  dirs.push("");

  // One probe for all candidate .shadowignore paths; usually none exist.
  const ignorePaths = dirs.map(d => d ? `${d}/.shadowignore` : ".shadowignore");
  const probe = git(["ls-tree", "-z", commitHash, ...ignorePaths], { safe: true, raw: true });
  if (!probe.ok || !probe.stdout) return patterns;

  for (const entry of probe.stdout.split("\0")) {
    if (!entry) continue;
    const tab = entry.indexOf("\t");
    if (tab < 0) continue;
    const ignorePath = entry.slice(tab + 1);
    const dir = ignorePath === ".shadowignore" ? "" : ignorePath.slice(0, -"/.shadowignore".length);
    const res = git(["show", `${commitHash}:${ignorePath}`], { safe: true });
    if (!res.ok || !res.stdout) continue;
    for (const raw of res.stdout.split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"))) {
      const compiled = compileShadowIgnoreLine(raw, dir, sourceDir);
      if (compiled) patterns.push(compiled);
    }
  }
  return patterns;
}

// Compile a single .shadowignore line per gitignore semantics, translated
// from `ignoreDir`-relative paths into `sourceDir`-relative paths (the space
// matched by effectiveSourceTree / buildReplayedTree).
//
// Returns null if the pattern targets a sibling subtree outside sourceDir.
// Negation (`!pattern`) is not supported and silently dropped.
function compileShadowIgnoreLine(rawPattern: string, ignoreDir: string, sourceDir: string): RegExp | null {
  if (rawPattern.startsWith("!")) return null;

  let pattern = rawPattern;
  const isDirOnly = pattern.endsWith("/");
  if (isDirOnly) pattern = pattern.slice(0, -1);

  const anchoredToIgnoreDir = pattern.startsWith("/");
  if (anchoredToIgnoreDir) pattern = pattern.slice(1);

  const hasInternalSlash = pattern.includes("/");
  const isAnchored = anchoredToIgnoreDir || hasInternalSlash;

  let translated: string;
  if (!isAnchored) {
    // No slash: gitignore matches basename at any depth → works in any space.
    translated = pattern;
  } else if (sourceDir === ignoreDir) {
    translated = pattern;
  } else {
    // ignoreDir is a strict prefix of sourceDir (we walk up from sourceDir).
    const relDir = ignoreDir ? sourceDir.slice(ignoreDir.length + 1) : sourceDir;
    if (pattern === relDir) {
      // Pattern points at sourceDir itself; dir-match means everything inside.
      if (!isDirOnly) return null;
      translated = "**";
    } else if (pattern.startsWith(`${relDir}/`)) {
      translated = pattern.slice(relDir.length + 1);
    } else {
      return null;
    }
  }

  const regex = globToRegexSource(translated);

  const prefix = isAnchored ? "^" : "(^|.*/)";
  const suffix = isDirOnly ? "/.*$" : "$";
  return new RegExp(`${prefix}${regex}${suffix}`);
}

// Translate a glob (supporting * and ** globs) into an unanchored regex source
// fragment. Callers add their own anchoring/prefix/suffix.
function globToRegexSource(glob: string): string {
  return glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "<<GLOBSTAR_SLASH>>")
    .replace(/\*\*/g, "<<GLOBSTAR>>")
    .replace(/\*/g, "[^/]*")
    .replace(/<<GLOBSTAR_SLASH>>/g, "(.*/)?")
    .replace(/<<GLOBSTAR>>/g, ".*");
}

/** Compile a glob pattern (supports * and ** globs) into an anchored regex. */
export function compileIgnorePattern(pattern: string): RegExp {
  return new RegExp(`^${globToRegexSource(pattern)}$`);
}

// ── Branch filters ────────────────────────────────────────────────────────────

interface BranchFilterDoc { filters?: Record<string, string[]>; }

const BRANCH_FILTERS_PATH = path.join(path.dirname(CONFIG_PATH), "branch-filters.json");

/**
 * Required allowlist: missing file = empty map = zero branches synced.
 * The filter is the explicit declaration of what the operator wants synced;
 * silently falling through to "sync everything" defeats the safety the
 * allowlist provides.
 */
function loadBranchFilters(): Map<string, RegExp[]> {
  if (!fs.existsSync(BRANCH_FILTERS_PATH)) return new Map();
  const doc = JSON.parse(fs.readFileSync(BRANCH_FILTERS_PATH, "utf8")) as BranchFilterDoc;
  const out = new Map<string, RegExp[]>();
  for (const [remote, patterns] of Object.entries(doc.filters ?? {})) {
    out.set(remote, (patterns ?? []).map(compileIgnorePattern));
  }
  return out;
}

let _branchFilters: Map<string, RegExp[]> = loadBranchFilters();
if (_branchFilters.size === 0) {
  console.error(`  ${fs.existsSync(BRANCH_FILTERS_PATH) ? "branch-filters.json is empty" : "branch-filters.json not present"} — no branches will be synced.`);
}

export function filterBranchesForRemote(remote: string, branches: string[]): string[] {
  const patterns = _branchFilters.get(remote);
  if (patterns === undefined) return [];
  return branches.filter(b => patterns.some(re => re.test(b)));
}

/** Test hook — installs an in-memory filter map. `null` resets to empty (zero branches). */
export function setBranchFiltersForTesting(map: Map<string, RegExp[]> | null): void {
  _branchFilters = map ?? new Map();
}

// ── Tree composition ──────────────────────────────────────────────

/**
 * Apply this commit's diff (vs first parent) to parentTree, composed across
 * all of the pair's source→target mappings. Root commits become additions of
 * every file under every source dir.
 */
function buildReplayedTree(opts: {
  commitHash: string;
  sourceFirstParent: string | null;
  dc: DirectionConfig;
  parentTree: string | null;
  tmpIndex: string;
  shadowIgnorePatternsBySourceIdx: RegExp[][];
}): string | null {
  const { commitHash, sourceFirstParent, dc, parentTree, tmpIndex, shadowIgnorePatternsBySourceIdx } = opts;
  const idxEnv = { GIT_INDEX_FILE: tmpIndex };

  if (parentTree) {
    git(["read-tree", parentTree], { env: idxEnv });
  } else {
    git(["read-tree", "--empty"], { env: idxEnv });
  }

  // diff-tree -r format: :oldmode newmode oldhash newhash status\tpath
  // Any "" source matches the entire tree → skip the pathspec filter so
  // siblings of more-specific sources (e.g. src/init.txt next to src/common)
  // aren't excluded. Otherwise pass the non-root dirs to git's pathspec.
  // sourceFirstParent is the commit's real first parent (from the TopoCommit);
  // null means a source root, which diffs as all-additions below.
  let diffOutput: string;

  if (sourceFirstParent) {
    const diffArgs = ["diff-tree", "-r", sourceFirstParent, commitHash];
    if (!anyRootSource(dc)) diffArgs.push("--", ...sourceDirsOf(dc).map(d => `${d}/`));
    const diffRes = git(diffArgs, { safe: true });
    if (!diffRes.ok) {
      fail(`diff-tree failed for ${commitHash}: ${diffRes.stderr}`);
    }
    diffOutput = diffRes.stdout;
  } else {
    // Source root has no parent tree to diff against — reshape ls-tree into diff-tree's "A" entries so downstream logic sees a normal diff.
    const lsArgs = ["ls-tree", "-r", commitHash];
    if (!anyRootSource(dc)) lsArgs.push("--", ...sourceDirsOf(dc).map(d => `${d}/`));
    const lsResult = git(lsArgs, { safe: true });
    if (!lsResult.ok || !lsResult.stdout) return null;
    diffOutput = lsResult.stdout.split("\n").filter(Boolean)
      .map(line => {
        const m = line.match(/^(\d+)\s+\w+\s+([0-9a-f]+)\t(.+)$/);
        if (!m) return "";
        return `:000000 ${m[1]} ${"0".repeat(40)} ${m[2]} A\t${m[3]}`;
      }).join("\n");
  }

  if (!diffOutput) return parentTree ?? null;

  // Mappings sorted by source-length desc so longest-prefix wins for nested
  // source dirs. (Disjointness rules out true nesting between two of OUR
  // mappings, but ordering keeps the fallback unambiguous.)
  const sortedMappings = dc.mappings.map((m, i) => ({ ...m, idx: i }))
    .sort((a, b) => b.source.length - a.source.length);

  // No -M/-C above, so renames surface as D+A — we only handle A/M/D/T.
  const removals: string[] = [];
  const additions: string[] = [];   // "mode hash\tpath" lines for --index-info
  for (const line of diffOutput.split("\n").filter(Boolean)) {
    const m = line.match(/^:\d+ (\d+) [0-9a-f]+ ([0-9a-f]+) ([AMDT])\t(.+)$/);
    if (!m) continue;
    const [, newMode, newHash, status, filePath] = m;

    // Pick the owning mapping: first source dir that matches the file path.
    const owner = sortedMappings.find(om =>
      om.source === "" || filePath === om.source || filePath.startsWith(`${om.source}/`));
    if (!owner) continue;

    const srcRelative = owner.source ? filePath.slice(owner.source.length + 1) : filePath;
    if ((shadowIgnorePatternsBySourceIdx[owner.idx] ?? []).some(p => p.test(srcRelative))) continue;

    const targetPath = owner.target ? `${owner.target}/${srcRelative}` : srcRelative;

    if (status === "D") {
      removals.push(targetPath);
    } else {
      additions.push(`${newMode} ${newHash}\t${targetPath}`);
    }
  }


  applyIndexInfo(idxEnv, removals, additions);

  return git(["write-tree"], { env: idxEnv });
}

const NULL_SHA = "0".repeat(40);

/**
 * Stage `removals` (deletes) and `additions` against `idxEnv`'s index in a
 * single `update-index --index-info` call over stdin. `additions` are already
 * "<mode> <sha>\t<path>" lines; `removals` become mode-0 delete lines. Stdin
 * has no length limit, so this is safe for arbitrarily large file lists —
 * unlike `git rm -- <paths>`, whose argv overflows CreateProcess on Windows.
 */
function applyIndexInfo(
  idxEnv: { GIT_INDEX_FILE: string },
  removals: string[],
  additions: string[],
): void {
  if (removals.length === 0 && additions.length === 0) return;
  const lines = [
    ...removals.map(p => `0 ${NULL_SHA}\t${p}`),
    ...additions,
  ];
  git(["update-index", "--index-info"], { env: idxEnv, input: lines.join("\n") + "\n" });
}

/** Allocate a private git index, run `fn` against it, then delete it. */
function withTmpIndex<T>(label: string, fn: (idxEnv: { GIT_INDEX_FILE: string }) => T): T {
  const tmpIndex = path.join(
    os.tmpdir(),
    `shadow-${label}-${process.pid}-${crypto.randomBytes(6).toString("hex")}`,
  );
  try {
    return fn({ GIT_INDEX_FILE: tmpIndex });
  } finally {
    fs.rmSync(tmpIndex, { force: true });
  }
}

/** Build a tree from `refOrTree` with every `subdirs[i]/` stripped — the "outer" slice. */
function outerOnlyTree(refOrTree: string, subdirs: string[]): string {
  const nonRoot = subdirs.filter(d => d !== "");
  if (nonRoot.length === 0) {
    // All-root means the outer is empty.
    const res = git(["mktree"], { input: "" });
    return res;
  }
  return withTmpIndex("outer", idxEnv => {
    git(["read-tree", refOrTree], { env: idxEnv });
    git(["rm", "-rf", "--cached", "-q", "--ignore-unmatch", "--", ...nonRoot], { env: idxEnv, safe: true });
    return git(["write-tree"], { env: idxEnv });
  });
}

/** Splice each `slices[i].content` into `baseTree` at `slices[i].subdir`. */
function composeSubtrees(baseTree: string, slices: Array<{ subdir: string; content: string }>): string {
  const rootSlice = slices.find(s => s.subdir === "");
  const nonRoot = slices.filter(s => s.subdir !== "");
  return withTmpIndex("compose", idxEnv => {
    // Establish base: the root slice wins wholesale if present; otherwise the
    // caller-supplied baseTree.
    if (rootSlice) {
      git(["read-tree", rootSlice.content], { env: idxEnv });
    } else {
      git(["read-tree", baseTree], { env: idxEnv });
    }
    // Strip every non-root subdir from the base before splicing in the
    // mapping-specific content, so read-tree --prefix can populate cleanly.
    if (nonRoot.length > 0) {
      git(["rm", "-rf", "--cached", "-q", "--ignore-unmatch", "--",
        ...nonRoot.map(s => s.subdir)], { env: idxEnv, safe: true });
      for (const s of nonRoot) {
        git(["read-tree", `--prefix=${s.subdir}/`, s.content], { env: idxEnv });
      }
    }
    return git(["write-tree"], { env: idxEnv });
  });
}

/** Return a new tree SHA equal to `treeSha` minus every path matching any of
 *  `ignorePatterns` (paths are tested relative to the tree root). When no
 *  patterns match, returns `treeSha` unchanged so the splice is a no-op. */
function filterTreeByIgnore(treeSha: string, ignorePatterns: RegExp[]): string {
  if (ignorePatterns.length === 0) return treeSha;
  return withTmpIndex("autoignore", idxEnv => {
    const readRes = git(["read-tree", treeSha], { env: idxEnv, safe: true });
    if (!readRes.ok) return treeSha;
    const ls = git(["ls-files"], { env: idxEnv, safe: true });
    if (ls.ok && ls.stdout) {
      const toRemove = ls.stdout.split("\n").filter(Boolean)
        .filter(p => ignorePatterns.some(re => re.test(p)));
      // stdin-based delete (see applyIndexInfo) — avoids argv overflow on Windows.
      applyIndexInfo(idxEnv, toRemove, []);
    }
    return git(["write-tree"], { env: idxEnv });
  });
}

/** For each mapping, read `<fromHash>:<m[side]>` and splice it into `base` at
 *  `m.target`. Returns null if any slice ref fails to resolve — caller decides
 *  whether to fall back to bare `base` or halt. Each slice is filtered through
 *  the per-mapping intra-pair auto-ignore patterns so paths owned by sibling
 *  mappings (nested under this one's source/target dir) don't bleed into this
 *  mapping's spliced region — the sibling's own splice covers them at the
 *  correct target path. */
let _emptyTreeSha: string | null = null;
function emptyTreeSha(): string {
  if (_emptyTreeSha === null) _emptyTreeSha = git(["mktree"], { input: "" });
  return _emptyTreeSha;
}

function spliceMappings(
  base: string,
  fromHash: string,
  side: "source" | "target",
  dc: DirectionConfig,
  extraIgnoreByIdx?: RegExp[][],
): string | null {
  const autoPatterns = side === "source" ? dc.autoIgnoreBySourceIdx : dc.autoIgnoreByTargetIdx;
  const slices: Array<{ subdir: string; content: string }> = [];
  for (let i = 0; i < dc.mappings.length; i++) {
    const m = dc.mappings[i];
    const sub = m[side];
    const ref = sub ? `${fromHash}:${sub}` : `${fromHash}^{tree}`;
    const res = git(["rev-parse", ref], { safe: true });
    if (!res.ok) {
      // The mapped dir doesn't exist at this commit
      if (!sub) return null;
      slices.push({ subdir: m.target, content: emptyTreeSha() });
      continue;
    }
    // extraIgnoreByIdx carries the per-commit .shadowignore (round-trip source
    // splice only); paths in `fromHash:sub` are already source-dir-relative, so
    // the patterns match. Union with auto-ignore is harmless if they overlap.
    const patterns = extraIgnoreByIdx
      ? [...(autoPatterns[i] ?? []), ...(extraIgnoreByIdx[i] ?? [])]
      : (autoPatterns[i] ?? []);
    const filtered = filterTreeByIgnore(res.stdout, patterns);
    slices.push({ subdir: m.target, content: filtered });
  }
  return composeSubtrees(base, slices);
}

/**
 * Outcome of composeMergeBaseTree: a base tree SHA, or a halt carrying the
 * reason that selects the operator diagnostic in formatHaltDiagnostic.
 *   outer-divergence       — mapped parents of a real merge disagree on outer
 *                            state (operator-resolvable; full round-trip recipe).
 *   multi-echo-disagreement — several already-replayed (echo) parents disagree.
 *   missing-tree           — a required parent tree or mapped subdir was absent.
 */
type ComposeHaltKind = "outer-divergence" | "multi-echo-disagreement" | "missing-tree";
interface ComposeHalt { halt: ComposeHaltKind; }
function isHalt(r: unknown): r is ComposeHalt {
  return typeof r === "object" && r !== null && "halt" in r;
}

/** First mapped parent's full tree. mappedParents[0] is always a valid replayed
 *  commit by construction; an unreadable tree means repo corruption, not an
 *  operator-resolvable conflict — so abort the run rather than halt one branch. */
function firstParentTree(mappedParents: string[], commitShort: string): string {
  const treeRes = git(["rev-parse", `${mappedParents[0]}^{tree}`], { safe: true });
  if (!treeRes.ok || !treeRes.stdout) fail(`Cannot read tree of mapped parent ${mappedParents[0]} for ${commitShort}.`);
  return treeRes.stdout;
}

/**
 * Reconcile the OUTER (files outside target.dir/) across ≥2 mapped parents. The
 * caller splices the first parent's inner over the result, so this only decides
 * outer state.
 *   2 parents, clean merge-tree → the auto-merged outer. Ancestor/descendant
 *     pairs reduce to a fast-forward, preserving outer a first-parent fallback
 *     would drop.
 *   2-parent conflict / 3+ parents → outer-agreement: every parent must share
 *     the same outer. The source commit's scope can't author an outer-state
 *     difference, so divergence halts.
 */
function reconcileOuter(mappedParents: string[], dc: DirectionConfig): { tree: string } | ComposeHalt {
  const targetDirs = targetDirsOf(dc);
  if (mappedParents.length === 2) {
    const mergeRes = git(["merge-tree", "--write-tree", mappedParents[0], mappedParents[1]], { safe: true });
    // Clean auto-merge prints just the tree SHA; a conflict prints a multiline
    // body, so the full-string match fails and we fall through to agreement.
    if (mergeRes.ok && /^[0-9a-f]{40}$/.test(mergeRes.stdout)) {
      return { tree: outerOnlyTree(mergeRes.stdout, targetDirs) };
    }
  }
  const outers = mappedParents.map(p => outerOnlyTree(p, targetDirs));
  if (outers.every(o => o === outers[0])) return { tree: outers[0] };
  return { halt: "outer-divergence" };
}

/**
 * Echo splice: if ≥1 source parent already round-tripped (carries the target
 * trailer), old shadow commits must reflect target's outer state at the time,
 * not a frozen bootstrap snapshot — so splice the inner over the echo'd outer.
 *   Round-trip (echo target is itself a mapped parent — the operator's
 *     resolution merge Mm, kept in the parent set by resolveHaltAwareParents):
 *     splice the CURRENT commit's source-side inner (the operator's resolved
 *     inner, including any backend-only intermediate work) over Mm's outer.
 *   Otherwise: splice the first parent's inner over the echo'd outer.
 *   Multi-echo: the echo'd outers must agree.
 * Returns "none" when no parent is an echo, so the caller continues to the
 * parent-count dispatch.
 */
function resolveEcho(
  commit: TopoCommit,
  mappedParents: string[],
  shaMapping: Map<string, string>,
  dc: DirectionConfig,
  shadowIgnoreBySourceIdx: RegExp[][],
): { tree: string } | ComposeHalt | "none" {
  const skipKey = targetTrailerKey(dc);
  const echoTargets: string[] = [];
  for (const sourceParent of commit.parents) {
    const parentMeta = getCommitMeta(sourceParent);
    if (hasTrailer(parentMeta.trailers, skipKey)) {
      const mapped = shaMapping.get(sourceParent);
      if (mapped) echoTargets.push(mapped);
    }
  }
  if (echoTargets.length === 0) return "none";

  if (echoTargets.length > 1) {
    const outers = echoTargets.map(t => outerOnlyTree(t, targetDirsOf(dc)));
    if (!outers.every(o => o === outers[0])) return { halt: "multi-echo-disagreement" };
  }

  const echoTargetSHA = echoTargets[0];
  const echoTreeRes = git(["rev-parse", `${echoTargetSHA}^{tree}`], { safe: true });
  if (!echoTreeRes.ok) return { halt: "missing-tree" };

  // Round-trip splices the commit's OWN source tree (fresh, unfiltered), so
  // apply .shadowignore here — buildReplayedTree's diff overlay only filters
  // changed paths and would let a base-borne ignored file survive otherwise.
  const spliced = mappedParents.includes(echoTargetSHA)
    ? spliceMappings(echoTreeRes.stdout, commit.hash, "source", dc, shadowIgnoreBySourceIdx)
    : spliceMappings(echoTreeRes.stdout, mappedParents[0], "target", dc);
  return spliced === null ? { halt: "missing-tree" } : { tree: spliced };
}

/**
 * Build the base tree for replaying `commit` onto `mappedParents`.
 * buildReplayedTree later overlays diff(firstParent → commit) within the synced
 * region as an ABSOLUTE apply, so the base must already equal the commit's
 * content everywhere that diff won't overwrite. That reduces to one invariant:
 * the base's inner (synced) region must be the FIRST PARENT's inner, and (cross-
 * repo) its outer must be the commit's reconciled outer. Taking any other inner
 * — e.g. an auto-merged tree — drops resolutions that re-assert the first parent
 * (the diff is empty there, so the wrong inner survives verbatim).
 *
 * Cross-repo (target.dir set): reconcile the outer, then splice the first
 *   parent's inner over it. The inner splice lives in exactly ONE place so no
 *   branch can substitute a divergent inner. The lone exception is an echo
 *   round-trip, where the inner is the commit's own resolved source (resolveEcho).
 * Same-repo (no target.dir): the synced region is the whole tree, so
 *   diff(firstParent → commit) covers everything and the first parent's tree is
 *   the correct base verbatim.
 */
function composeMergeBaseTree(opts: {
  commit: TopoCommit;
  mappedParents: string[];
  shaMapping: Map<string, string>;
  dc: DirectionConfig;
  shadowIgnoreBySourceIdx: RegExp[][];
}): string | ComposeHalt {
  const { commit, mappedParents, shaMapping, dc, shadowIgnoreBySourceIdx } = opts;
  const commitShort = commit.hash.slice(0, 8);
  const confined = allTargetsConfined(dc);

  // Echo splice runs first — handles the round-trip case even when the commit
  // has a single mapped parent that is itself the echo target.
  if (confined) {
    const echo = resolveEcho(commit, mappedParents, shaMapping, dc, shadowIgnoreBySourceIdx);
    if (echo !== "none") return isHalt(echo) ? echo : echo.tree;
  }

  // 1 parent: outer can't have diverged; inner is that parent's. (fast path)
  if (mappedParents.length === 1) return firstParentTree(mappedParents, commitShort);

  // Same-repo: the first parent's tree is the correct base verbatim.
  if (!confined) return firstParentTree(mappedParents, commitShort);

  // Cross-repo, ≥2 parents: reconcile the outer, splice first parent's inner.
  const outer = reconcileOuter(mappedParents, dc);
  if (isHalt(outer)) return outer;
  const spliced = spliceMappings(outer.tree, mappedParents[0], "target", dc);
  return spliced === null ? { halt: "missing-tree" } : spliced;
}

// ── Ancestry resolution ──────────────────────────────────────────────────────


/** For parents outside the sync's scope, anchor to the newest replayed ancestor. */
function findEchoAnchor(parentHash: string, shaMapping: Map<string, string>): string | null {
  const result = git(["log", "--topo-order", "--format=%H", parentHash], { safe: true });
  if (!result.ok) return null;
  for (const line of result.stdout.split("\n")) {
    const hash = line.trim();
    if (!hash) continue;
    const mapped = shaMapping.get(hash);
    if (mapped) return mapped;
  }
  return null;
}

/**
 * Find target side parent from source side hash:
 * 1. parent recorded in shaMapping
 * 2. parent is in a Halt state
 * 3. unknown parents replaced by root
 */
function resolveHaltAwareParents(
  commit: TopoCommit,
  shaMapping: Map<string, string>,
  targetInit: string | null,
  haltedSources: Set<string>,
  haltReasons: Map<string, HaltReason>,
): string[] {
  if (commit.parents.length === 0) {
    return targetInit ? [targetInit] : [];
  }
  const parents: string[] = [];
  const seen = new Set<string>();
  const pushUnique = (sha: string | null | undefined) => {
    if (sha && !seen.has(sha)) { parents.push(sha); seen.add(sha); }
  };
  for (const parentHash of commit.parents) {
    if (shaMapping.has(parentHash)) {
      pushUnique(shaMapping.get(parentHash));
      continue;
    }
    if (haltedSources.has(parentHash)) {
      const reason = haltReasons.get(parentHash);
      if (reason && reason.anchorCommits.length > 0) {
        for (const ac of reason.anchorCommits) pushUnique(ac);
        continue;
      }
    }
    pushUnique(findEchoAnchor(parentHash, shaMapping) ?? targetInit);
  }
  return parents;
}

/**
 * BFS from the commit's source-side parents through halted unmapped ancestors,
 * stopping at mapped commits. Returns the halted SHAs to encode as
 * `Shadow-replayed` trailers on this commit's replay, so subsequent sync runs
 * see them as already replayed and skip retrying them.
 */
function collectAbsorbedHalted(
  commit: TopoCommit,
  haltedSources: Set<string>,
  shaMapping: Map<string, string>,
): string[] {
  const absorbed = new Set<string>();
  const seen = new Set<string>();
  const stack = [...commit.parents];
  while (stack.length) {
    const p = stack.pop()!;
    if (seen.has(p) || shaMapping.has(p)) continue;
    seen.add(p);
    if (!haltedSources.has(p)) continue;
    absorbed.add(p);
    const parents = git(["log", "-1", "--format=%P", p], { safe: true });
    if (parents.ok && parents.stdout) {
      for (const pp of parents.stdout.split(/\s+/).filter(Boolean)) stack.push(pp);
    }
  }
  return [...absorbed];
}

/**
 * Source→target SHA mapping from this pair's shadow branches from trailers: Shadow-replayed-<pair>-<sourceRemote>: <sourceSHA>
 */
function loadReplayedMappings(opts: {
  branches: string[];
  dc: DirectionConfig;
}): Map<string, string> {
  const { branches, dc } = opts;
  const candidateRefs = branches.map(b => `${dc.target.remote}/${shadowBranchName(dc.pair.name, b)}`);
  const shadowRefs = filterExistingRefs(candidateRefs);

  if (shadowRefs.length === 0) {
    return new Map();
  }
  const addKey = sourceTrailerKey(dc);
  return extractTrailerMapping(
    ["log", ...shadowRefs, `--grep=^${addKey}`],
    addKey,
  );
}

/**
 * Newest-first walk to each branch's most recent mapped ancestor. The branch
 * HEAD may be outer-only (didn't touch source.dir/), so we still advance the
 * shadow tip to the most recent commit inside the synced subdir.
 */
function mapBranchesToTargetTips(
  remote: string,
  branches: string[],
  shaMapping: Map<string, string>,
): Map<string, string> {
  const branchMapping = new Map<string, string>();
  for (const branch of branches) {
    const log = git(["log", "--first-parent", "--format=%H", `${remote}/${branch}`], { safe: true });
    if (!log.ok) {
      fail(`Failed to list commits for ${remote}/${branch}: ${log.stderr}`);
    }
    for (const line of log.stdout.split("\n")) {
      const hash = line.trim();
      if (!hash) continue;
      const replayed = shaMapping.get(hash);
      if (replayed) {
        branchMapping.set(branch, replayed);
        break;
      }
    }
  }
  return branchMapping;
}

/**
 * Return the bare branch name on `sourceRemote` containing `commitHash` if
 * unambiguous, else null. Used to point error messages at the right shadow ref.
 */
function inferSourceBranch(commitHash: string, sourceRemote: string): string | null {
  const res = git(
    ["for-each-ref", "--format=%(refname:short)", "--contains", commitHash, `refs/remotes/${sourceRemote}/`],
    { safe: true },
  );
  if (!res.ok || !res.stdout) return null;
  const matches = res.stdout.split("\n")
    .map(l => l.trim())
    .filter(Boolean)
    .map(r => r.startsWith(`${sourceRemote}/`) ? r.slice(sourceRemote.length + 1) : r)
    .filter(b => b && b !== "HEAD");
  return matches.length === 1 ? matches[0] : null;
}

/**
 * The single halt diagnostic printed when composeMergeBaseTree gives up. Every
 * reason shares a header (commit, failure, mapped parents) and the hand-built
 * escape hatch — a commit on the shadow ref carrying the source→target trailer,
 * which loadReplayedMappings treats as already-replayed on the next run.
 * `outer-divergence` (a real merge whose mapped parents disagree on outer state)
 * additionally gets the full round-trip recovery recipe; the rarer structural
 * failures stop at the escape hatch (so a single-parent echo failure no longer
 * prints a nonsensical "octopus merge" recipe).
 */
function formatHaltDiagnostic(opts: {
  commit: TopoCommit;
  meta: CommitMeta;
  mappedParents: string[];
  dc: DirectionConfig;
  reason: ComposeHaltKind;
}): string {
  const { commit, meta, mappedParents, dc, reason } = opts;
  const { target, pair } = dc;
  const branchLabel = inferSourceBranch(commit.hash, dc.source.remote) ?? "<source-branch>";
  const shadowRef = `refs/heads/${shadowBranchName(pair.name, branchLabel)}`;
  const trailer = `${sourceTrailerKey(dc)}: ${commit.hash}`;
  const ppLines = mappedParents.map(p => `    ${p}`).join("\n");

  const failure =
    reason === "outer-divergence"
      ? (mappedParents.length === 2
          ? `merge-tree conflict between mapped parents on ${target.remote}`
          : `octopus merge with ${mappedParents.length} mapped parents on ${target.remote} (no auto-resolution)`)
    : reason === "multi-echo-disagreement"
      ? "multiple already-replayed (echo) parents disagree on outer state"
    : "a required parent tree or mapped subdirectory was absent during base-tree composition";

  // outer-divergence and multi-echo-disagreement are both outer-state
  // disagreements the operator resolves the same way (round-trip), so they
  // share the full recipe and the exact "cannot auto-resolve" headline the
  // recovery tests assert. Only missing-tree is structurally different.
  const structural = reason === "missing-tree";
  const lines: string[] = [
    structural
      ? `${meta.short}: cannot compose replay base tree — branch halted.`
      : `${meta.short}: cannot auto-resolve replay parent tree — branch halted.`,
    ``,
    `  ${structural ? "Source commit:  " : "Source merge:   "}${commit.hash}  (${meta.short})`,
    `  Failure:        ${failure}`,
    `  Mapped parents on ${target.remote}:`,
    ppLines,
    ``,
  ];

  if (structural) {
    lines.push(
      `Recovery: create a commit on ${shadowRef} with these mapped parents and a`,
      `tree you choose (resolved outer + merged inner), including this trailer in`,
      `its message body (exact text):`,
      ``,
      `        ${trailer}`,
      ``,
      `On the next sync run, ${meta.short} is picked up via that trailer and skipped.`,
    );
    return lines.join("\n");
  }

  const sourceScopeDirs = sourceDirsOf(dc).filter(d => d !== "");
  const targetScopeDirs = targetDirsOf(dc).filter(d => d !== "");
  const sourceScope = sourceScopeDirs.length > 0 ? sourceScopeDirs.map(d => `${d}/`).join(", ") : "<root>";
  const targetScope = targetScopeDirs.length > 0 ? targetScopeDirs.map(d => `${d}/`).join(", ") : "<root>";
  const shortHash = commit.hash.slice(0, 7);
  const parentArgs = mappedParents.map(p => `-p ${p}`).join(" ");

  lines.push(
    `  Mapped parents disagree on outer state (files outside ${targetScope}). ` +
      `The source commit's scope is ${sourceScope}, so it couldn't have authored this outer-state difference.`,
    ``,
    `Recovery — choose ONE:`,
    ``,
    `  (Recommended) Round-trip + squash.`,
    `    1. Resolve the merge on ${target.remote}'s working branch as you would`,
    `       normally — e.g. \`git checkout ${branchLabel} && git merge --no-ff <from-branch(es)>\`,`,
    `       resolve conflicts, commit (call this Mm), and push. For an octopus`,
    `       source merge with ≥3 mapped parents, merge the corresponding branches`,
    `       sequentially or as a single octopus on ${target.remote}.`,
    `    2. Run shadow-sync in the other direction so Mm is replayed onto`,
    `       ${dc.source.remote}'s shadow ref (\`shadow/${pair.name}/${branchLabel}\`).`,
    `    3. On ${dc.source.remote}, merge that shadow ref into the working branch`,
    `       (\`git merge origin/shadow/${pair.name}/${branchLabel}\`) and push.`,
    `    4. Re-run this sync. The engine absorbs ${meta.short} (and any`,
    `       descendants halted with it) into the resulting merge's replay`,
    `       automatically — no flags needed.`,
    ``,
    `  (Alternative) Hand-built resolution on the shadow ref. Create a commit`,
    `  on ${shadowRef} that`,
    `    - has the divergent mapped parents above as its git parents`,
    `    - has a tree you choose (the resolved outer state + the merged inner state)`,
    `    - includes this trailer in its message body (exact text):`,
    ``,
    `        ${trailer}`,
    ``,
    `  On the next sync run, ${meta.short} will be picked up via that trailer and skipped.`,
    ``,
    `  Suggested commands (run in this repo, with ${target.remote} fetched):`,
    `    git checkout -b manual-resolve-${shortHash} ${mappedParents[0]}`,
    `    git merge --no-ff ${mappedParents.slice(1).join(" ")}`,
    `    # resolve conflicts, stage the result, then:`,
    `    tree=$(git write-tree)`,
    `    new=$(git commit-tree $tree ${parentArgs} \\`,
    `        -m "Manual resolution of ${shortHash}" \\`,
    `        -m "${trailer}")`,
    `    git update-ref ${shadowRef} $new`,
    `    git push ${target.remote} ${shadowRef.replace(/^refs\/heads\//, "")}`,
    `  Then re-run shadow-sync.`,
  );
  return lines.join("\n");
}


// ── Halt branches ──────────────────────────────────────────────────────

/** Per-source-commit halt reason — surfaced to the CLI via mirrorHistory. */
export interface HaltedBranch {
  /** Source branch the halt was discovered on, or null if undetermined. */
  branch: string | null;
  commitSha: string;
  commitShort: string;
  mappedParents: string[];
  diagnostic: string;
}

interface HaltReason {
  anchorCommits: string[];
  diagnostic: string;
  commitShort: string;
}

interface ReplayHalts {
  haltedSources: Set<string>;
  haltReasons: Map<string, HaltReason>;
}

// True iff every source-side parent is halted AND unmapped — a commit with at
// least one mapped parent escapes propagation and proceeds to normal replay.
function isHaltPropagated(
  commit: TopoCommit,
  haltedSources: Set<string>,
  shaMapping: Map<string, string>,
): boolean {
  if (commit.parents.length === 0) return false;
  return commit.parents.every(p => haltedSources.has(p) && !shaMapping.has(p));
}

/**
 * Record the commit as halted and inherit its halted ancestors' halt reason.
 */
function markPropagatedHalt(
  commit: TopoCommit,
  meta: CommitMeta,
  haltedSources: Set<string>,
  haltReasons: Map<string, HaltReason>,
): void {
  haltedSources.add(commit.hash);
  const inheritedAnchorCommits: string[] = [];
  const seenAnchorCommits = new Set<string>();
  for (const p of commit.parents) {
    const reason = haltReasons.get(p);
    if (!reason) continue;
    for (const ac of reason.anchorCommits) {
      if (!seenAnchorCommits.has(ac)) { inheritedAnchorCommits.push(ac); seenAnchorCommits.add(ac); }
    }
  }
  if (inheritedAnchorCommits.length > 0) {
    haltReasons.set(commit.hash, { anchorCommits: inheritedAnchorCommits, diagnostic: "", commitShort: meta.short });
  }
  console.log(`  Skipping ${meta.short} (descended from halted ancestor).`);
}

/**
 * Record an original halt: neither compose function could produce a defensible
 * parent tree. mappedParents are stored as anchorCommits so that downstream
 * descendants (which escape the halt via a mapped parent) can substitute them
 * via resolveHaltAwareParents.
 */
function haltCommit(opts: {
  commit: TopoCommit;
  meta: CommitMeta;
  mappedParents: string[];
  dc: DirectionConfig;
  haltedSources: Set<string>;
  haltReasons: Map<string, HaltReason>;
  reason: ComposeHaltKind;
}): void {
  const { commit, meta, mappedParents, dc, haltedSources, haltReasons, reason } = opts;
  haltedSources.add(commit.hash);
  haltReasons.set(commit.hash, {
    anchorCommits: mappedParents,
    diagnostic: formatHaltDiagnostic({ commit, meta, mappedParents, dc, reason }),
    commitShort: meta.short,
  });
  const summary =
    reason === "outer-divergence" ? "outer-state divergence between mapped parents"
    : reason === "multi-echo-disagreement" ? "already-replayed parents disagree on outer state"
    : "a required parent tree or mapped subdirectory was absent";
  console.log(`  ⚠ Halted on ${meta.short}: ${summary}.`);
}


// ── Mirror orchestration ──────────────────────────────────────────────────────

/**
 * Replay newCommits in topo order, mutating `shaMapping` so each replayed
 * commit is visible to later parent resolution in the same batch.
 *
 * Halt semantics: when neither compose function produces a tree (caller
 * invokes `haltCommit`), the failing commit is added to `haltedSources`
 * — NOT to `shaMapping`. Subsequent commits whose source parents are ALL
 * halted+unmapped are halted in turn. A commit with at least one mapped
 * parent (e.g. the operator's round-trip merge `R_be` carrying `Mm` as the
 * second parent via the existing trailer mapping) replays normally; the
 * absorption step collects halted source ancestors reachable through its
 * parents and encodes them as extra `Shadow-replayed` trailers, so on the
 * next sync run `loadReplayedMappings` treats them as already replayed.
 */
function replayCommits(opts: {
  newCommits: TopoCommit[];
  shaMapping: Map<string, string>;
  targetInit: string | null;
  dc: DirectionConfig;
}): ReplayHalts {
  const { newCommits, shaMapping, targetInit, dc } = opts;
  const addKey = sourceTrailerKey(dc);
  const tmpIndex = path.join(
    os.tmpdir(),
    `shadow-replay-${process.pid}-${crypto.randomBytes(6).toString("hex")}`,
  );

  const haltedSources = new Set<string>();
  const haltReasons = new Map<string, HaltReason>();

  try {
    const total = newCommits.length;
    const verbose = total < PROGRESS_THRESHOLD;
    let idx = 0;
    for (const commit of newCommits) {
      idx++;
      if (!verbose) logDecileProgress("Replayed", idx, total);
      const meta = getCommitMeta(commit.hash);

      if (isHaltPropagated(commit, haltedSources, shaMapping)) {
        markPropagatedHalt(commit, meta, haltedSources, haltReasons);
        continue;
      }

      // Carries our own trailer → forwarded earlier and merged back; record only.
      const isEcho = hasTrailer(meta.trailers, addKey);

      if (verbose) {
        if (isEcho) {
          console.log(`  [${idx}/${total}] Skipping ${meta.short} (echo from other direction).`);
        } else {
          const label = commit.parents.length > 1
            ? `merge commit ${meta.short}`
            : commit.parents.length === 0
              ? `root commit ${meta.short}`
              : meta.short;
          console.log(`  [${idx}/${total}] Replaying ${label}...`);
        }
      }

      // Resolve parent from trailers or Halt anchors for squash fix
      const mappedParents = resolveHaltAwareParents(commit, shaMapping, targetInit, haltedSources, haltReasons);

      // Per-mapping ignore (self + auto + .shadowignore). Computed before the
      // base tree so composeMergeBaseTree can filter the round-trip source
      // splice — the one place fresh, unfiltered source enters the base.
      const shadowIgnoreBySourceIdx = dc.mappings.map((m, i) =>
        readShadowIgnorePatterns(commit.hash, m.source, dc.autoIgnoreBySourceIdx[i] ?? []));

      let parentTree: string | null;
      if (mappedParents.length === 0) {
        if (commit.parents.length !== 0) fail(`Non-root commit ${meta.short} has no resolvable parent tree.`);
        // Source root with no targetInit — buildReplayedTree handles null via read-tree --empty.
        parentTree = null;
      } else {
        const composed = composeMergeBaseTree({ commit, mappedParents, shaMapping, dc, shadowIgnoreBySourceIdx });
        if (isHalt(composed)) {
          // No compose path produced a defensible tree. Halt the branch (other
          // branches in this call keep flowing); the diagnostic surfaces via
          // mirrorHistory's return.
          haltCommit({ commit, meta, mappedParents, dc, haltedSources, haltReasons, reason: composed.halt });
          continue;
        }
        parentTree = composed;
      }

      const tree = buildReplayedTree({
        commitHash: commit.hash,
        sourceFirstParent: commit.parents[0] ?? null,
        dc,
        parentTree,
        tmpIndex,
        shadowIgnorePatternsBySourceIdx: shadowIgnoreBySourceIdx,
      });

      if (!tree) {
        if (verbose) console.log(`  Skipping ${meta.short} (source content missing).`);
        continue;
      }

      // Absorption: collect halted source ancestors reachable from this commit
      // through its source-side parents. They become additional Shadow-replayed
      // trailers so the next sync sees them as already mapped and skips them.
      const absorbed = collectAbsorbedHalted(commit, haltedSources, shaMapping);

      let msg = isEcho
        ? appendTrailer(stripReplayedTrailers(meta.message), `${addKey}: ${commit.hash}`)
        : appendTrailer(meta.message, `${addKey}: ${commit.hash}`);
      for (const sha of absorbed) {
        msg = appendTrailer(msg, `${addKey}: ${sha}`);
      }

      const parentArgs = mappedParents.flatMap(p => ["-p", p]);
      const newSHA = git(["commit-tree", tree, ...parentArgs, "-m", msg], {
        env: buildCommitEnv(meta),
      });

      shaMapping.set(commit.hash, newSHA);
      for (const sha of absorbed) {
        shaMapping.set(sha, newSHA);
        haltedSources.delete(sha);
        haltReasons.delete(sha);
      }
      if (absorbed.length > 0) {
        console.log(`  ✓ Replayed${isEcho ? " (recorded)" : ""}, absorbing ${absorbed.length} halted ancestor(s): ${absorbed.map(s => s.slice(0, 7)).join(", ")}.`);
      } else if (verbose) {
        console.log(isEcho ? "  ✓ Recorded." : "  ✓ Replayed.");
      }
    }
  } finally {
    fs.rmSync(tmpIndex, { force: true });
  }

  return { haltedSources, haltReasons };
}

/** Replay one side of a pair onto the other; `from` selects the source. */
export function mirrorHistory(opts: {
  pair: SyncPair;
  from: "a" | "b";
  branches: string[];
}): {
  mirrored: number;
  branchMapping: Map<string, string>;
  shaMapping: Map<string, string>;
  upToDate: boolean;
  haltedBranches: HaltedBranch[];
} {
  const { pair, from, branches } = opts;
  const dc = buildDirectionConfig(pair, from);

  console.log("Scanning history for already-replayed commits...");
  const shaMapping = loadReplayedMappings({ branches, dc });
  console.log(`Found ${shaMapping.size} previously replayed commit(s).`);

  const sourceCommits = collectSourceCommits(dc, branches);
  const alreadyReplayed = new Set(shaMapping.keys());
  console.log(`Scanning ${sourceCommits.length} source commit(s) for load-bearing changes (skipping ${alreadyReplayed.size} already replayed)...`);
  const relevantCommits = filterLoadBearingCommits(sourceCommits, dc, alreadyReplayed);
  console.log(`${relevantCommits.length} new load-bearing commit(s).`);
  const newCommits = filterNotReplayedCommits(relevantCommits, shaMapping, dc);
  const usefulNewCommits = dropOrphanedCommits(newCommits, branches, shaMapping, dc.source.remote, sourceCommits);

  if (usefulNewCommits.length === 0) {
    return {
      mirrored: 0,
      branchMapping: mapBranchesToTargetTips(dc.source.remote, branches, shaMapping),
      shaMapping,
      upToDate: true,
      haltedBranches: [],
    };
  }

  console.log(`Found ${usefulNewCommits.length} new commit(s) to replay.\n`);

  // Fallback root for orphan parents (see resolveTargetParents).
  const anchorBranch = dc.target.anchorBranch ?? "main";
  let targetInit: string | null = null;
  if (refExists(`${dc.target.remote}/${anchorBranch}`)) {
    const initRes = git(["log", "--max-parents=0", "--format=%H", `${dc.target.remote}/${anchorBranch}`], { safe: true });
    if (!initRes.ok) {
      fail(`Failed to find init commit on ${dc.target.remote}/${anchorBranch}: ${initRes.stderr}`);
    }
    targetInit = initRes.stdout.split("\n")[0] || null;
  }

  const { haltedSources, haltReasons } = replayCommits({ newCommits: usefulNewCommits, shaMapping, targetInit, dc });

  // Only surface ORIGINAL halts (non-empty diagnostic). Propagated halts
  // (descendants that inherited halt-state) carry an empty diagnostic — they're
  // present in haltReasons only so resolveHaltAwareParents can splice in the
  // halt-causer's mapped parents.
  const haltedBranches: HaltedBranch[] = [];
  for (const [sha, reason] of haltReasons) {
    if (!reason.diagnostic) continue;
    haltedBranches.push({
      branch: inferSourceBranch(sha, dc.source.remote),
      commitSha: sha,
      commitShort: reason.commitShort,
      mappedParents: reason.anchorCommits,
      diagnostic: reason.diagnostic,
    });
  }

  console.log();
  const replayedCount = usefulNewCommits.length - haltedSources.size;
  if (haltedBranches.length > 0) {
    console.log(`Done. ${replayedCount} commit(s) replayed; ${haltedBranches.length} halt(s) (${haltedSources.size} commit(s) blocked).`);
  } else {
    console.log(`Done. ${usefulNewCommits.length} commit(s) replayed.`);
  }

  return {
    mirrored: replayedCount,
    branchMapping: mapBranchesToTargetTips(dc.source.remote, branches, shaMapping),
    shaMapping,
    upToDate: false,
    haltedBranches,
  };
}

// ── Tag sync ──────────────────────────────────────────────────────────────────

/**
 * Source repo's tags are recreated on target, repointed at the replayed
 * commit. Annotated tags get a fresh tag object (same name, tagger, message;
 * new `object` line). Lightweight tags become `refs/tags/<name>` pointing
 * directly at the replay. Tags whose source commit was dropped (no entry in
 * shaMapping) are skipped — there's no target SHA to point at.
 */
export function syncTags(opts: {
  source: RepoEndpoint;
  target: RepoEndpoint;
  shaMapping: Map<string, string>;
}): { pushed: number; skipped: number; upToDate: number } {
  const { source, target, shaMapping } = opts;

  git(["fetch", source.remote, "--tags"], { safe: true });

  // %(*objectname) dereferences an annotated tag to its commit (empty for
  // lightweight, where %(objectname) is already the commit). Peeling here
  // avoids a `git rev-parse` spawn per tag — the real cost when thousands of
  // tags point at commits not yet replayed.
  const listRes = git(
    ["for-each-ref", "refs/tags", "--format=%(refname:short)|%(objecttype)|%(objectname)|%(*objectname)"],
    { safe: true },
  );
  if (!listRes.ok || !listRes.stdout) return { pushed: 0, skipped: 0, upToDate: 0 };
  const tagLines = listRes.stdout.split("\n").filter(Boolean);
  if (tagLines.length === 0) return { pushed: 0, skipped: 0, upToDate: 0 };

  console.log(`\n── Syncing tags (${tagLines.length} candidate(s)) ──`);

  // Live snapshot of the target's current tags so we skip ones already correct
  // instead of re-force-pushing every tag each run. Must be ls-remote (the
  // target's real state): the local refs/tags/* are the SOURCE tags fetched
  // above into the same namespace, so comparing against them would be wrong.
  const remoteTags = new Map<string, string>();
  const lr = git(["ls-remote", "--tags", target.remote], { safe: true });
  if (lr.ok) {
    for (const l of lr.stdout.split("\n")) {
      const [sha, ref] = l.split("\t");
      if (ref && ref.startsWith("refs/tags/") && !ref.endsWith("^{}")) {
        remoteTags.set(ref.slice("refs/tags/".length), sha);
      }
    }
  }

  let pushed = 0;
  let skipped = 0;
  let upToDate = 0;
  for (const line of tagLines) {
    // name | objecttype | objectname | *objectname(peeled commit, blank if lightweight)
    // name/type can't contain '|'; the trailing two fields are hex/blank.
    const sep1 = line.indexOf("|");
    const sep2 = line.indexOf("|", sep1 + 1);
    const sep3 = line.indexOf("|", sep2 + 1);
    const name = line.slice(0, sep1);
    const objectType = line.slice(sep1 + 1, sep2);
    const objectName = line.slice(sep2 + 1, sep3);
    const peeledCommit = line.slice(sep3 + 1);
    const sourceCommit = peeledCommit || objectName;  // commit for both kinds; no spawn
    if (!sourceCommit) { skipped++; continue; }

    const targetCommit = shaMapping.get(sourceCommit);
    if (!targetCommit) {
      // Common and expected (tags on commits not yet merged into the synced
      // branch). Count, don't log per-tag — there can be thousands.
      skipped++;
      continue;
    }

    let pushSHA: string;
    if (objectType === "tag") {
      // Annotated: rebuild tag object with new commit-target.
      const tagBodyRes = git(["cat-file", "tag", `refs/tags/${name}`], { safe: true });
      if (!tagBodyRes.ok || !tagBodyRes.stdout) { skipped++; continue; }
      const newBody = tagBodyRes.stdout.replace(/^object [0-9a-f]+/m, `object ${targetCommit}`);
      const mktagRes = git(["mktag"], { input: newBody, safe: true });
      if (!mktagRes.ok || !mktagRes.stdout) {
        console.log(`  ${name}: mktag failed (${mktagRes.stderr.slice(0, 120)}), skipping`);
        skipped++;
        continue;
      }
      pushSHA = mktagRes.stdout;
    } else {
      pushSHA = targetCommit;
    }

    // Already correct on the target (byte-identical tag object / same commit) —
    // nothing to do. pushSHA fingerprints the whole tag, so a re-annotation
    // (same commit, new message/tagger) still differs and falls through.
    if (remoteTags.get(name) === pushSHA) {
      upToDate++;
      continue;
    }

    // Force-push: source is the source of truth for tags, so target may need
    // to overwrite a previous propagation if the source moved the tag.
    const pushRes = git(
      ["push", target.remote, `+${pushSHA}:refs/tags/${name}`],
      { safe: true },
    );
    if (!pushRes.ok) {
      console.log(`  ${name}: push failed (${pushRes.stderr.trim().slice(0, 120)}), skipping`);
      skipped++;
      continue;
    }
    console.log(`  ${name}${objectType === "tag" ? " (annotated)" : ""}: ${sourceCommit.slice(0, 8)} → ${targetCommit.slice(0, 8)} ✓`);
    pushed++;
  }

  console.log(`Tags: ${pushed} pushed, ${upToDate} up to date, ${skipped} skipped (source commit not replayed).`);
  return { pushed, skipped, upToDate };
}
