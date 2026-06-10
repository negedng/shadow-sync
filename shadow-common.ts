import { spawnSync } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ── Glossary ──────────────────────────────────────────────────────────────────
// pair          Two repo endpoints (a/b) + dir mappings; direction chosen via --from.
// dc            DirectionConfig — a pair resolved into source→target for one run.
// replay        Re-creating a source commit on the target with remapped paths.
// trailer       `Shadow-replayed-<pair>-<remote>: <sha>` commit footer. The
//               persistent source→target mapping: no state file, history IS the state.
// shadow ref    shadow/<pair>/<branch> on the target remote — the replayed line
//               the target merges from.
// echo          A source commit that is itself a replay from the target side;
//               recorded, never re-replayed (prevents ping-pong duplication).
// load-bearing  A commit whose mapped+filtered diff changes synced content (or a
//               merge anchoring such commits). Everything else is dropped.
// settled       Scanned in a prior run; verdict is immutable, so re-scans skip it.
// halt          Replay gave up (e.g. mapped parents disagree on outer state). The
//               branch stops there; the operator resolves; later runs absorb it.
// inner/outer   Tree regions inside / outside the mapped target dirs.
// splice        Composing a tree by inserting mapped subtree slices into a base.
//
// Deep dive with worked examples: shadow-sync-explained.html.

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
  /** mappings sorted by source-prefix length desc (longest prefix owns a path),
   *  carrying each mapping's original idx. */
  mappingsByDepth: Array<DirMappingDirected & { idx: number }>;
  /** Per-mapping ignores stripping content owned by a sibling mapping nested
   *  under this one's source/target dir. Indexed by mapping idx. */
  autoIgnoreBySourceIdx: RegExp[][];
  autoIgnoreByTargetIdx: RegExp[][];
}

// Patterns stripping `innerPath/...` from a tree rooted at `outerPath`, or
// null if inner is not nested under outer.
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

// A mapping's slice excludes content owned by sibling mappings nested under it
// (e.g. primary at "" with a sibling at "src/common").
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
  const mappingsByDepth = mappings.map((m, idx) => ({ ...m, idx }))
    .sort((a, b) => b.source.length - a.source.length);
  const autoByMapping = computeAutoIgnorePatterns(pair);
  const autoIgnoreBySourceIdx = autoByMapping.map(p => from === "a" ? p.a : p.b);
  const autoIgnoreByTargetIdx = autoByMapping.map(p => from === "a" ? p.b : p.a);
  return { pair, source, target, mappings, mappingsByDepth, autoIgnoreBySourceIdx, autoIgnoreByTargetIdx };
}

/**
 * Route a source file path through the pair's mappings: the longest-source-
 * prefix mapping owns it, and its ignore patterns apply source-relative.
 * Returns the mapped target path, or null (no owning mapping / ignored).
 */
function routeSourcePath(
  filePath: string,
  dc: DirectionConfig,
  ignoreBySrcIdx: RegExp[][],
): string | null {
  const owner = dc.mappingsByDepth.find(m =>
    m.source === "" || filePath === m.source || filePath.startsWith(`${m.source}/`));
  if (!owner) return null;
  const srcRelative = owner.source ? filePath.slice(owner.source.length + 1) : filePath;
  if ((ignoreBySrcIdx[owner.idx] ?? []).some(p => p.test(srcRelative))) return null;
  return owner.target ? `${owner.target}/${srcRelative}` : srcRelative;
}

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
    validateMappingDir(pair.name, m.a);
    validateMappingDir(pair.name, m.b);
    if (aDirs.has(m.a)) fail(`pair "${pair.name}" has duplicate a-dir "${m.a}"`);
    if (bDirs.has(m.b)) fail(`pair "${pair.name}" has duplicate b-dir "${m.b}"`);
    aDirs.add(m.a);
    bDirs.add(m.b);
  }
}

// All prefix matching and git pathspecs use forward slashes with no leading/
// trailing slash; anything else silently matches nothing, so reject it here.
function validateMappingDir(pairName: string, dir: string): void {
  if (dir === "") return;
  if (dir.includes("\\")) fail(`pair "${pairName}" mapping dir "${dir}" must use forward slashes`);
  if (dir.startsWith("/") || dir.endsWith("/")) fail(`pair "${pairName}" mapping dir "${dir}" must not have leading/trailing slashes`);
  if (dir.split("/").includes("..")) fail(`pair "${pairName}" mapping dir "${dir}" must not contain '..'`);
}

export class ShadowSyncError extends Error {
  constructor(msg: string) { super(msg); this.name = "ShadowSyncError"; }
}

export const CONFIG_PATH = process.env.SHADOW_CONFIG ?? path.join(__dirname, "shadow-config.json");

function parseJsonFile<T>(filePath: string): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch (e: any) {
    fail(`Failed to parse ${filePath}: ${e.message}`);
  }
}

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

  const doc = parseJsonFile<Record<string, unknown>>(CONFIG_PATH);

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
const _repoRootProbe = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
if (_repoRootProbe.error || !_repoRootProbe.stdout) {
  fail(`Cannot determine repo root (is git installed and cwd inside a repo?): ${_repoRootProbe.error?.message ?? (_repoRootProbe.stderr ?? "").trim()}`);
}
let _repoRoot = _repoRootProbe.stdout.trim();

