# Shadow Sync

Bi-directional git sync between two repositories with path prefix remapping. Commits are replayed individually to preserve authorship, timestamps, and history. Merge topology (branches, merge commits, shared ancestors) is preserved.

For a detailed technical deep dive, see [`shadow-sync-explained.html`](shadow-sync-explained.html).

## How it works

Given two repos — **RepoA** (has a `backend/` folder) and **RepoB** (backend at root):

```
RepoA                                    RepoB
backend/src/app.ts  ←──── sync ────→  src/app.ts
backend/README.md   ←──── sync ────→  README.md
other-stuff/...     (not synced)
```

Shadow sync replays commits between them, adding or stripping the `backend/` prefix as needed. Each side gets a `shadow/` branch that the other team merges.

```
shadow-sync --from b:  RepoB → shadow/backend/main on RepoA → git merge → RepoA's main
shadow-sync --from a:  RepoA → shadow/backend/main on RepoB → git merge → RepoB's main
```

### Where does the tool run?

The tool runs from a standalone orchestrator repo, independent of both synced repos. Both are added as remotes. Set `SHADOW_CONFIG` to point at your config.

```bash
npm install negedng/shadow-sync
cross-env SHADOW_CONFIG=./shadow-config.json npx tsx node_modules/shadow-sync/shadow-sync.ts
```

## Configuration

Create a `shadow-config.json` (copy from `shadow-config.example.json`):

```json
{
  "pairs": [
    {
      "name": "backend",
      "a": { "remote": "main-repo", "url": "https://github.com/org/monorepo.git", "dir": "backend" },
      "b": { "remote": "backend-repo", "url": "https://github.com/org/backend.git", "dir": "" }
    }
  ]
}
```

- `a` and `b` are symmetric — direction is chosen at runtime with `--from`
- `dir` is the path prefix in that repo (`""` for root, `"backend"` for a subdirectory)
- `url` tells the tool how to reach the repo

## Usage

One script, one command — direction is a flag:

```bash
# Pull: replay b's commits into shadow branches on a
npm run sync -- --from b

# Push: replay a's commits into shadow branches on b
npm run sync -- --from a

# Target a specific pair
npm run sync -- --from b -r backend

# Target a specific branch
npm run sync -- --from a -r backend -b feature/auth
```

After syncing, merge the shadow branch:
```bash
git fetch origin
git merge origin/shadow/backend/main
```

### When merge replay halts

In rare cases the engine can't auto-resolve a source-side merge because the mapped target-side parents disagree on **outer state** — files outside the synced subdirectory that don't exist on the source repo. This happens when both sides committed to the same branch concurrently and merged each other's work back at different times. The engine halts with a recipe rather than guessing.

Two recovery flows:

**B′ — engine-composed resolved merge (preferred).** Resolve the merge on the target's working branch, then re-run sync. The engine auto-detects your resolution and composes the right tree.

```bash
# 1. The sync failed on a merge (call it Bm). Switch to the target's working branch.
cd /path/to/monorepo
git checkout core-dev

# 2. Resolve the merge as you would normally. Suppose Bm merges project → core-dev:
git merge --no-ff project
# ... resolve conflicts, commit ...
git push origin core-dev

# 3. Re-run sync with the feature flag.
npm run sync -- --from b --allow-conflict-resolution-overwrite
```

The engine identifies your merge by shape — a 2-parent merge on the into-branch whose second parent is reachable from the from-branch — composes its outer with the source merge's inner, and writes the result to the shadow ref. No new trailers or operator-supplied SHAs needed in the common case.

If you made multiple unrelated merges on the target's into-branch and several pass the shape check, the engine errors with `ambiguous resolution candidates: <sha1>, <sha2>; rerun with --using <sha>`. Pick the right one:

```bash
npm run sync -- --from b --using <sha> --allow-conflict-resolution-overwrite
```

**A — hand-built resolution on the shadow ref (always available, no flag).** When you'd rather build the resolution directly without touching the target's working branch, follow the recipe the engine printed: create a commit on the shadow ref whose tree is your manual resolution, parents are the divergent mapped parents, and message carries `Shadow-replayed-<pair>-<source-remote>: <Bm-sha>`. Push that to the shadow ref and re-run sync. `loadReplayedMappings` picks up the trailer and skips Bm on the next run. This path works regardless of whether `--allow-conflict-resolution-overwrite` is set.

The full B′ design and a worked example are in [`local_tests/conflict_squash/`](local_tests/conflict_squash/) (`IMPLEMENTATION_PLAN.md` and `run_scenario.ts`).

### `.shadowignore`

