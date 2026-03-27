# Shadow Sync

Mirror files between an internal repo and external repositories using git. Each external repo maps to a local subdirectory (e.g. `backend/`, `frontend/`). Commits are replayed individually to preserve authorship, timestamps, and history.

For a detailed technical deep dive, see [`shadow/shadow-sync-explained.html`](shadow/shadow-sync-explained.html).

## How it works

```
PULLING (external → us):
  External Repo ──[ CI sync ]──→ Shadow Branch ──[ shadow-pull ]──→ Your Branch

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

### Pulling external changes

```bash
npm run pull                    # pull from first configured remote
npm run pull -- -r frontend     # pull from a specific remote
npm run pull -- --no-sync       # skip CI sync trigger, just pull current shadow state
```

This runs `shadow-pull.ts` which:
1. Triggers CI sync on GitHub to fetch the latest external changes (requires `EXTERNAL_REPO_TOKEN` — skipped if not set)
2. Waits ~20 seconds for the sync to complete
3. Safely merges the shadow branch into your local branch — only `dir/` files are affected, all other files are preserved

**Warning:** Do **not** use a raw `git merge origin/shadow/{dir}/main`. The shadow branch only contains `dir/` files, so a raw merge would delete everything else in your repo.

### Pushing your changes

```bash
npm run export                                # push to first configured remote
npm run export -- -r backend -m "Fix API bug" # with optional message
npm run export -- -n                          # dry run
```

This runs `shadow-export.ts` which:
1. Checks that the shadow branch is merged into your local branch (refuses otherwise)
2. Merges your branch into the shadow branch (real git merge with proper ancestry)
3. Strips non-`dir/` files and `.shadowignore` matches from the index
4. Commits and pushes — CI automatically forwards to the external remote

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

Triggers on push to `shadow/**` branches. Takes a snapshot of the `{dir}/` content (stripping the subdirectory prefix) and pushes to the external remote.

Requires an `EXTERNAL_REPO_TOKEN` secret (a fine-grained PAT with Contents: Read and write access to the external repos). See the [PAT setup section in the technical docs](shadow/shadow-sync-explained.html#pat-setup) for step-by-step instructions.

## Options

**shadow-pull:**

| Flag | Description | Default |
|------|-------------|---------|
| `-r` | Remote name | First entry in config |
| `-d` | Local subdirectory | Inferred from remote config |
| `-b` | Branch | Current local branch |
| `--no-sync` | Skip triggering CI sync | |

**shadow-export:**

| Flag | Description | Default |
|------|-------------|---------|
| `-r` | Remote name | First entry in config |
| `-d` | Local subdirectory to export from | Inferred from remote config |
| `-b` | Target branch | Current local branch |
| `-m` | Commit message | Git's default merge message |
| `-n` | Dry run — show what would change | |

**shadow-setup (initial bootstrap):**

| Flag | Description | Default |
|------|-------------|---------|
| `-r` | Remote name | First entry in config |
| `-d` | Local subdirectory | Inferred from remote config |
| `-b` | Branch to set up | Current local branch |

## Setup

1. Edit `shadow-config.json`:

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

3. Create two fine-grained PATs (see [PAT setup](shadow/shadow-sync-explained.html#pat-setup) for step-by-step):

   **Token 1 — CI forward** (pushes to external repos):
   - Repos: the external repos only (`test-frontend`, `test-backend`)
   - Permission: **Contents: Read and write**
   - Add as `EXTERNAL_REPO_TOKEN` secret in your internal repo settings (Settings → Secrets → Actions)

   **Token 2 — Local sync trigger** (triggers CI sync from `npm run pull`):
   - Repos: the internal repo only (`test-main`)
   - Permission: **Actions: Read and write**
   - Set as local environment variable:

   ```bash
   # Linux/macOS (add to ~/.bashrc or ~/.zshrc)
   export EXTERNAL_REPO_TOKEN=github_pat_...

   # PowerShell (add to $PROFILE)
   $env:EXTERNAL_REPO_TOKEN = "github_pat_..."
   ```

   You can use a single token for both if you prefer — just include all repos and both permissions. Two tokens is safer: if one leaks, the blast radius is smaller.

## Initial bootstrap

```bash
# 1. Run setup for each remote (records seed baseline)
npm run setup -- -r backend
npm run setup -- -r frontend

# 2. Push the seed commits
git push

# 3. From now on, CI handles sync. To pull/push:
npm run pull -- -r backend
npm run export -- -r backend
```

## Tests

```bash
npm test                                  # Run all 34 tests
npx tsx shadow/shadow-tests/test-pull-basic.ts   # Run a single test
```

## Files

All shadow sync scripts live in the `shadow/` directory:

| File | Purpose |
|------|---------|
| `shadow/shadow-config.json` | Remotes, trailers, git config overrides, limits |
| `shadow/shadow-common.ts` | Shared config, git helpers, replay engine, lockfile |
| `shadow/shadow-setup.ts` | Bootstrap: records seed so CI sync skips existing history |
| `shadow/shadow-pull.ts` | Safely merges shadow branch into local (only `dir/` affected) |
| `shadow/shadow-export.ts` | Merges local changes into shadow branch (with `.shadowignore` filtering) |
| `shadow/shadow-ci-sync.ts` | CI: replays external commits into shadow branches |
| `shadow/shadow-ci-forward.ts` | CI: forwards shadow branch content to external remotes |
| `shadow/.shadowignore` | Glob patterns for files to exclude from export |
| `shadow/shadow/shadow-sync-explained.html` | Detailed technical documentation |
| `shadow/shadow-tests/` | 34 automated tests |
| `.github/workflows/shadow-sync.yml` | CI pull workflow (cron schedule) |
| `.github/workflows/shadow-forward.yml` | CI forward workflow (on push to `shadow/**`) |
| `shadow-tests/` | 34 automated tests |