/** Git config overrides for cross-OS consistency. */
const GIT_CONFIG_OVERRIDES = Object.entries(config.gitConfigOverrides).flatMap(
  ([key, value]) => ["-c", `${key}=${value}`],
);

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


// Log "<label>: P% (i/total)" each time i crosses a 10% boundary — for long
// phases (>100 items) where per-item logging would be noise.
const PROGRESS_THRESHOLD = 100;
function logDecileProgress(label: string, i: number, total: number): void {
  const step = Math.ceil(total / 10);
  if (step > 0 && (i % step === 0 || i === total)) {
    console.log(`  ${label}: ${Math.round((i / total) * 100)}% (${i}/${total})`);
  }
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
  // Fail loud: an empty result here silently empties shaMapping downstream.
  if (!result.ok) fail(`for-each-ref failed: ${result.stderr}`);
  if (!result.stdout) return [];
  const existing = new Set(
    result.stdout.split("\n").filter(Boolean).map(l => l.replace(/^refs\/remotes\//, "")),
  );
  return refs.filter(r => existing.has(r));
}


/** Which of `shas` resolve to a present object — one `cat-file --batch-check`
 *  instead of a `rev-parse` spawn per sha. */
function batchObjectsExist(shas: string[]): Set<string> {
  const present = new Set<string>();
  const uniq = [...new Set(shas)].filter(Boolean);
  if (uniq.length === 0) return present;
  const res = git(["cat-file", "--batch-check"], { input: uniq.join("\n") + "\n", safe: true, raw: true });
  if (!res.ok) return present;
  for (const line of res.stdout.split("\n")) {
    const sp = line.indexOf(" ");
    if (sp < 0) continue;
    // "<sha> <type> <size>" for present; "<sha> missing" for absent.
    if (line.slice(sp + 1).startsWith("missing")) continue;
    present.add(line.slice(0, sp));
  }
  return present;
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

/** One A/M/D/T record from `diff-tree -r -z` (no -M/-C, so single-path records). */
interface DiffEntry { newMode: string; newHash: string; status: string; filePath: string }

// Parse `-z` records: ":<modes> <shas> <status>\0<path>\0". -z is load-bearing:
// it emits paths verbatim, where the default core.quotepath C-quotes paths with
// non-ASCII/special characters — breaking mapping prefix matches and silently
// dropping those files from the replay.
function parseDiffTreeZ(out: string): DiffEntry[] {
  const entries: DiffEntry[] = [];
  const tokens = out.split("\0");
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const m = tokens[i].match(/^:\d+ (\d+) [0-9a-f]+ ([0-9a-f]+) ([AMDT])$/);
    if (!m) continue;
    entries.push({ newMode: m[1], newHash: m[2], status: m[3], filePath: tokens[i + 1] });
  }
  return entries;
}

/** diff-tree -r -z between two commits, restricted to the synced dirs.
 *  With a "" source the whole tree is in scope, so the pathspec is skipped
 *  (it would exclude siblings of more-specific sources). */
function diffSyncedDirs(parent: string, commit: string, dc: DirectionConfig):
  { ok: boolean; stderr: string; entries: DiffEntry[] } {
  const args = ["diff-tree", "-r", "-z", parent, commit];
  if (!anyRootSource(dc)) args.push("--", ...sourceDirsOf(dc).map(d => `${d}/`));
  const res = git(args, { safe: true, raw: true });
  return { ok: res.ok, stderr: res.stderr, entries: res.ok ? parseDiffTreeZ(res.stdout) : [] };
}

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

/** Stage `removals` (mode-0 lines) and `additions` ("<mode> <sha>\t<path>"
 *  lines) in one `update-index --index-info` over stdin — argv-based `git rm`
 *  overflows CreateProcess on Windows for large file lists. */
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
  // -z: NUL-terminated records, paths taken verbatim (no C-unquoting).
  git(["update-index", "-z", "--index-info"], { env: idxEnv, input: lines.join("\0") + "\0" });
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

let _emptyTreeSha: string | null = null;
function emptyTreeSha(): string {
  if (_emptyTreeSha === null) _emptyTreeSha = git(["mktree"], { input: "" });
  return _emptyTreeSha;
}

// ── Trailer machinery ─────────────────────────────────────────────────────────

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sanitizeTrailerToken(s: string): string {
  return s.replace(/[^A-Za-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

// Pair name included so two pairs sharing a source remote get distinct
// trailers — otherwise cross-pair merges pollute shaMapping with the sibling
// pair's (wrong-shape) replays.
function replayedTrailerKey(pairName: string, remote: string): string {
  return `${REPLAYED_TRAILER}-${sanitizeTrailerToken(`${pairName}-${remote}`)}`;
}

// The trailer this direction WRITES onto target commits.
function sourceTrailerKey(dc: DirectionConfig): string {
  return replayedTrailerKey(dc.pair.name, dc.source.remote);
}

// The opposite direction's trailer — on a source commit it marks an echo.
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
  // Fail loud: treating a failed log as "nothing replayed yet" would re-replay
  // the whole history and diverge from any hand-built halt resolution.
  if (!result.ok) fail(`Failed to read replay trailers (git log): ${result.stderr}`);
  if (!result.stdout) return mapping;
  for (const line of result.stdout.split("\n")) {
    const parts = line.split(/\s+/).filter(Boolean);
    if (parts.length < 2) continue;
    const targetHash = parts[0];
    for (const src of parts.slice(1)) {
      // Log is newest-first; first occurrence (newest replay) wins.
      if (/^[0-9a-f]{7,40}$/.test(src) && !mapping.has(src)) mapping.set(src, targetHash);
    }
  }
  return mapping;
}


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

// The hash of the existing commit this one is a copy of, read from the first
// matching replay trailer in its footer — or null if it carries no such trailer.
function matchOriginalHash(commitTrailers: string, dcTrailerRe: RegExp): string | null {
  const match = commitTrailers.split("\n").map(l => l.match(dcTrailerRe)).find(m => m);
  return match ? match[1] : null;
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
    const tree = git(["ls-tree", "-r", "--name-only", "-z", ref], { safe: true, raw: true });
    if (tree.ok && tree.stdout) {
      const lower = new Map<string, string>();
      for (const filePath of tree.stdout.split("\0").filter(Boolean)) {
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

// Small LRU: the echo check re-reads each commit's parents, which on a linear
// chain are the previous iterations' commits — recency captures nearly all hits.
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


// ── Source graph ─────────────────────────────────────────────────────────────
// In-memory commit graph, built once per direction from two batched git calls;
// the whole scan reads it instead of spawning a `git log` per commit.
interface SourceGraph {
  parents: Map<string, string[]>;
  index: Map<string, number>;     // topo position, 0 = newest; a commit's parents have larger index
  syncTouched: Set<string>;       // commits whose own diff touched the synced dirs (ignore-blind)
}

function collectSourceGraph(dc: DirectionConfig, branches: string[]): SourceGraph {
  const refs = branches.map(b => `${dc.source.remote}/${b}`);
  // Call 1: the whole reachable graph in topo order with parent edges.
  const g = git(["rev-list", "--topo-order", "--parents", ...refs], { safe: true });
  if (!g.ok) fail(`rev-list --parents failed: ${g.stderr}`);
  const parents = new Map<string, string[]>();
  const index = new Map<string, number>();
  let i = 0;
  for (const line of g.stdout.split("\n")) {
    if (!line) continue;
    const parts = line.split(" ");
    parents.set(parts[0], parts.slice(1));
    index.set(parts[0], i++);
  }
  // Call 2: commits whose own diff touched the synced dirs. With a root source
  // there is no pathspec, so every commit is in scope.
  const syncTouched = new Set<string>();
  if (dc.mappings.length > 0 && !anyRootSource(dc)) {
    const t = git(["log", "--full-history", "--format=%H", ...refs, "--", ...sourceDirsOf(dc).map(d => `${d}/`)], { safe: true });
    if (!t.ok) fail(`log --full-history (sync-touched) failed: ${t.stderr}`);
    for (const h of t.stdout.split("\n")) if (h) syncTouched.add(h);
  } else {
    for (const h of index.keys()) syncTouched.add(h);
  }
  return { parents, index, syncTouched };
}

// A commit's true parents from the loaded graph, with a defensive `git log %P`
// fallback for any hash outside it.
function graphParentsOf(graph: SourceGraph, hash: string): string[] {
  const fromGraph = graph.parents.get(hash);
  if (fromGraph) return fromGraph;
  const res = git(["log", "-1", "--format=%P", hash], { safe: true });
  if (!res.ok) fail(`log -1 --format=%P ${hash} failed: ${res.stderr}`);
  return res.stdout ? res.stdout.split(/\s+/).filter(Boolean) : [];
}

// The scan list: {sync-touched commits} ∪ {all merges} — equivalent to
// `git log --full-history --parents -- <dirs>` (verified). Emitted oldest-first
// so the scan sees ancestors before descendants.
function deriveSourceCommits(g: SourceGraph): TopoCommit[] {
  const out: TopoCommit[] = [];
  const keys = [...g.parents.keys()];
  for (let i = keys.length - 1; i >= 0; i--) {
    const h = keys[i];
    const ps = g.parents.get(h)!;
    if (g.syncTouched.has(h) || ps.length >= 2) out.push({ hash: h, parents: ps });
  }
  return out;
}

// ── Replay-list filtering ───────────────────────────────────────────────────

// True iff the commit's diff vs `parent`, after mapping + ignore filtering,
// has any surviving path — i.e. it changes content that flows to the target.
function sliceChangedVsParent(
  parent: string,
  commit: string,
  dc: DirectionConfig,
  ignoreBySrc: RegExp[][],
): boolean {
  const diff = diffSyncedDirs(parent, commit, dc);
  if (!diff.ok) return true;  // fail closed: keep
  return diff.entries.some(e => routeSourcePath(e.filePath, dc, ignoreBySrc) !== null);
}

// Returns true iff `git log pi ^p1` contains any commit in keptSet —
// i.e., Pi contributes at least one kept commit not already reachable from P1.
function hasKeptExclusiveAncestor(pi: string, p1: string, keptSet: Set<string>): boolean {
  if (keptSet.size === 0) return false;
  const result = git(["log", "--format=%H", pi, `^${p1}`], { safe: true });
  // Fail closed (keep): dropping the merge on a failed log could orphan the
  // side branch's kept commits from the shadow tip. Same direction as
  // sliceChangedVsParent's failure path.
  if (!result.ok) return true;
  for (const line of result.stdout.split("\n")) {
    const h = line.trim();
    if (h && keptSet.has(h)) return true;
  }
  return false;
}

/**
 * Drop iff the commit's effective source tree (composed across all mappings)
 * matches the 1st parent's AND (for merges) every non-first parent's
 * exclusive ancestry above its merge-base with the 1st parent is empty of
 * kept commits. P1 is the trunk; any Pi (i>=1) contributing a kept commit
 * anchors the merge.
 */
function isLoadBearing(
  c: TopoCommit,
  dc: DirectionConfig,
  keptSet: Set<string>,
): boolean {
  if (c.parents.length === 0) return true;

  const p1 = c.parents[0];

  // A source slice missing at c or p1 (non-root dir not born yet, or just
  // vanished) always load-bears.
  for (const m of dc.mappings) {
    if (!slicePresent(c.hash, m.source) || !slicePresent(p1, m.source)) return true;
  }

  const ignoreBySrc = dc.mappings.map((m, i) =>
    readShadowIgnorePatterns(c.hash, m.source, dc.autoIgnoreBySourceIdx[i] ?? []));
  if (sliceChangedVsParent(p1, c.hash, dc, ignoreBySrc)) return true;

  if (c.parents.length === 1) return false;
  // Merge, treesame to P1: it anchors only if a non-first parent contributes a
  // kept commit exclusive of P1 (`git log pi ^p1` ∩ keptSet).
  for (let i = 1; i < c.parents.length; i++) {
    if (hasKeptExclusiveAncestor(c.parents[i], p1, keptSet)) return true;
  }
  return false;
}

function dropNonLoadBearingCommits(
  commits: TopoCommit[],
  dc: DirectionConfig,
  alreadySynced: Set<string>,
  alreadySettled: Set<string>,
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
    // An already-synced commit was load-bearing-kept in a prior run.
    if (alreadySynced.has(c.hash)) {
      keptSet.add(c.hash);
    } else if (alreadySettled.has(c.hash)) {
      // Reachable from a prior-run frontier and not mapped -> dropped in an earlier sync.
      continue;
    } else if (isLoadBearing(c, dc, keptSet)) {
      keptSet.add(c.hash);
      kept.push(c);
    }
    if (showProgress) logDecileProgress("Scanned", i, total);
  }
  return kept;
}

/**
 * Map echo commits (source → target SHA) so they count as already replayed.
 * Keyed on this pair's target-direction trailer only — a sibling pair's
 * trailer must NOT match, so cross-pair commits still replay.
 */
function addEchoMappings(
  sourceCommits: TopoCommit[],
  dc: DirectionConfig,
  shaMapping: Map<string, string>,
): void {
  const skipKey = targetTrailerKey(dc);
  const skipRe = targetTrailerRegex(dc);
  const pending = sourceCommits.filter(c => !shaMapping.has(c.hash)).map(c => c.hash);
  if (pending.length === 0) return;

  const trailersByHash = fetchTrailersBatch(pending);
  const candidates: Array<{ hash: string; target: string }> = [];
  for (const hash of pending) {
    const trailers = trailersByHash.get(hash) ?? "";
    if (!hasTrailer(trailers, skipKey)) continue;
    const target = matchOriginalHash(trailers, skipRe);
    if (target) candidates.push({ hash, target });
  }
  if (candidates.length === 0) return;

  const present = batchObjectsExist(candidates.map(c => c.target));
  for (const { hash, target } of candidates) {
    if (present.has(target)) shaMapping.set(hash, target);
  }
}

/**
 * Settled = everything reachable from the newest already-replayed commit on
 * each branch's first-parent line. Those verdicts are immutable (they depend
 * only on fixed trees/ancestor verdicts), so the scan skips re-deriving them.
 */
function computeSettledCommits(
  graph: SourceGraph,
  branches: string[],
  dc: DirectionConfig,
  shaMapping: Map<string, string>,
): Set<string> {
  const settled = new Set<string>();
  if (shaMapping.size === 0) return settled;

  const refs = branches.map(b => `refs/remotes/${dc.source.remote}/${b}`);
  const res = git(["for-each-ref", "--format=%(objectname)", ...refs], { safe: true });
  if (!res.ok || !res.stdout) return settled;
  const tips = res.stdout.split("\n").map(s => s.trim()).filter(Boolean);

  // Frontier per branch: first-parent walk to the newest mapped commit (if any).
  const frontier: string[] = [];
  for (const tip of tips) {
    let h: string | undefined = tip;
    while (h && !shaMapping.has(h)) h = graphParentsOf(graph, h)[0];
    if (h) frontier.push(h);
  }

  // Reachability must follow ALL parents — a dropped commit can sit on a
  // non-first-parent side branch below a mapped merge.
  const stack = [...frontier];
  while (stack.length) {
    const x = stack.pop()!;
    if (settled.has(x)) continue;
    settled.add(x);
    for (const p of graph.parents.get(x) ?? []) stack.push(p);
  }
  return settled;
}

// ── Ignore patterns ──────────────────────────────────────────────

// Always strip .shadowignore files themselves from the synced tree — they're
// source-side metadata for shadow-sync, never replayed onto the target.
const SHADOWIGNORE_SELF_RE = /^(?:.*\/)?\.shadowignore$/;

// Read .shadowignore files from sourceDir up to the repo root, at the commit's
// snapshot (patterns can evolve through history). `extraPatterns` (e.g. the
// auto-derived nested-mapping ignores) are prepended.
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
  const doc = parseJsonFile<BranchFilterDoc>(BRANCH_FILTERS_PATH);
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

  // sourceFirstParent null = source root, which lists as all-additions below.
  let entries: DiffEntry[];

  if (sourceFirstParent) {
    const diff = diffSyncedDirs(sourceFirstParent, commitHash, dc);
    if (!diff.ok) fail(`diff-tree failed for ${commitHash}: ${diff.stderr}`);
    entries = diff.entries;
  } else {
    // No parent to diff against — every ls-tree blob is an addition.
    const lsArgs = ["ls-tree", "-r", "-z", commitHash];
    if (!anyRootSource(dc)) lsArgs.push("--", ...sourceDirsOf(dc).map(d => `${d}/`));
    const lsResult = git(lsArgs, { safe: true, raw: true });
    if (!lsResult.ok || !lsResult.stdout) return null;
    entries = [];
    for (const rec of lsResult.stdout.split("\0")) {
      const tab = rec.indexOf("\t");
      const m = tab > 0 ? rec.slice(0, tab).match(/^(\d+) \w+ ([0-9a-f]+)$/) : null;
      if (m) entries.push({ newMode: m[1], newHash: m[2], status: "A", filePath: rec.slice(tab + 1) });
    }
  }

  if (entries.length === 0) return parentTree ?? null;

  // No -M/-C, so renames surface as D+A — we only handle A/M/D/T.
  const removals: string[] = [];
  const additions: string[] = [];   // "mode hash\tpath" lines for --index-info
  for (const e of entries) {
    const targetPath = routeSourcePath(e.filePath, dc, shadowIgnorePatternsBySourceIdx);
    if (targetPath === null) continue;

    if (e.status === "D") {
      removals.push(targetPath);
    } else {
      additions.push(`${e.newMode} ${e.newHash}\t${targetPath}`);
    }
  }

  applyIndexInfo(idxEnv, removals, additions);

  return git(["write-tree"], { env: idxEnv });
}

const NULL_SHA = "0".repeat(40);

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
    const ls = git(["ls-files", "-z"], { env: idxEnv, safe: true, raw: true });
    if (ls.ok && ls.stdout) {
      const toRemove = ls.stdout.split("\0").filter(Boolean)
        .filter(p => ignorePatterns.some(re => re.test(p)));
      // stdin-based delete (see applyIndexInfo) — avoids argv overflow on Windows.
      applyIndexInfo(idxEnv, toRemove, []);
    }
    return git(["write-tree"], { env: idxEnv });
  });
}

/** For each mapping, read `<fromHash>:<m[side]>` (auto-ignore filtered, so
 *  sibling-owned paths don't bleed in) and splice it into `base` at `m.target`.
 *  Returns null if a root slice fails to resolve — caller decides fallback vs halt. */
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
    // extraIgnoreByIdx = per-commit .shadowignore (round-trip source splice only).
    const patterns = extraIgnoreByIdx
      ? [...(autoPatterns[i] ?? []), ...(extraIgnoreByIdx[i] ?? [])]
      : (autoPatterns[i] ?? []);
    const filtered = filterTreeByIgnore(res.stdout, patterns);
    slices.push({ subdir: m.target, content: filtered });
  }
  return composeSubtrees(base, slices);
}


