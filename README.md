# Shadow Sync

Mirror files between a mono-repo and external team repositories using git. Each external repo maps to a local subdirectory (e.g. `backend/`, `frontend/`). Commits are replayed individually to preserve authorship, timestamps, and history.

## How it works

```
  external/backend/main ←── CI (identical) ──→ shadow/backend/main ←── filtered ──→ origin (your branch)
                                                                       .shadowignore
```

Three copies of the code:

| Name | Where | What |
|------|-------|------|
| **external** | Team's repo (e.g. `github.com/org/backend`) | The team's source of truth |
| **shadow** | `shadow/backend/main` branch on your origin | Mirror of external, stays in sync via CI |
| **origin** | Your working branch (`main`, `feature/...`) | Your monorepo with all subdirs |

**CI keeps external ↔ shadow in sync** (per-commit replay, no filtering).

**You merge between shadow ↔ origin locally:**
- `git merge origin/shadow/backend/main` — pull team changes (no filtering)
- `npm run export -m "msg"` — push your changes (`.shadowignore` strips AI files etc.)

## Local workflow

### Pulling team changes

```bash
git fetch origin
git merge origin/shadow/backend/main
```

Standard git merge. Shadow branches are updated automatically by CI every 15 minutes.

### Pushing your changes

```bash
npm run export -- -m "Add login page"
npm run export -- -r backend -m "Fix API bug"
npm run export -- -r frontend -b feature/new-page -m "Add new page"
```

This runs `shadow-export.ts` which:
1. Extracts your `backend/` subdirectory content
2. Filters out files matching `.shadowignore` patterns
3. Commits to `shadow/backend/main` on origin
4. CI automatically forwards the change to the external remote

### `.shadowignore`

Glob patterns (one per line) for files that should not reach the external remote. Applied during export, so these files never appear on the shadow branch or external remote.

```
# Example .shadowignore
CLAUDE.md
**/*.local
.cursor/
```

## GitHub Actions

### Shadow Sync — `.github/workflows/shadow-sync.yml`

Runs every 15 minutes (and on manual dispatch). For each configured remote:
1. Fetches from the external repo
2. Replays new commits into `shadow/{dir}/{branch}` branches (per-commit, preserving authorship)
3. Pushes shadow branches to origin

### Shadow Forward — `.github/workflows/shadow-forward.yml`

Triggers on push to `shadow/**` branches. Takes a snapshot of the `{dir}/` content (stripping the subdirectory prefix) and pushes to the external remote.

### Required secrets

| Secret | Description |
|--------|-------------|
| `BACKEND_REPO_URL` | Authenticated URL for the backend repo (e.g. `https://x-access-token:TOKEN@github.com/org/backend.git`) |
| `FRONTEND_REPO_URL` | Authenticated URL for the frontend repo |

## Options

**shadow-export:**

| Flag | Description | Default |
|------|-------------|---------|
| `-r` | Remote name (selects config entry) | First entry in `REMOTES` |
| `-d` | Local subdirectory to export from | Inferred from remote config |
| `-b` | Target branch | Current local branch |
| `-m` | Commit message (required) | |
| `-n` | Dry run — show what would change | |

**shadow-setup (initial bootstrap):**

| Flag | Description | Default |
|------|-------------|---------|
| `-r` | Remote name | First entry in `REMOTES` |
| `-d` | Local subdirectory | Inferred from remote config |
| `-b` | Branch to set up | Current local branch |

## Setup

1. Edit `shadow-config.json`:

```json
{
  "remotes": [
    { "remote": "backend",  "dir": "backend"  },
    { "remote": "frontend", "dir": "frontend" }
  ],
  "syncSince": "2024-11-01"
}
```

2. Add GitHub Secrets for external repo URLs (see [Required secrets](#required-secrets)).

3. Add git remotes for each external repo:

```bash
git remote add backend   git@their-server.com:backend.git
git remote add frontend  git@their-server.com:frontend.git
```

## Initial bootstrap

```bash
# 1. Run setup for each remote (creates shadow branch + seed baseline)
npm run setup -- -r backend
npm run setup -- -r frontend

# 2. Push the seed commits
git push

# 3. From now on, CI handles sync. To push local changes:
npm run export -- -m "My changes"
```

The setup script creates the shadow branch on origin and records a seed commit so CI sync skips existing history.

## Branch layout

```
external/backend/main ←── CI sync ──→ shadow/backend/main ←── shadow-export ──→ your branch
                          (identical)                          (.shadowignore)

                                       shadow/backend/main ──── git merge ────→ your branch
                                                                (all files)
```

## Tests

```bash
npm test                                  # Run all tests
npx tsx shadow-tests/test-pull-basic.ts   # Run a single test
```

## Files

| File | Purpose |
|------|---------|
| `shadow-config.json` | Remotes, sync date, trailers, and other settings |
| `shadow-common.ts` | Shared config, git helpers, patch application, replay engine |
| `shadow-setup.ts` | Bootstrap: creates shadow branch and seed baseline |
| `shadow-export.ts` | Exports local subdirectory to shadow branch (with `.shadowignore` filtering) |
| `shadow-sync-all.ts` | Syncs all remote branches into local shadow branches |
| `shadow-ci-sync.ts` | CI: replays remote commits to shadow branches |
| `shadow-ci-forward.ts` | CI: forwards shadow branch content to external remotes |
| `.github/workflows/shadow-sync.yml` | CI pull workflow (cron every 15 min) |
| `.github/workflows/shadow-forward.yml` | CI forward workflow (on push to shadow/**) |
| `.shadowignore` | Glob patterns for files to exclude from export (optional) |
| `shadow-tests/` | Automated test suite |
