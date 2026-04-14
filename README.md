# Shadow Sync

Mirror files between an internal repo and external repositories using git. Each external repo maps to a local subdirectory (e.g. `backend/`, `frontend/`). Commits are replayed individually to preserve authorship, timestamps, and history. Merge topology (branches, merge commits, shared ancestors) is preserved.

For a detailed technical deep dive, see [`shadow/shadow-sync-explained.html`](shadow/shadow-sync-explained.html).

## How it works

```
PULLING (external → us):
  External Repo ──[ ci-sync ]──→ Shadow Branch ──[ git merge ]──→ Your Branch

PUSHING (us → external):
  Your Branch ──[ ci-forward ]──→ External Shadow Branch ──[ git merge ]──→ External Main
```

Three copies of the code:

| Name | Where | What |
|------|-------|------|
| **External** | External repo (e.g. `github.com/org/backend`) | The external source of truth |
| **Shadow** | `shadow/backend/main` branch on your origin | Mirror — kept in sync by CI |
| **Your branch** | Your working branch (`main`, `feature/...`) | Internal repo with all subdirs |

## Local workflow

### Pulling external changes

Run sync to replay external commits into shadow branches, then merge:

```bash
# Sync all remotes (same as what CI does every 15 min)
npx --prefix shadow tsx shadow/shadow-ci-sync.ts

# Sync one remote
npx --prefix shadow tsx shadow/shadow-ci-sync.ts -r backend

# Merge the shadow branch into your working branch
git fetch origin
git merge origin/shadow/backend/main
```

Or use the npm shortcut:

```bash
npm --prefix shadow run ci-sync                  # sync all remotes
npm --prefix shadow run ci-sync -- -r frontend   # sync one remote
```

Shadow branches carry the full repo tree, so `git merge` just works — only `dir/` files change, everything else is untouched.

### Pushing your changes

Run forward to replay local commits (that touch `dir/`) to the external repo's shadow branch:

```bash
# Forward all remotes
npx --prefix shadow tsx shadow/shadow-ci-forward.ts

# Forward one remote
npx --prefix shadow tsx shadow/shadow-ci-forward.ts -r backend

# Forward from a specific branch
npx --prefix shadow tsx shadow/shadow-ci-forward.ts -r backend -b feature/my-work
```

Or use the npm shortcut:

```bash
npm --prefix shadow run ci-forward                  # forward all remotes
npm --prefix shadow run ci-forward -- -r backend    # forward one remote
```

The external team then merges `shadow/main` on their side to pull in your changes.

### `.shadowignore`

Glob patterns (one per line) for files that should not reach the external repo. Applied during forward by removing matched files from the git index before committing.

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
2. Replays new commits into `shadow/{dir}/{branch}` branches (per-commit, preserving authorship and merge topology)
3. Pushes shadow branches to origin

### Shadow Forward — `.github/workflows/shadow-forward.yml`

Triggers on push to `shadow/**` branches, but only runs for commits with the `Shadow-export:` trailer (ci-sync commits are skipped). Replays local commits to the external repo's shadow branch, stripping the `dir/` prefix.

Requires an `EXTERNAL_REPO_TOKEN` secret (a fine-grained PAT with Contents: Read and write access to the external repos). See the [PAT setup section in the technical docs](shadow/shadow-sync-explained.html#pat-setup) for step-by-step instructions.

## Options

**shadow-ci-sync.ts:**

| Flag | Description | Default |
|------|-------------|---------|
| `-r` | Remote name (sync only this remote) | All configured remotes |

**shadow-ci-forward.ts:**

| Flag | Description | Default |
|------|-------------|---------|
| `-r` | Remote name (forward only this remote) | All configured remotes |
| `-b` | Local branch to forward from | Current branch |

**shadow-setup.ts (optional bootstrap):**

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

## Initial bootstrap

Record a seed so CI sync knows where to start (skips existing external history):

```bash
npm --prefix shadow run setup -- -r backend
npm --prefix shadow run setup -- -r frontend
```

From then on:

```bash
# Pull external changes
npm --prefix shadow run ci-sync -- -r backend
git merge origin/shadow/backend/main

# Push your changes
npm --prefix shadow run ci-forward -- -r backend
```

## Troubleshooting

### Someone pushed directly to a `shadow/**` branch

Shadow branches should only be written to by `shadow-ci-sync` and `shadow-ci-forward`. Direct pushes create commits without the expected trailers, which breaks the sync cycle.

**Symptoms:** Unexpected files appear after merging the shadow branch, or ci-sync creates duplicate commits.

**Fix — if the commit was NOT yet merged into local:**

```bash
# Find the last valid commit on the shadow branch (look for Shadow-synced-from trailers)
git fetch origin
git log origin/shadow/backend/main --oneline

# Force-push the shadow branch back to the last valid commit
git push origin <last-valid-hash>:refs/heads/shadow/backend/main --force
```

**Fix — if the commit WAS already merged into local:**

```bash
# Revert the merge commit on your local branch
git revert <merge-commit-hash>
git push origin main

# Then fix the shadow branch as above
git push origin <last-valid-hash>:refs/heads/shadow/backend/main --force
```

**Prevention:** Never push directly to `shadow/**` branches. Use `ci-forward` to push local changes and let CI sync handle external changes.

## Tests

```bash
npm --prefix shadow test                                          # Run all 38 tests
npx --prefix shadow tsx shadow/shadow-tests/test-pull-basic.ts    # Run a single test
```

## Files

All shadow sync scripts live in the `shadow/` directory:

| File | Purpose |
|------|---------|
| `shadow/shadow-config.json` | Remotes, trailers, git config overrides, limits |
| `shadow/shadow-common.ts` | Shared config, git helpers, incoming/outgoing replay engines |
| `shadow/shadow-setup.ts` | Optional bootstrap: records seed so CI sync skips existing history |
| `shadow/shadow-ci-sync.ts` | Replays external commits into shadow branches, adding `dir/` prefix |
| `shadow/shadow-ci-forward.ts` | Replays local commits to external shadow branches, stripping `dir/` prefix |
| `shadow/.shadowignore` | Glob patterns for files to exclude from forward |
| `shadow/shadow-sync-explained.html` | Detailed technical documentation |
| `shadow/shadow-tests/` | 38 automated tests |
| `.github/workflows/shadow-sync.yml` | CI pull workflow (cron schedule) |
| `.github/workflows/shadow-forward.yml` | CI forward workflow (on push to `shadow/**`) |