/** First mapped parent's full tree. Unreadable means repo corruption, not an
 *  operator-resolvable conflict — abort the run rather than halt one branch. */
function firstParentTree(mappedParents: string[], commitShort: string): string {
  const treeRes = git(["rev-parse", `${mappedParents[0]}^{tree}`], { safe: true });
  if (!treeRes.ok || !treeRes.stdout) fail(`Cannot read tree of mapped parent ${mappedParents[0]} for ${commitShort}.`);
  return treeRes.stdout;
}

/**
 * Reconcile the OUTER across ≥2 mapped parents (the caller splices the first
 * parent's inner over the result). 2 parents + clean merge-tree → auto-merged
 * outer; otherwise all parents must agree on outer — the source commit's scope
 * can't author an outer difference, so disagreement halts.
 */
function reconcileOuter(mappedParents: string[], dc: DirectionConfig): ComposeResult {
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
 * Echo splice: when a source parent already round-tripped, the base must carry
 * the target's outer state from that echo, not a frozen bootstrap snapshot.
 * Round-trip (the echo target is itself a mapped parent): splice the CURRENT
 * commit's source-side inner (the operator's resolution) over the echo'd outer;
 * otherwise splice the first parent's inner. Multi-echo outers must agree.
 */
function resolveEcho(
  commit: TopoCommit,
  mappedParents: string[],
  shaMapping: Map<string, string>,
  dc: DirectionConfig,
  shadowIgnoreBySourceIdx: RegExp[][],
): ComposeResult | "not-an-echo" {
  const skipKey = targetTrailerKey(dc);
  const echoTargets: string[] = [];
  for (const sourceParent of commit.parents) {
    const parentMeta = getCommitMeta(sourceParent);
    if (hasTrailer(parentMeta.trailers, skipKey)) {
      const mapped = shaMapping.get(sourceParent);
      if (mapped) echoTargets.push(mapped);
    }
  }
  if (echoTargets.length === 0) return "not-an-echo";

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
 * buildReplayedTree overlays diff(firstParent → commit) as an ABSOLUTE apply,
 * so the base must already equal the commit's content wherever that diff is
 * silent. The invariant: the base's inner is the FIRST PARENT's inner (any
 * other inner — e.g. auto-merged — silently survives where the diff is empty,
 * dropping resolutions that re-assert the first parent), and cross-repo the
 * outer is the reconciled outer. The lone exception is an echo round-trip,
 * where the inner is the commit's own resolved source (resolveEcho).
 */
function composeMergeBaseTree(opts: {
  commit: TopoCommit;
  mappedParents: string[];
  shaMapping: Map<string, string>;
  dc: DirectionConfig;
  shadowIgnoreBySourceIdx: RegExp[][];
}): ComposeResult {
  const { commit, mappedParents, shaMapping, dc, shadowIgnoreBySourceIdx } = opts;
  const commitShort = commit.hash.slice(0, 8);
  const confined = allTargetsConfined(dc);

  // Echo splice runs first, regardless of confinement: an unmapped source
  // parent resolves to targetInit, whose stale outer would otherwise leak
  // through the first-parent shortcuts below verbatim.
  const echo = resolveEcho(commit, mappedParents, shaMapping, dc, shadowIgnoreBySourceIdx);
  if (echo !== "not-an-echo") return echo;

  // 1 parent: outer can't have diverged; inner is that parent's. (fast path)
  if (mappedParents.length === 1) return { tree: firstParentTree(mappedParents, commitShort) };

  // Same-repo: the synced region is the whole tree, so the first parent's tree
  // is the correct base verbatim.
  if (!confined) return { tree: firstParentTree(mappedParents, commitShort) };

  // Cross-repo, ≥2 parents: reconcile the outer, splice first parent's inner.
  const outer = reconcileOuter(mappedParents, dc);
  if (isHalt(outer)) return outer;
  const spliced = spliceMappings(outer.tree, mappedParents[0], "target", dc);
  return spliced === null ? { halt: "missing-tree" } : { tree: spliced };
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
  haltRecords: Map<string, HaltRecord>,
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
    const haltAnchors = haltedSources.has(parentHash)
      ? haltRecords.get(parentHash)?.anchorCommits
      : undefined;
    if (shaMapping.has(parentHash)) {
      pushUnique(shaMapping.get(parentHash));
    } else if (haltAnchors && haltAnchors.length > 0) {
      for (const ac of haltAnchors) pushUnique(ac);
    } else {
      // not mapped, and either not halted or halted without anchors
      pushUnique(findEchoAnchor(parentHash, shaMapping) ?? targetInit);
    }
  }
  return parents;
}

