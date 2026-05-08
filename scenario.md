# Setup
# Two sync pairs:
#   pair "backend":  monorepo/backend/  ↔  backend repo root
#   pair "frontend": monorepo/frontend/ ↔  frontend repo root
# Monorepo also carries root-level content not in any pair: .claude/ and README.md

git config set --global init.defaultBranch core-dev
# Mature backend
backend/core-dev: git commit Bc0 # init commit on backend core-dev
backend/core-dev: git commit Bc1 # commit on backend core-dev
backend/core-dev: git checkout -b core-1.0
backend/core-1.0: git commit Br1 # release commit new branch from core-dev
backend/core-1.0: git checkout core-dev
backend/core-dev: git commit Bc2 # work continues on core-dev
backend/core-dev: git checkout core-1.0
backend/core-1.0: git checkout -b project
backend/project: git commit Bt1 # project branch after release
# Mature frontend
frontend/core-dev: git commit Fc0 # init commit on backend core-dev
frontend/core-dev: git commit Fc1 # commit on backend core-dev
frontend/core-dev: git checkout -b core-1.0
frontend/core-1.0: git commit Fr1 # release commit new branch from core-dev
frontend/core-1.0: git checkout core-dev
frontend/core-dev: git commit Fc2 # work continues on core-dev
frontend/core-dev: git checkout core-1.0
frontend/core-1.0: git checkout -b project
frontend/project: git commit Ft1 # project branch after release
# Init monorepo
monorepo/core-dev: git commit Mc0 # init commit on monorepo core-dev
monorepo/core-dev: git checkout -b project
# Init sync
sync --from b # Sync frontend and backend to monorepo
monorepo/core-dev: git merge shadow/backend/core-dev # Mc1
monorepo/core-dev: git merge shadow/frontend/core-dev # Mc2
monorepo/core-dev: git commit Mc3 # frontend-only commit (single-parent, no backend/ delta)
monorepo/core-dev: git commit Mc4 # commit touching frontend, backend and root AI files
sync --from a # Sync monorepo changes back to frontend and backend.
assert: Mc3 (frontend-only) does NOT appear on backend's shadow/backend/main; DOES appear on frontend's shadow/frontend/main
backend/core-dev: git merge shadow/backend/core-dev # Bc3
frontend/core-dev: git merge shadow/frontend/core-dev # Fc3
sync --from b
monorepo/core-dev: git checkout project
monorepo/project: git merge shadow/backend/project # Mt1
assert: existence of branches, commit, Mc2 and frontend commits not on backend; Mc1 and backend commits not on frontend
# Release
monorepo/core-dev: git merge shadow/backend/project # Mc5
monorepo/core-dev: git merge shadow/frontend/project # Mc6
monorepo/core-dev: git checkout -b core-2.0
monorepo/core-2.0: git commit Mr1
sync --from a
backend/core-dev: git merge shadow/backend/core-dev # Bc4
backend/core-dev: git checkout -b core-2.0
backend/core-2.0: git merge shadow/backend/core-2.0 # Br2
backend/core-2.0: git checkout project
backend/project: git merge backend/core-2.0 # Bt2
frontend/core-dev: git merge shadow/frontend/core-dev # Fc4
frontend/core-dev: git checkout -b core-2.0
frontend/core-2.0: git merge shadow/frontend/core-2.0 # Fr2
frontend/core-2.0: git checkout project
frontend/project: git merge frontend/core-2.0 # Ft2
sync --from b
assert: existence of all branches, commits, parents of commits
# Hotfix projects
monorepo/project: git merge shadow/backend/project # Mt2
monorepo/project: git merge shadow/frontend/project # Mt3
monorepo/project: git checkout -b bug/core-2.0/fix 
monorepo/bug/core-2.0/fix: git commit Mf1 # bug fix
sync --from a
backend/project: git checkout -b bug/core-2.0/fix
backend/bug/core-2.0/fix: git merge shadow/backend/bug/core-2.0/fix # Bf1
backend/bug/core-2.0/fix: git checkout project
backend/project: git merge backend/bug/core-2.0/fix # Bt3
sync --from b
# Multi-project: a second project-shape branch (projectB) parallel to project.
# Both branched from core-1.0 on the leaf repos and from Mc0 on monorepo —
# they share an early ancestor but diverge from there. Verifies shadow chains
# stay independent and that one project's hotfix history doesn't leak into
# the other's shadow.
backend/core-1.0: git checkout -b projectB
backend/projectB: git commit BtB1 # adds backend/src/projectB.txt (distinct from project's project.txt)
frontend/core-1.0: git checkout -b projectB
frontend/projectB: git commit FtB1 # adds frontend/src/projectB.txt
sync --from b # picks up new projectB on both pairs
monorepo/main: git checkout -b projectB Mc0 # off Mc0, parallel to project
monorepo/projectB: git merge shadow/backend/projectB  # MtB1
monorepo/projectB: git merge shadow/frontend/projectB # MtB2
sync --from a # pushes shadow/{backend,frontend}/projectB back to leaf repos
# Fanout-merge: one feature branch merged into 3 different target branches on backend.
# Verifies BfX1 has exactly one replay on monorepo's shadow chains, and that the
# replays of the three merge commits all reference the same BfX1'_mono as their
# second parent (one echo, three uses).
backend/main: git checkout main
backend/main: git checkout -b feature/fanout
backend/feature/fanout: git commit BfX1 # adds backend/src/fanout.txt
backend/feature/fanout: git checkout main
backend/main: git merge feature/fanout  # Bc5    = merge(Bc4, BfX1)
backend/main: git checkout project
backend/project: git merge feature/fanout # Bt4   = merge(Bt3, BfX1)
backend/project: git checkout projectB
backend/projectB: git merge feature/fanout # BtB2 = merge(BtB1, BfX1)
sync --from b

