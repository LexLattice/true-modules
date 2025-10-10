# Evidence bindings (how-to)

Bind every claim in your module to at least one **evidence** entry inside `module.json`.

## Types

- **patch** — point to a code change hunk by file, line range, commit hash, and (optional) `patchId`.
- **file** — anchor to a static region of a file when a patch is not applicable (generated code, vendored file).
- **test** — reference to a test spec/case that verifies the claim.

## Examples

### 1) Patch binding
```json
{
  "kind": "patch",
  "file": "src/diff.rs",
  "lines": "40-112",
  "commit": "abc1234",
  "patchId": "patchid:7b2ffb5…",
  "note": "Adds --no-index fallback for untracked files"
}
```

### 2) File binding
```json
{
  "kind": "file",
  "file": "src/normalize.ts",
  "lines": "10-48",
  "note": "Windows path normalization"
}
```

### 3) Test binding
```json
{
  "kind": "test",
  "file": "tests/spec_untracked.json",
  "note": "Untracked diff happy path"
}
```

## Checklist
- [ ] At least one binding per claim in your `report.json`.
- [ ] Lines cover the relevant code (narrow ranges beat entire files).
- [ ] Commits/patchIds filled when available (improves auditability).