Works like `.gitignore` — commit a `.shadowignore` file in your repo and it's automatically discovered during replay. Each side controls what it sends to the other.

Place `.shadowignore` at the root of the synced content:
- In RepoA (dir = `backend`): `backend/.shadowignore`
- In RepoB (dir = ``): `.shadowignore`

Example `.shadowignore`:
```
CLAUDE.md
.cursor/
**/*.local
```

## GitHub Actions

Both workflows in `.github/workflows/` are **reusable** (`workflow_call:`) so consumers don't duplicate them — they add a thin caller workflow and the logic stays here.

### Consumer setup (one-time)

Create these two files in the consumer repo:

**`.github/workflows/shadow-sync.yml`** — pull from B:

```yaml
name: Shadow Sync (Pull from B)
on:
  workflow_dispatch:
  # schedule: [{ cron: '*/15 * * * *' }]   # enable when ready
permissions:
  contents: write
jobs:
  sync:
    uses: negedng/shadow-sync/.github/workflows/shadow-sync.yml@main
    secrets: inherit
```

**`.github/workflows/shadow-forward.yml`** — push from A:

```yaml
name: Shadow Sync (Push from A)
on:
  workflow_dispatch:
  # schedule: [{ cron: '*/15 * * * *' }]   # enable when ready
permissions:
  contents: read
jobs:
  sync:
    uses: negedng/shadow-sync/.github/workflows/shadow-forward.yml@main
    secrets: inherit
```

Both reusable workflows invoke `npm run sync -- --from b/a`, so the consumer's `package.json` must have a `sync` script that calls `shadow-sync.ts` with the correct `SHADOW_CONFIG` env var pointing at the local `shadow-config.json`. See the [Setup](#setup) section below.

**Why the explicit `permissions:` block** — a reusable workflow's declared permissions can't exceed the caller's, and the default `default_workflow_permissions` in most repos is `read`. The pull callee needs `contents: write` (pushes shadow branches), so the caller must grant at least that. Forward's callee is `contents: read` (it pushes via PAT, not `GITHUB_TOKEN`).

### Secrets

- **`EXTERNAL_REPO_TOKEN`** — fine-grained PAT with Contents: Read and Write on every external repo listed in `shadow-config.json`. The orchestrator has no synced content of its own, so every push is cross-repo and the PAT must cover every A-side and B-side repo the config references.

## Options

| Flag | Description | Default |
|------|-------------|---------|
| `-r` / `--pair` | Pair name | All pairs |
| `--from` | Direction: `a` or `b` | `b` |
| `-b` | Branch to sync | All branches |

## Setup

1. Install shadow-sync and add a script to your `package.json`:

```bash
npm install negedng/shadow-sync cross-env tsx
```

```json
{
  "scripts": {
    "sync": "cross-env SHADOW_CONFIG=./shadow-config.json tsx node_modules/shadow-sync/shadow-sync.ts"
  }
}
```

2. Create `shadow-config.json` from the example:

```bash
cp node_modules/shadow-sync/shadow-config.example.json shadow-config.json
# Edit shadow-config.json with your pair definitions
```

3. Sync and merge. The first run replays each side's full history into the other's `shadow/` branches, anchored at the target's init commit (or the closest round-tripped echo when one exists) — so plain `git merge origin/shadow/<pair>/<branch>` always finds a real merge base. The `Shadow-replayed-<remote>` trailer makes replay idempotent: re-running is a no-op once both sides are in sync.

```bash
npm run sync -- -r backend --from a    # push monorepo changes to external
npm run sync -- -r backend --from b    # pull external changes to monorepo
git merge origin/shadow/backend/main   # merge the shadow branch
```

The first sync is proportional to source-side history (per-commit replay). For a fresh monorepo joining mature source repos, run it locally once and push the resulting shadow branches; subsequent CI syncs only handle the delta.

## Tests

```bash
npm test
```

Automated tests covering pull, push, merge, branching, binary files, LFS, symlinks, submodules, orphan-branch merges, and more.

## Files

| File | Purpose |
|------|---------|
| `shadow-config.example.json` | Example pair definitions, trailers, git config overrides |
| `shadow-common.ts` | Config, git helpers, unified replay engine |
| `shadow-sync.ts` | Single script for both directions (--from a or --from b) |
| `.shadowignore` | Ignore patterns (auto-discovered from source commit, like `.gitignore`) |
| `shadow-sync-explained.html` | Detailed technical documentation |
| `shadow-tests/` | 16 automated tests |
| `.github/workflows/shadow-sync.yml` | CI pull workflow (cron) |
| `.github/workflows/shadow-forward.yml` | CI push workflow (on shadow branch push) |
