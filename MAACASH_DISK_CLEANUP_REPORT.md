# MaaCash Disk Cleanup Report

**Date:** 2026-11-28
**Scope:** temporary files and disposable worktrees created by the Susu Phases 1–9 development programme, inside the MaaCash project directory only.
**Preconditions met:** the Phase 1–9 release is pushed, merged (`18e4262`) and live; all defect-fix work is committed on the preserved local branch `fix/maacash-dashboard-access-2026-11-27`.

---

## 1. What was removed

### 1.1 Worktrees (11)

Each removal followed the required procedure: the branch tip was verified
reachable from the released `origin/main` history (`git merge-base --is-ancestor`
→ REACHABLE for all 11 branches), tracked/untracked status was inspected (only
disposable `.tmp-*` logs, no uncommitted user changes), and the exact worktree
was removed with `git worktree remove` after its `.tmp-*` files were deleted.
**Every branch itself was kept** — only the working directories were freed.

| Worktree | Branch (kept) | Reachable from released main | Notes |
|---|---|---|---|
| `BloomCore-One-phase-2` | `feat/susu-enterprise-phase-2-collector-operations` | ✓ | 1.1 GB measured (own node_modules) |
| `BloomCore-One-phase-3` | `feat/susu-enterprise-phase-3-remittance-lifecycle` | ✓ | 26 MB; shared node_modules via symlink |
| `BloomCore-One-phase-4` | `feat/susu-enterprise-phase-4-withdrawal-controls` | ✓ | 764 MB measured (own node_modules) |
| `BloomCore-One-phase-5` | `feat/susu-enterprise-phase-5-reconciliation` | ✓ | |
| `BloomCore-One-phase-6` | `feat/susu-enterprise-phase-6-reporting` | ✓ | shared node_modules via symlink |
| `BloomCore-One-phase-7` | `feat/susu-enterprise-phase-7-customer-onboarding` | ✓ | shared node_modules via symlink + 196 KB partial install |
| `BloomCore-One-susu-integration` | `feat/susu-enterprise-phases-1-3-integration` | ✓ | |
| `BloomCore-One-susu-phases-1-7-integration` | `feat/susu-enterprise-phases-1-7-integration` | ✓ | |
| `BloomCore-One-susu-phase-8` | `feat/susu-enterprise-phase-8-admin-support` | ✓ | |
| `BloomCore-One-susu-phases-1-9-verification` | `feat/susu-enterprise-phases-1-9-verification` | ✓ | hosted the Phase 9 verification gate |
| `BloomCore-One-susu-release` | `release/maacash-susu-enterprise-2026-11-27` | ✓ | merged via PR #68; PR body/tmp files removed with it |

Four worktree directories initially retained only a leftover `node_modules`
symlink into the primary worktree (the phase worktrees shared dependencies);
those symlinks and the empty shells were removed as well.

### 1.2 Temporary log files

| Location | Item | Size | Why disposable |
|---|---|---|---|
| `BloomCore-One` (primary) | 88 `.tmp-*.log` test-run logs | ~2.9 MB | regenerable test output; the evidence is recorded in the committed phase/verification reports |
| `BloomCore-One-susu-release` | `.tmp-drift-check.txt`, `.tmp-pr-body.md`, `.tmp-release-gate-run*.log` | ~10 KB | PR #68 body lives in GitHub; gate numbers recorded in reports |
| `.tmp-*` files inside removed worktrees | removed together with each worktree | — | same rationale |

### 1.3 Space recovered

- **Measured directly:** ≥ **1.89 GB** (phase-2 1.1 GB + phase-4 764 MB + phase-3 26 MB + logs).
- The remaining eight removed worktrees were not individually measured before
  deletion; each carried `node_modules` (installed for their gates/builds) and,
  for the verification and release worktrees, full Next.js production builds —
  so the total recovery is substantially larger than the measured floor.
- **Post-cleanup totals (measured):** `BloomCore-One` 2.0 GB,
  `BloomCore-One-susu-dashboard-fixes` 1.9 GB, `BloomCore-One-zeli` 89 MB —
  approximately **4.0 GB remain** across the three preserved directories;
  everything else the programme created has been freed.
- After cleanup exactly three directories remain in the project folder:
  `BloomCore-One` (primary), `BloomCore-One-susu-dashboard-fixes` (active
  defect-fix worktree), `BloomCore-One-zeli` (the `main` checkout).

## 2. What was deliberately preserved

| Item | Reason |
|---|---|
| `BloomCore-One` primary worktree | required by the task; pre-existing checkout on `fix/public-signin-role-chooser` untouched |
| `BloomCore-One-susu-dashboard-fixes` | active defect-fix worktree; its `.tmp-*` gate logs kept as run evidence for the pending second release |
| `BloomCore-One-zeli` (checkout of `main`) | separate product work; untouched |
| `stash@{0}` ("pre-existing evidence png changes") | pre-existing user stash — never touched |
| `docs/testing/testing report.zip`, `tests/local-load-artifacts/`, `tests/local-load-identities.json`, `tests/local-retention-evidence.json`, `tests/pg-load-artifacts/`, `tests/pg-load-identities.json` | user work / load-test evidence in the primary worktree |
| All 11 local branches | branches are history, not disk cost; the task forbids deleting branches to save space |
| `AppData/Local/Temp/bc-118` (detached-HEAD worktree) | purpose/ownership not certain — left untouched and reported |
| `.tmp-lawyer.txt`, `.tmp-memo.txt`, `.tmp-dpo.txt`, docx scratch files and `.secrets/` in the workspace root | user legal/governance work and credentials — outside the repository, never touched |
| Root-level `build.log`, `server-e2e.log`, `test-e2e*.log` (dated Nov 8, outside any repo) | ownership predates the current worktree structure — left untouched and reported |
| The `nul` file in the primary worktree (54 bytes) | Windows reserved-name artifact; left in place rather than risk a reserved-name deletion |
| Docker containers (`maacash-int-pg16`, `maacash-phase7-pg`, `bloomcore-phase5-pg`, `maacash-remediation-pg18`) | disposable PostgreSQL test containers owned by the test environment — not removed; removing them (and any unknown volume) is explicitly out of scope without separate confirmation |

## 3. What was NOT done

- No `git clean -fdx`, no recursive deletion inside any repository.
- No branch, stash, tag or commit deletion.
- No database files, backups, migrations, credentials, environment files or
  user documents deleted.
- No Docker containers, images or volumes removed.
- `MAACASH_DISK_CLEANUP_REPORT.md` (this file) and the remediation report were
  added — nothing else was written outside the two report files.