---

# Predicted commit graph

Notation:
- `X'` = engine-emitted replay of `X` onto the other side. Each replay carries a `Shadow-replayed-<source-remote>` trailer so a later sync from the opposite direction recognizes it as an *echo* and maps the replayed SHA back to the original (rather than re-replaying it).
- `X'<noop>` = a replayed merge commit whose tree under the target's path equals its first parent's — i.e. the merge contributes no content delta on this side. Topologically real, but content-empty.
- `merge(P1, P2)` = 2-parent merge commit with the listed parents.

## TREESAME-drop rule

For `--from a`, `collectSourceCommits` runs `rev-list --topo-order --reverse --full-history -- <source.dir>/`. The rules under that path filter are:

- **Single-parent commits** TREESAME to their parent under the path: **DROPPED.**
- **Merges**: kept iff at least one parent is **non-TREESAME** under the path. Merges TREESAME to **every** parent are dropped.
- A merge that's TREESAME to its first parent but non-TREESAME to a sibling parent is **kept** as a noop-tree merge on the shadow chain (the merge commit exists; its tree under the path equals the first parent's).

What this means in practice:
- A single-parent monorepo commit that touches only the *other* pair's prefix or only root is invisible to this pair (e.g. Mc3 fe-only → dropped on backend).
- A merge whose only contribution under this path comes from a sibling parent is **kept** as a noop-tree merge (e.g. Mc6 = `merge(Mc5, Ft1')` on backend — be tree TREESAME to Mc5 but ≠ Ft1' → kept).
- A merge where every parent has the same empty tree under this path is **dropped** (e.g. Mc1 on frontend — both Mc0 and Bc2' have empty fe → all-TREESAME → dropped).

For `--from b`, `source.dir = ""` (root) so there's no path filter, and every commit on the source's branches is a candidate.

This is what the new Mc3 (frontend-only single-parent) on line 29 verifies: dropped on backend (no `Mc3'_be`), kept on frontend (`Mc3'_fe` exists).

## Per-pair replay table

`<noop-tree>` = the merge is replayed but its tree under the pair's path equals the first parent's (no content delta this side). `dropped (all-TREESAME)` = every parent has the same tree under the path → merge is omitted.

| Monorepo commit | Kind | Touches | backend pair | frontend pair |
|---|---|---|---|---|
| `Mc0` | single (init) | (empty) | dropped | dropped |
| `Mc1 = merge(Mc0, Bc2')` | merge | brings be/ from Bc2 | **`Mc1'_be`** | dropped (all-TREESAME on fe/) |
| `Mc2 = merge(Mc1, Fc2')` | merge | brings fe/ from Fc2 | **`Mc2'_be<noop-tree>`** | **`Mc2'_fe`** |
| `Mc3` | single | fe/ only | **dropped** (single-parent TREESAME) | **`Mc3'_fe`** |
| `Mc4` | single | be/, fe/, root | **`Mc4'_be`** | **`Mc4'_fe`** |
| `Mt1 = merge(Mc0, Bt1')` | merge | brings be/ Bt1 work | **`Mt1'_be`** | dropped (all-TREESAME on fe/) |
| `Mc5 = merge(Mc4, Bt1')` | merge | brings be/ project work | **`Mc5'_be`** | **`Mc5'_fe<noop-tree>`** |
| `Mc6 = merge(Mc5, Ft1')` | merge | brings fe/ project work | **`Mc6'_be<noop-tree>`** | **`Mc6'_fe`** |
| `Mr1` | single | be/, fe/ | **`Mr1'_be`** | **`Mr1'_fe`** |
| `Mt2 = merge(Mt1, Bt2'_mono)` | merge | brings be/ Bt2 (= Br2) work | **`Mt2'_be`** | dropped (all-TREESAME on fe/) |
| `Mt3 = merge(Mt2, Ft2'_mono)` | merge | brings fe/ Ft2 (= Fr2) work | **`Mt3'_be<noop-tree>`** | **`Mt3'_fe`** |
| `Mf1` | single | be/ only | **`Mf1'_be`** | **dropped** (single-parent TREESAME) |
| `MtB1 = merge(Mc0, BtB1')` | merge | brings be/ from projectB | **`MtB1'_be`** | dropped (all-TREESAME on fe/) |
| `MtB2 = merge(MtB1, FtB1')` | merge | brings fe/ from projectB | **`MtB2'_be<noop-tree>`** | **`MtB2'_fe`** |

For dropped entries, the engine's branch-tip mapping walks the source branch newest-first to find a replayed ancestor.

## Backend (sht5-backend)

### Named commits and parents

| Commit | Parents | Where committed |
|---|---|---|
| `Bc0` | () | core-dev (init) |
| `Bc1` | (Bc0) | core-dev |
| `Br1` | (Bc1) | core-1.0 |
| `Bc2` | (Bc1) | core-dev |
| `Bt1` | (Br1) | project |
| `Bc3` | (Bc2, `Mc4'_be`) | core-dev — line 32 merge of shadow/backend/core-dev (tip = Mc4'_be after line 30 sync; Mc3 is dropped) |
| `Bc4` | (Bc3, `Mc6'_be<noop>`) | core-dev — line 44 merge (tip = Mc6'_be<noop> after line 42 sync — merge is kept even though TREESAME) |
| `Br2` | (Bc4, `Mr1'_be`) | core-2.0 — line 46 merge of shadow/backend/core-2.0 |
| `Bt2` | (Bt1, Br2) | project — line 48 local merge `git merge backend/core-2.0` |
| `Bf1` | (Bt2, `Mf1'_be`) | bug/core-2.0/fix — line 63 merge of shadow/backend/bug/core-2.0/fix |
| `Bt3` | (Bt2, Bf1) | project — line 65 local merge `git merge backend/bug/core-2.0/fix` |
| `BtB1` | (Br1) | projectB — multi-project: adds `src/projectB.txt` (distinct from project's `src/project.txt`) |
| `BfX1` | (Bc4) | feature/fanout — fanout: adds `src/fanout.txt` |
| `Bc5` | (Bc4, BfX1) | core-dev — fanout: local merge `git merge feature/fanout` |
| `Bt4` | (Bt3, BfX1) | project — fanout: local merge `git merge feature/fanout` |
| `BtB2` | (BtB1, BfX1) | projectB — fanout: local merge `git merge feature/fanout` |

### Shadow branches on backend (pushed by `--from a` on lines 31, 43, 61)

Anchored at `targetInit = Bc0` when no echoed ancestor exists. Tips:

- `shadow/backend/core-dev`:
  - after line 31: chain includes `Mc1'_be`, `Mc2'_be<noop-tree>`, `Mc4'_be`. **Mc3 is dropped** (single-parent TREESAME under be/). Tip = `Mc4'_be`.
    - `Mc1'_be` = merge `[Bc0, Bc2]`. Tree under root = Bc2's tree.
    - `Mc2'_be<noop-tree>` = merge — kept because Fc2' has empty be vs Mc1's be is non-empty. Tree = Mc1'_be's tree.
    - `Mc4'_be` = single, applies Mc4's backend slice. Source-parent Mc3 dropped → `findEchoAnchor` walks back to `Mc2'_be<noop-tree>`.
  - after line 43: chain extends with `Mc5'_be`, `Mc6'_be<noop-tree>`. Tip = **`Mc6'_be<noop-tree>`**.
    - `Mc5'_be` = merge — second parent via `Bt1'`-echo. Brings Bt1's backend content.
    - `Mc6'_be<noop-tree>` = merge — second parent walks Ft1' → no backend anchor → `targetInit Bc0`. Tree = Mc5'_be's tree.
- `shadow/backend/core-2.0`: tip after line 43 = **`Mr1'_be`** (single, parent `Mc6'_be<noop-tree>`).
- `shadow/backend/project`:
  - Not pushed at line 31 (monorepo project is at Mc0, no candidates touching be/).
  - After line 43: tip = **`Mt1'_be`** = merge `[Bc0, Bt1]`.
  - After line 61: tip = **`Mt3'_be<noop-tree>`**. Chain extends with `Mt2'_be`, `Mt3'_be<noop-tree>`.
    - `Mt2'_be` = merge — second parent via `Bt2'_mono`-echo to backend's `Bt2`. Brings be content.
    - `Mt3'_be<noop-tree>` = merge — kept (Ft2'_mono has empty be vs Mt2'_be has be content). Second-parent SHA depends on `findEchoAnchor` walking Ft2'_mono's ancestry, which includes `Mr1` (mapped from line 43) → so the second parent is `Mr1'_be`, **not** `Bc0`.
- `shadow/backend/bug/core-2.0/fix`: after line 61, tip = **`Mf1'_be`** = single, parent `Mt3'_be<noop-tree>`.

### Branches on backend at end

- `core-dev` → `Bc4`
- `core-1.0` → `Br1`
- `core-2.0` → `Br2`
- `project` → `Bt3`
- `bug/core-2.0/fix` → `Bf1`
- `shadow/backend/core-dev` → `Mc6'_be<noop>`
- `shadow/backend/core-2.0` → `Mr1'_be`
- `shadow/backend/project` → `Mt3'_be<noop>`
- `shadow/backend/bug/core-2.0/fix` → `Mf1'_be`

(No `shadow/backend/core-1.0` on backend — monorepo never created a core-1.0 branch, so `--from a` has nothing to push for that ref.)

## Frontend (sht5-frontend)

Mirror of backend through line 53, then no hotfix flow. Mf1 is a single-parent commit with no frontend content, so it's dropped from the frontend pair's replay (single-parent TREESAME). All M-merges are kept on the frontend pair (some as noops).

### Named commits and parents

| Commit | Parents | Where committed |
|---|---|---|
| `Fc0` | () | core-dev (init) |
| `Fc1` | (Fc0) | core-dev |
| `Fr1` | (Fc1) | core-1.0 |
| `Fc2` | (Fc1) | core-dev |
| `Ft1` | (Fr1) | project |
| `Fc3` | (Fc2, `Mc4'_fe`) | core-dev — line 33 merge of shadow/frontend/core-dev (tip = Mc4'_fe after line 30 sync) |
| `Fc4` | (Fc3, `Mc6'_fe`) | core-dev — line 49 merge of shadow/frontend/core-dev (tip = Mc6'_fe after line 42 sync) |
| `Fr2` | (Fc4, `Mr1'_fe`) | core-2.0 — line 51 merge of shadow/frontend/core-2.0 |
| `Ft2` | (Ft1, Fr2) | project — line 53 local merge `git merge frontend/core-2.0` |
| `FtB1` | (Fr1) | projectB — multi-project: adds `src/projectB.txt` |

### Shadow branches on frontend

Anchored at `targetInit = Fc0` when no echoed ancestor exists. Tips:

- `shadow/frontend/core-dev`:
  - after line 31: chain `Mc2'_fe` ← `Mc3'_fe` ← `Mc4'_fe`. Tip = `Mc4'_fe`. **Mc1 is dropped** (all-TREESAME on fe).
    - `Mc2'_fe` = merge `[<anchor>, Fc2]` — second parent via `Fc2'`-echo; first parent walks back from Mc1 (dropped) to a frontend anchor / `targetInit Fc0`.
    - `Mc3'_fe` = single, parent `Mc2'_fe`, applies the new frontend-only Mc3's slice.
    - `Mc4'_fe` = single, parent `Mc3'_fe`, applies Mc4's frontend slice.
  - after line 43: chain extends with `Mc5'_fe<noop-tree>` ← `Mc6'_fe`. Tip = **`Mc6'_fe`**.
    - `Mc5'_fe<noop-tree>` = merge — kept because non-TREESAME to one parent (Bt1' has empty fe vs Mc4 has fe content). Tree = Mc4'_fe's tree.
    - `Mc6'_fe` = merge — second parent via `Ft1'`-echo. Brings Ft1's frontend content.
- `shadow/frontend/core-2.0`: tip after line 43 = **`Mr1'_fe`** (single, parent `Mc6'_fe`).
- `shadow/frontend/project`:
  - After line 43: empty / not pushed. **Mt1 is dropped** (all-TREESAME on fe — both Mc0 and Bt1' have empty fe). No replayable commits → no `branchMapping` entry → branch not pushed.
  - After line 61: tip = **`Mt3'_fe`**. **Mt2 is also dropped** (all-TREESAME). Only Mt3 is replayed.
    - `Mt3'_fe` = merge `[<anchor>, Ft2]` — second parent via `Ft2'_mono`-echo; first parent (Mt2 dropped) walks back through ancestors to `targetInit Fc0` (or closest anchor).
- `shadow/frontend/bug/core-2.0/fix`: after line 61, Mf1 is **dropped** (single-parent TREESAME on fe). Branch tip walks back from Mf1 → Mt3 → mapped to **`Mt3'_fe`**. Branch exists but holds no Mf1 — same SHA as `shadow/frontend/project`.

### Branches on frontend at end

- `core-dev` → `Fc4`
- `core-1.0` → `Fr1`
- `core-2.0` → `Fr2`
- `project` → `Ft2`
- `shadow/frontend/core-dev` → `Mc6'_fe`
- `shadow/frontend/core-2.0` → `Mr1'_fe`
- `shadow/frontend/project` → `Mt3'_fe`
- `shadow/frontend/bug/core-2.0/fix` → `Mt3'_fe` (no Mf1 replay — single-parent TREESAME drop)

## Monorepo (sht5-main)

### Named commits and parents

| Commit | Parents | Where committed |
|---|---|---|
| `Mc0` | () | core-dev (init) |
| `Mc1` | (Mc0, `Bc2'`) | core-dev — line 27 |
| `Mc2` | (Mc1, `Fc2'`) | core-dev — line 28 |
| `Mc3` | (Mc2) | core-dev — line 29; **frontend/ only** (single-parent, no backend delta) |
| `Mc4` | (Mc3) | core-dev — line 30; touches backend/, frontend/, root |
| `Mt1` | (Mc0, `Bt1'`) | project — line 36 |
| `Mc5` | (Mc4, `Bt1'`) | core-dev — line 39 |
| `Mc6` | (Mc5, `Ft1'`) | core-dev — line 40 |
| `Mr1` | (Mc6) | core-2.0 — line 42; touches backend/ and frontend/ |
| `Mt2` | (Mt1, `Bt2'_mono`) | project — line 57 |
| `Mt3` | (Mt2, `Ft2'_mono`) | project — line 58 |
| `Mf1` | (Mt3) | bug/core-2.0/fix — line 60; backend/ only (single-parent, no frontend delta) |
| `MtB1` | (Mc0, `BtB1'_mono`) | projectB — multi-project: branched from Mc0, merge of shadow/backend/projectB |
| `MtB2` | (MtB1, `FtB1'_mono`) | projectB — multi-project: merge of shadow/frontend/projectB |

### Shadow branches on monorepo (origin)

Populated by `--from b` on lines 26, 34, 54, 66. From the b→a direction, `source.dir = ""` (root), so no path-filter pre-drop — every commit on the source's branches is a candidate.

- `shadow/backend/core-dev`:
  - line 26: `Bc0'` ← `Bc1'` ← `Bc2'` (rooted at `Mc0`).
  - line 34: replay `Bc3 = merge(Bc2, Mc4'_be)` → `Bc3'_mono` = merge `[Bc2', Mc4]` (Mc4'_be → echo Mc4).
  - line 54: replay `Bc4 = merge(Bc3, Mc6'_be<noop>)` → `Bc4'_mono` = merge `[Bc3'_mono, Mc6]` (Mc6'_be<noop> → echo Mc6).
  - Tip = **`Bc4'_mono`**.
- `shadow/backend/core-1.0`: line 26 produced `Bc0'` ← `Bc1'` ← `Br1'`. Never modified after.
- `shadow/backend/project`:
  - line 26: `Bc0'` ← `Bc1'` ← `Br1'` ← `Bt1'`.
  - line 54: replay `Bt2 = merge(Bt1, Br2)` → `Bt2'_mono` = merge `[Bt1', Br2'_mono]` (Br2 mapped in same batch — see core-2.0 below).
  - line 66: replay `Bt3 = merge(Bt2, Bf1)` → `Bt3'_mono` = merge `[Bt2'_mono, Bf1'_mono]`.
  - Tip = **`Bt3'_mono`**.
- `shadow/backend/core-2.0`: line 54 replays `Br2 = merge(Bc4, Mr1'_be)` → `Br2'_mono` = merge `[Bc4'_mono, Mr1]` (Mr1'_be → echo Mr1; Bc4 mapped in same batch). Tip = **`Br2'_mono`**.
- `shadow/backend/bug/core-2.0/fix`: line 66 replays `Bf1 = merge(Bt2, Mf1'_be)` → `Bf1'_mono` = merge `[Bt2'_mono, Mf1]`. Tip = **`Bf1'_mono`**.
- `shadow/frontend/*`: symmetric. Frontend never created `bug/core-2.0/fix`, so `shadow/frontend/bug/core-2.0/fix` does **not** exist on monorepo.
  - `shadow/frontend/core-dev` → **`Fc4'_mono`** = merge `[Fc3'_mono, Mc6]` (after line 54 replay of `Fc4`).
  - `shadow/frontend/core-1.0` → **`Fr1'`** (after line 26).
  - `shadow/frontend/core-2.0` → **`Fr2'_mono`** = merge `[Fc4'_mono, Mr1]` (after line 54).
  - `shadow/frontend/project` → **`Ft2'_mono`** = merge `[Ft1', Fr2'_mono]` (after line 54; `Ft2 = merge(Ft1, Fr2)` per line 53).

### Branches on monorepo at end

- `core-dev` → `Mc6`
- `core-1.0` → (does not exist; monorepo never branched it)
- `core-2.0` → `Mr1`
- `project` → `Mt3`
- `bug/core-2.0/fix` → `Mf1`
- `shadow/backend/core-dev` → `Bc4'_mono`
- `shadow/backend/core-1.0` → `Br1'`
- `shadow/backend/core-2.0` → `Br2'_mono`
- `shadow/backend/project` → `Bt3'_mono`
- `shadow/backend/bug/core-2.0/fix` → `Bf1'_mono`
- `shadow/frontend/core-dev` → `Fc4'_mono`
- `shadow/frontend/core-1.0` → `Fr1'`
- `shadow/frontend/core-2.0` → `Fr2'_mono`
- `shadow/frontend/project` → `Ft2'_mono`

## Notes / assumptions baked in

- A1 (Mc3 scope): **frontend/ only** (single file). This is the test case for the TREESAME-drop rule: Mc3 is dropped on the backend pair (no `Mc3'_be`) but kept on the frontend pair (`Mc3'_fe` exists with parent `Mc2'_fe`).
- A2 (Mc4 scope): touches one file under `backend/`, one file under `frontend/`, AND at least one root file (`README.md` and/or `.claude/...`).
- A3 (Mr1 scope): touches both `backend/` and `frontend/`.
- A4 (Mf1 scope): touches `backend/` only. Single-parent + TREESAME under frontend/ → dropped from frontend pair's replay; `shadow/frontend/bug/core-2.0/fix` has no Mf1 commit (it's at `Mt3'_fe`, same as `shadow/frontend/project`).
- A5 (Mt1's parents): `git merge shadow/backend/project` on monorepo's project at `Mc0` produces a 2-parent merge `(Mc0, Bt1')`. Frontend content doesn't reach the monorepo/project **working branch** until line 58's `git merge shadow/frontend/project` (Mt3). The `shadow/frontend/*` refs on monorepo's origin are populated from line 26 onwards.
- A6 (TREESAME-drop rule): `--full-history -- <source.dir>/` drops **single-parent** commits TREESAME under the path; **merges are kept regardless** (they appear as noop merges if their first-parent tree under the path is unchanged). On `--from b`, `source.dir = ""` so no filter applies.
- A7 (engine bug found while running the test): `composeSubtree` in `shadow-common.ts` calls `git rm -r --cached --ignore-unmatch -- <subdir>` to clear the subdir before `read-tree --prefix=`. Without `-f`, git's safety check rejects the rm when the temp index's content for a file differs from the working tree's content for the same file — even though `--cached` shouldn't touch the working tree. The fix is to add `-f` (i.e., `git rm -rf --cached ...`). This was applied to make the test pass. Triggers any time `composeCrossRepoMergeTree` runs and the orchestrator's working tree has different content than the baseTree being composed (which happens on monorepo whenever a release on a feature branch like core-2.0 modifies a file that main hasn't picked up yet).
- A8 (line 1's git command): `git config set --global init.defaultBranch core-dev` is wrong syntax — should be `git config --global init.defaultBranch core-dev`.
- A9 (BtB1 / FtB1 scope): each adds **one file** under its repo root — `src/projectB.txt = "projB v1\n"`. Distinct path from `project`'s `src/project.txt`, so the two project-shape branches share no path overlap and their shadow chains stay independent.
- A10 (Mt B1 / MtB2 scope): `MtB1 = merge(Mc0, BtB1'_mono)` brings backend/projectB content into a fresh `projectB` branch on monorepo (off Mc0); `MtB2 = merge(MtB1, FtB1'_mono)` adds frontend/projectB content. On the backend pair, `MtB1` is kept (non-TREESAME to Mc0 which has empty be/) and `MtB2` is kept as `<noop-tree>` (TREESAME to MtB1's be/, non-TREESAME to FtB1' which has empty be/). On the frontend pair, `MtB1` is dropped (all-TREESAME, both parents empty fe/) and `MtB2` is kept.
- A11 (BfX1 / fanout): `BfX1` is a single backend commit on `feature/fanout` (forked from `Bc4`) adding `src/fanout.txt = "fanout v1\n"`. It's then merged into three local branches: `Bc5 = merge(Bc4, BfX1)` on core-dev, `Bt4 = merge(Bt3, BfX1)` on project, `BtB2 = merge(BtB1, BfX1)` on projectB. On the next `--from b`, `BfX1` has **exactly one** replay (`BfX1'_mono`) and all three of `Bc5'_mono`, `Bt4'_mono`, `BtB2'_mono` use that same SHA as their second parent — the engine deduplicates BfX1 across the fanout via `shaMapping` within a single replay batch.
