# Composer Duplicate Provider Policy

The scaffold composer refuses plans that select multiple modules for the same
port major unless the plan disambiguates the winner. Provider identity is
normalized to `PortName@major`, so `DiffPort@1.2` and `DiffPort@1` are treated as
`DiffPort@1` when evaluating conflicts.

## Failure scenario

If two modules both provide the same port major and the compose plan omits both
explicit wiring and preferences, `tm compose` aborts with `E_DUP_PROVIDER`:

```
E_DUP_PROVIDER Duplicate providers for DiffPort@1: git.diff.alt, git.diff.core.
Add wiring from orchestrator or constraint prefer:DiffPort@1=git.diff.alt.
```

The same policy is enforced by the TypeScript MVP composer under
`runtimes/ts/composer`.

## Packaging smoke

Pass `--npm-pack` to `tm gates shipping` to run a lightweight packaging smoke
test after the shipping gates succeed:

```bash
node tm.mjs gates shipping --compose examples/compose.greedy.json \
  --modules-root examples/modules --npm-pack
```

- The TypeScript composer now writes `winner/package.json` using the compose
  `run_id` to derive a unique name and pre-release version.
- When `--npm-pack` is set, the gates invoke `npm pack` inside the winner
  workspace, capture the emitted tarball name, and immediately delete the
  archive so it does not pollute the working tree.
- If `npm` is unavailable on the host, gates emit a warning and mark the smoke
  check as skipped instead of failing the run.
- Failures bubble up as `GATES_FAIL` events with `error: "npm_pack_failed"` and
  the first few diagnostics from `npm`.

## Resolving conflicts

You can disambiguate by wiring the orchestrator to the desired provider:

```jsonc
{
  "wiring": [
    { "from": "git.diff.core:DiffPort", "to": "orchestrator:DiffPort" }
  ]
}
```

Alternatively, add a constraint declaring the preferred provider. Both string
and structured forms are supported:

```jsonc
{
  "constraints": [
    "prefer:DiffPort@1=git.diff.core",
    { "preferred_providers": { "DiffPort@1": "git.diff.core" } }
  ]
}
```

Preferences that target ports absent from the plan exit with `E_PREFER_UNSAT`.
When a preference wins but other modules still provide the port, the composer
emits a warning so you can clean up unused modules.

## Explain output

Run `tm compose --explain` to see the deterministic resolution for every port:

```json
[
  {
    "port": "DiffPort@1",
    "provider": "git.diff.core",
    "reason": "wired",
    "candidates": ["git.diff.alt", "git.diff.core"]
  }
]
```

`reason` is `wired`, `preferred`, or `sole`, indicating whether the provider was
chosen by wiring, by preference, or because it was the only option.
