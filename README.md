# Shadow Sync

Mirror files between an internal repo and external repositories using git. Each external repo maps to a local subdirectory (e.g. `backend/`, `frontend/`). Commits are replayed individually to preserve authorship, timestamps, and history.

For a detailed technical deep dive, see [`shadow/shadow-sync-explained.html`](shadow/shadow-sync-explained.html).

## How it works

```
PULLING (external → us):
  External Repo ──[ CI sync ]──→ Shadow Branch ──[ shadow-import ]──→ Your Branch

PUSHING (us → external):
  Your Branch ──[ shadow-export + .shadowignore ]──→ Shadow Branch ──[ CI forward ]──→ External Repo
```

Three copies of the code:

| Name | Where | What |
|------|-------|------|
| **External** | External repo (e.g. `github.com/org/backend`) | The external source of truth |
| **Shadow** | `shadow/backend/main` branch on your origin | Mirror — kept in sync by CI |
| **Your branch** | Your working branch (`main`, `feature/...`) | Internal repo with all subdirs |

## Local workflow

### Importing external changes

```bash
npm --prefix shadow run import                    # pull from first configured remote
npm --prefix shadow run import -- -r frontend     # pull from a specific remote
npm --prefix shadow run import -- --no-sync       # skip sync, just merge current shadow state
```

This runs `shadow-import.ts` which:
1. Runs ci-sync locally — fetches from external remotes and replays new commits into shadow branches (no token needed)
2. Safely merges the shadow branch into your local branch — resets the index and working tree to HEAD with `git read-tree` + `git checkout HEAD -- .`, then overlays only `dir/` changes, so all other files are preserved

**Warning:** Do **not** use a raw `git merge origin/shadow/{dir}/main`. The shadow branch only contains `dir/` files, so a raw merge would delete everything else in your repo.

### Pushing your changes

```bash
npm --prefix shadow run export                                # push to first configured remote
npm --prefix shadow run export -- -r backend -m "Fix API bug" # with optional message
npm --prefix shadow run export -- -n                          # dry run
npm --prefix shadow run export -- --no-sync                   # skip sync
```

This runs `shadow-export.ts` which:
1. Runs ci-sync locally to ensure the shadow branch has the latest external changes (skipped with `--no-sync`)
2. **Auto-creates the shadow branch** if it doesn't exist yet (creates an orphan branch, pushes it, and merges it into your working branch) — no need to run `shadow-setup.ts` first
3. Checks that the shadow branch is merged into your local branch (refuses otherwise — import first)
4. Builds a tree using git plumbing: reads only `dir/`, `.github/`, and `shadow/` from HEAD into a temp index via `git read-tree`
5. Removes `.shadowignore` matches from the index
6. Creates a merge commit with `git commit-tree` (two parents: shadow tip + HEAD) and pushes — CI automatically forwards to the external remote

### `.shadowignore`

Glob patterns (one per line) for files that should not reach the external repo. Applied during export by removing matched files from the git index before committing.

```
# Example .shadowignore
CLAUDE.md
**/*.local
.cursor/
```

## GitHub Actions

### Shadow Sync — `.github/workflows/shadow-sync.yml`

Runs on a cron schedule (every 15 minutes requested, but GitHub may delay runs — gaps of 30–60+ minutes are normal on free-tier repos). For each configured remote:
1. Fetches from the external repo
2. Replays new commits into `shadow/{dir}/{branch}` branches (per-commit, preserving authorship)
3. Pushes shadow branches to origin

### Shadow Forward — `.github/workflows/shadow-forward.yml`

Triggers on push to `shadow/**` branches, but only runs for export commits (checks for `Shadow-export:` trailer — ci-sync commits are skipped). Uses git plumbing (`git read-tree` + `git commit-tree`) to build a commit with the `{dir}/` content at root level (stripping the prefix) and pushes to the external remote.

