# ADR-001: Ports@1 — True Modules Core Interfaces

- **Status:** Accepted
- **Date:** 2025-10-10
- **Decision:** Freeze v1 of the core ports and their behavioral contracts.
- **Scope:** `DiffPort@1`, `IndexPort@1`, `WorktreePort@1`, `SafetyPort@1`
- **Change policy:** SemVer. Any signature or behavioral breaking change requires `@2` and coexistence via adapters.

## 1. Port intents & contracts

### DiffPort@1
Intent: unified diff across tracked files, with optional untracked fallback (`--no-index`).  
Invariants: deterministic; read-only FS; may call `git`.

### IndexPort@1
Intent: stage/unstage/add/reset with explicit conflict handling.  
Invariants: idempotent for effect-free calls; may write FS; may call `git`.

### WorktreePort@1
Intent: ephemeral worktree create/cleanup with guarantees.  
Invariants: conservative FS writes; cleanup on error.

### SafetyPort@1
Intent: path normalization + guardrails (Windows/WSL quirks).  
Invariants: no network; no external processes.

## 2. Import discipline
- Orchestrator → ports only.
- Modules → ports only.
- Glue → ports + modules (no business logic).

## 3. Evidence expectations
Back every claim with at least one binding: patch/file/test.