/**
 * Halted unmapped ancestors reachable through the commit's parents — encoded
 * as extra trailers on its replay so later runs treat them as replayed.
 */
function collectAbsorbedHalted(
  commit: TopoCommit,
  haltedSources: Set<string>,
  shaMapping: Map<string, string>,
  graph: SourceGraph,
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
    for (const pp of graphParentsOf(graph, p)) stack.push(pp);
  }
  return [...absorbed];
}

/**
 * Source→target SHA mapping from this pair's shadow branches from trailers: Shadow-replayed-<pair>-<sourceRemote>: <sourceSHA>
 * Origin: other side, replayed here.
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

/** Each branch's shadow tip: the newest mapped commit on its first-parent line
 *  (the branch HEAD itself may be outer-only and unmapped). */
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
 * Operator diagnostic for a halt. All causes share the header and the
 * hand-built trailer escape hatch; outer-state disagreements additionally get
 * the full round-trip recovery recipe.
 */
function formatHaltDiagnostic(opts: {
  commit: TopoCommit;
  meta: CommitMeta;
  mappedParents: string[];
  dc: DirectionConfig;
  cause: ComposeHaltCause;
}): string {
  const { commit, meta, mappedParents, dc, cause } = opts;
  const { target, pair } = dc;
  const branchLabel = inferSourceBranch(commit.hash, dc.source.remote) ?? "<source-branch>";
  const shadowRef = `refs/heads/${shadowBranchName(pair.name, branchLabel)}`;
  const trailer = `${sourceTrailerKey(dc)}: ${commit.hash}`;
  const ppLines = mappedParents.map(p => `    ${p}`).join("\n");

  const failure =
    cause === "outer-divergence"
      ? (mappedParents.length === 2
        ? `merge-tree conflict between mapped parents on ${target.remote}`
        : `octopus merge with ${mappedParents.length} mapped parents on ${target.remote} (no auto-resolution)`)
      : cause === "multi-echo-disagreement"
        ? "multiple already-replayed (echo) parents disagree on outer state"
        : "a required parent tree or mapped subdirectory was absent during base-tree composition";

  // outer-divergence and multi-echo-disagreement are both outer-state
  // disagreements the operator resolves the same way (round-trip), so they
  // share the full recipe and the exact "cannot auto-resolve" headline the
  // recovery tests assert. Only missing-tree is structurally different.
  const structural = cause === "missing-tree";
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

interface HaltRecord {
  anchorCommits: string[];
  diagnostic: string;
  commitShort: string;
}

interface ReplayHalts {
  haltedSources: Set<string>;
  haltRecords: Map<string, HaltRecord>;
}

/**
 * Halt causes (select the operator diagnostic in formatHaltDiagnostic):
 *   outer-divergence        — mapped parents of a real merge disagree on outer.
 *   multi-echo-disagreement — several echo parents disagree on outer.
 *   missing-tree            — a required parent tree or mapped subdir was absent.
 */
type ComposeHaltCause = "outer-divergence" | "multi-echo-disagreement" | "missing-tree";
interface ComposeHalt { halt: ComposeHaltCause; }
type ComposeResult = { tree: string } | ComposeHalt;

function isHalt(r: ComposeResult): r is ComposeHalt {
  return "halt" in r;
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
  haltRecords: Map<string, HaltRecord>,
): void {
  haltedSources.add(commit.hash);
  const inheritedAnchorCommits: string[] = [];
  const seenAnchorCommits = new Set<string>();
  for (const p of commit.parents) {
    const record = haltRecords.get(p);
    if (!record) continue;
    for (const ac of record.anchorCommits) {
      if (!seenAnchorCommits.has(ac)) { inheritedAnchorCommits.push(ac); seenAnchorCommits.add(ac); }
    }
  }
  if (inheritedAnchorCommits.length > 0) {
    haltRecords.set(commit.hash, { anchorCommits: inheritedAnchorCommits, diagnostic: "", commitShort: meta.short });
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
  haltRecords: Map<string, HaltRecord>;
  cause: ComposeHaltCause;
}): void {
  const { commit, meta, mappedParents, dc, haltedSources, haltRecords, cause } = opts;
  haltedSources.add(commit.hash);
  haltRecords.set(commit.hash, {
    anchorCommits: mappedParents,
    diagnostic: formatHaltDiagnostic({ commit, meta, mappedParents, dc, cause }),
    commitShort: meta.short,
  });
  const summary =
    cause === "outer-divergence" ? "outer-state divergence between mapped parents"
      : cause === "multi-echo-disagreement" ? "already-replayed parents disagree on outer state"
        : "a required parent tree or mapped subdirectory was absent";
  console.log(`  ⚠ Halted on ${meta.short}: ${summary}.`);
}


// ── Mirror orchestration ──────────────────────────────────────────────────────

/**
 * Replay newCommits in topo order, mutating `shaMapping` so each replay is
 * visible to later parent resolution in the same batch.
 *
 * Halt semantics: a halted commit goes into `haltedSources`, NOT `shaMapping`.
 * Commits whose parents are ALL halted+unmapped halt in turn; a commit with
 * at least one mapped parent replays normally and absorbs reachable halted
 * ancestors as extra trailers (already-replayed on the next run).
 */
function replayCommits(opts: {
  newCommits: TopoCommit[];
  shaMapping: Map<string, string>;
  targetInit: string | null;
  dc: DirectionConfig;
  graph: SourceGraph;
}): ReplayHalts {
  const { newCommits, shaMapping, targetInit, dc, graph } = opts;
  const addKey = sourceTrailerKey(dc);

  const haltedSources = new Set<string>();
  const haltRecords = new Map<string, HaltRecord>();

  withTmpIndex("replay", idxEnv => {
    const tmpIndex = idxEnv.GIT_INDEX_FILE;
    const total = newCommits.length;
    const verbose = total < PROGRESS_THRESHOLD;
    let idx = 0;
    for (const commit of newCommits) {
      idx++;
      if (!verbose) logDecileProgress("Replayed", idx, total);
      const meta = getCommitMeta(commit.hash);

      if (isHaltPropagated(commit, haltedSources, shaMapping)) {
        markPropagatedHalt(commit, meta, haltedSources, haltRecords);
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
      const mappedParents = resolveHaltAwareParents(commit, shaMapping, targetInit, haltedSources, haltRecords);

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
          haltCommit({ commit, meta, mappedParents, dc, haltedSources, haltRecords, cause: composed.halt });
          continue;
        }
        parentTree = composed.tree;
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

      const absorbed = collectAbsorbedHalted(commit, haltedSources, shaMapping, graph);

      let msg = isEcho
        ? appendTrailer(stripReplayedTrailers(meta.message), `${addKey}: ${commit.hash}`)
        : appendTrailer(meta.message, `${addKey}: ${commit.hash}`);
      for (const sha of absorbed) {
        msg = appendTrailer(msg, `${addKey}: ${sha}`);
      }

      const parentArgs = mappedParents.flatMap(p => ["-p", p]);
      // Message over stdin — a >32KB message as argv overflows CreateProcess on Windows.
      const newSHA = git(["commit-tree", tree, ...parentArgs], {
        env: buildCommitEnv(meta), input: msg,
      });

      shaMapping.set(commit.hash, newSHA);
      for (const sha of absorbed) {
        shaMapping.set(sha, newSHA);
        haltedSources.delete(sha);
        haltRecords.delete(sha);
      }
      if (absorbed.length > 0) {
        console.log(`  ✓ Replayed${isEcho ? " (recorded)" : ""}, absorbing ${absorbed.length} halted ancestor(s): ${absorbed.map(s => s.slice(0, 7)).join(", ")}.`);
      } else if (verbose) {
        console.log(isEcho ? "  ✓ Recorded." : "  ✓ Replayed.");
      }
    }
  });

  return { haltedSources, haltRecords };
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

// One in-memory source graph (two batched git calls)
  const graph = collectSourceGraph(dc, branches);
  const sourceCommits = deriveSourceCommits(graph);
  
  console.log("Scanning history for already-replayed commits...");
  // Synced: already replayed (source origin) + echo (target origin) with trailer
  const syncedShaMap = loadReplayedMappings({ branches, dc });
  console.log(`Found ${syncedShaMap.size} previously replayed commit(s).`);
  addEchoMappings(sourceCommits, dc, syncedShaMap);
  const syncedSourceHash = new Set(syncedShaMap.keys());
  // Commits a prior sync already settled (reachable from the per-branch frontier of newest-replayed commits). 
  const settledSourceHash = computeSettledCommits(graph, branches, dc, syncedShaMap);
  let newToScan = 0, settledDropped = 0;
  for (const c of sourceCommits) {
    if (syncedSourceHash.has(c.hash)) continue;
    if (settledSourceHash.has(c.hash)) settledDropped++; else newToScan++;
  }
  console.log(`Scanning ${newToScan} new source commit(s) since last replay for load-bearing changes (${sourceCommits.length} reachable; skipping ${syncedSourceHash.size} already replayed/echo, ${settledDropped} settled-dropped)...`);
  const newCommits = dropNonLoadBearingCommits(sourceCommits, dc, syncedSourceHash, settledSourceHash);
  console.log(`${newCommits.length} new load-bearing commit(s).`);

  if (newCommits.length === 0) {
    return {
      mirrored: 0,
      branchMapping: mapBranchesToTargetTips(dc.source.remote, branches, syncedShaMap),
      shaMapping: syncedShaMap,
      upToDate: true,
      haltedBranches: [],
    };
  }

  console.log(`Found ${newCommits.length} new commit(s) to replay.\n`);

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

  const { haltedSources, haltRecords } = replayCommits({ newCommits: newCommits, shaMapping: syncedShaMap, targetInit, dc, graph });

  // Only surface ORIGINAL halts; propagated ones carry an empty diagnostic.
  const haltedBranches: HaltedBranch[] = [];
  for (const [sha, record] of haltRecords) {
    if (!record.diagnostic) continue;
    haltedBranches.push({
      branch: inferSourceBranch(sha, dc.source.remote),
      commitSha: sha,
      commitShort: record.commitShort,
      mappedParents: record.anchorCommits,
      diagnostic: record.diagnostic,
    });
  }

  console.log();
  const replayedCount = newCommits.length - haltedSources.size;
  if (haltedBranches.length > 0) {
    console.log(`Done. ${replayedCount} commit(s) replayed; ${haltedBranches.length} halt(s) (${haltedSources.size} commit(s) blocked).`);
  } else {
    console.log(`Done. ${newCommits.length} commit(s) replayed.`);
  }

  return {
    mirrored: replayedCount,
    branchMapping: mapBranchesToTargetTips(dc.source.remote, branches, syncedShaMap),
    shaMapping: syncedShaMap,
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

  // --force: plain --tags refuses to move an existing local tag, so a source
  // re-tag would otherwise never propagate (and with multiple pairs fetching
  // into the shared refs/tags namespace, first-fetched would win forever).
  git(["fetch", source.remote, "--tags", "--force"], { safe: true });

  // %(*objectname) peels annotated tags to their commit (empty for lightweight)
  // — avoids a rev-parse spawn per tag.
  const listRes = git(
    ["for-each-ref", "refs/tags", "--format=%(refname:short)|%(objecttype)|%(objectname)|%(*objectname)"],
    { safe: true },
  );
  if (!listRes.ok || !listRes.stdout) return { pushed: 0, skipped: 0, upToDate: 0 };
  const tagLines = listRes.stdout.split("\n").filter(Boolean);
  if (tagLines.length === 0) return { pushed: 0, skipped: 0, upToDate: 0 };

  console.log(`\n── Syncing tags (${tagLines.length} candidate(s)) ──`);

  // Skip already-correct tags. Must be ls-remote: local refs/tags/* hold the
  // SOURCE tags fetched above, not the target's state.
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
    // name|objecttype|objectname|peeled-commit (blank if lightweight)
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
      // Expected (tag on an unreplayed commit); don't log — can be thousands.
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

    // pushSHA fingerprints the whole tag, so a re-annotation (same commit,
    // new message/tagger) still differs and falls through to the push.
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