Requires an `EXTERNAL_REPO_TOKEN` secret (a fine-grained PAT with Contents: Read and write access to the external repos). See the [PAT setup section in the technical docs](shadow/shadow-sync-explained.html#pat-setup) for step-by-step instructions.

## Options

**shadow-import:**

| Flag | Description | Default |
|------|-------------|---------|
| `-r` | Remote name | First entry in config |
| `-d` | Local subdirectory | Inferred from remote config |
| `-b` | Branch | Current local branch |
| `--no-sync` | Skip local sync (just merge current shadow state from origin) | |

**shadow-export:**

| Flag | Description | Default |
|------|-------------|---------|
| `-r` | Remote name | First entry in config |
| `-d` | Local subdirectory to export from | Inferred from remote config |
| `-b` | Target branch | Current local branch |
| `-m` | Override commit message | Auto-generated summary of exported commits |
| `-n` | Dry run — show what would change | |
| `--no-sync` | Skip syncing external changes before export | |

**shadow-setup (optional bootstrap):**

| Flag | Description | Default |
|------|-------------|---------|
| `-r` | Remote name | First entry in config |
| `-d` | Local subdirectory | Inferred from remote config |
| `-b` | Branch to set up | Current local branch |

## Setup

1. Edit `shadow/shadow-config.json`:

```json
{
  "remotes": [
    { "remote": "backend",  "dir": "backend",  "url": "https://github.com/org/backend.git"  },
    { "remote": "frontend", "dir": "frontend", "url": "https://github.com/org/frontend.git" }
  ]
}
```

2. Add git remotes for each external repo:

```bash
git remote add backend   https://github.com/org/backend.git
git remote add frontend  https://github.com/org/frontend.git
```

3. Create a fine-grained PAT (see [PAT setup](shadow/shadow-sync-explained.html#pat-setup) for step-by-step):

   **CI forward token** (pushes to external repos):
   - Repos: the external repos only (`test-frontend`, `test-backend`)
   - Permission: **Contents: Read and write**
   - Add as `EXTERNAL_REPO_TOKEN` secret in your internal repo settings (Settings → Secrets → Actions)

   No local token is needed — `shadow-import` runs the sync locally instead of dispatching a CI workflow.

## Initial bootstrap

No manual setup is needed for shadow branches — `shadow-export` automatically creates them on first use for any remote/branch combination.

For the initial seed baseline (so CI sync skips existing external history), you can either:
- **Let export handle it:** Just run `npm run export` — it creates the shadow branch and exports in one step
- **Use setup for seed-only (optional):** `npm run setup -- -r backend` records a seed commit so CI sync knows where to start

```bash
# From now on, to pull/push:
npm --prefix shadow run import -- -r backend
npm --prefix shadow run export -- -r backend -m "my changes"
```

## Troubleshooting

### Someone pushed directly to a `shadow/**` branch

Shadow branches should only be written to by `shadow-export` and `shadow-ci-sync`. Direct pushes create commits without the expected trailers, which breaks the sync cycle.

**Symptoms:** `shadow-export` refuses with "shadow has commits not merged into your local branch", or unexpected files appear after `shadow-import`.

**Fix — if the commit was NOT yet imported into local:**

```bash
# Find the last valid commit on the shadow branch (look for Shadow-synced-from or Shadow-export trailers)
git fetch origin
git log origin/shadow/backend/main --oneline

# Force-push the shadow branch back to the last valid commit
git push origin <last-valid-hash>:refs/heads/shadow/backend/main --force
```

**Fix — if the commit WAS already imported into local:**

```bash
# Revert the import merge commit on your local branch
git revert <merge-commit-hash>
git push origin main

# Then fix the shadow branch as above
git push origin <last-valid-hash>:refs/heads/shadow/backend/main --force
```

**Prevention:** Never push directly to `shadow/**` branches. Use `npm run export` to push local changes and let CI sync handle external changes.

## Tests

```bash
npm --prefix shadow test                                  # Run all 34 tests
npx --prefix shadow tsx shadow/shadow-tests/test-pull-basic.ts   # Run a single test
```

## Files

All shadow sync scripts live in the `shadow/` directory:

| File | Purpose |
|------|---------|
| `shadow/shadow-config.json` | Remotes, trailers, git config overrides, limits |
| `shadow/shadow-common.ts` | Shared config, git helpers, replay engine, lockfile |
| `shadow/shadow-setup.ts` | Optional bootstrap: records seed so CI sync skips existing history |
| `shadow/shadow-import.ts` | Runs ci-sync locally, then safely merges shadow branch into local (only `dir/` affected) |
| `shadow/shadow-export.ts` | Exports local changes to shadow branch using git plumbing (with `.shadowignore` filtering). Auto-creates shadow branches on first use |
| `shadow/shadow-ci-sync.ts` | CI: replays external commits into shadow branches |
| `shadow/shadow-ci-forward.ts` | CI: forwards shadow branch content to external remotes using git plumbing |
| `shadow/.shadowignore` | Glob patterns for files to exclude from export |
| `shadow/shadow-sync-explained.html` | Detailed technical documentation |
| `shadow/shadow-tests/` | 34 automated tests |
| `.github/workflows/shadow-sync.yml` | CI pull workflow (cron schedule) |
| `.github/workflows/shadow-forward.yml` | CI forward workflow (on push to `shadow/**`) |
