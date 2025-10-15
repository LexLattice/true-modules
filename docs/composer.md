# Composer Duplicate Provider Policy

The scaffold composer refuses plans that select multiple modules for the same
port major unless the plan disambiguates the winner. Provider identity is
normalized to `PortName@major`, so `DiffPort@1.2` and `DiffPort@1` are treated as
`DiffPort@1` when evaluating conflicts. When a plan includes multiple majors for
the same port (for example `DiffPort@1` and `DiffPort@2`), the composer now
expects a policy that selects a single major. Wiring the orchestrator to the
desired provider or adding a `preferred_providers` entry with the specific
`Port@major` satisfies the requirement. Without an explicit choice the CLI and
TypeScript composer exit with `E_PORT_VERSION_AMBIG`.

## Failure scenarios

If two modules both provide the same port major and the compose plan omits both
explicit wiring and preferences, `tm compose` aborts with `E_DUP_PROVIDER`:

```
E_DUP_PROVIDER Duplicate providers for DiffPort@1: git.diff.alt, git.diff.core.
Add wiring from orchestrator or constraint prefer:DiffPort@1=git.diff.alt.
```

When multiple majors exist and no rule narrows the plan to one of them, the
composer exits with `E_PORT_VERSION_AMBIG`:

```
E_PORT_VERSION_AMBIG Multiple majors for DiffPort: DiffPort@1, DiffPort@2. Add orchestrator wiring or preferred_providers entry targeting the desired major.
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
  workspace, copy the tarball to `artifacts/winner.tgz`, and remove the
  temporary archive so the workspace stays clean.
- Every run appends to `artifacts/npm-pack.log`; use the log to debug skips,
  failures, and the generated tarball metadata.
- If `npm` is unavailable on the host, gates emit a warning and mark the smoke
  check as skipped instead of failing the run.
- Failures bubble up as `GATES_FAIL` events with `error: "E_NPM_PACK"`, a
  pointer to `artifacts/npm-pack.log`, and the first few diagnostics from `npm`
  (parse errors surface as `cause: "E_SUMMARY_PARSE"`).

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
  },
  {
    "port": "DiffPort@2",
    "provider": null,
    "reason": "inactive",
    "candidates": ["git.diff.next"]
  }
]
```

`reason` is `wired`, `preferred`, `sole`, or `inactive`, indicating whether the
provider was chosen by wiring, by preference, because it was the only option, or
because another major won the negotiation. `inactive` entries remain in the
explain output so you can see which majors were suppressed.

## Overrides

Pass `--overrides <file>` to apply a JSON patch on top of the generated
`compose.json` without editing the original plan. Override files may adjust
modules, wiring, and constraints:

```bash
node tm.mjs compose \
  --compose examples/compose.overrides/compose.json \
  --modules-root examples/modules \
  --overrides examples/compose.overrides/overrides.json \
  --out examples/winner
```

- `modules[]` entries use `id` as the key. Provide a replacement object to swap
  an existing module (e.g. bumping `version`) or append new modules to the plan.
  To drop a module, include the string `"-module.id"`.
- `wiring[]` treats `{from,to}` pairs as the key. Supply a matching object with
  updated metadata to replace an existing edge, append new edges, or mark an
  entry with `{ "remove": true }` to drop it.
- `constraints[]` starts from the base list. New unique strings append to the
  end; prefix with `-` to remove a constraint.

The fixture under `examples/compose.overrides/` demonstrates replacing the core
diff provider with `git.diff.alt`, adding `git.index.controller`, and wiring the
new modules together. Compare the override file with the resulting
`examples/compose.overrides/plan.json` to see the deterministic ordering
(modules sorted by id, wiring sorted by `{from,to}`) and the constraint removal
(`ports-only-coupling`) paired with a new preference.

Override activity emits a `COMPOSE_OVERRIDES_APPLIED` event (use
`--emit-events --strict-events` to validate against `tm-events@1`). The event
payload highlights additions, replacements, removals, and the override file
used. Winner reports inherit the merged plan; the resulting
`examples/winner/report.json` aligns with `plan.json`, ensuring the BO4 winner
reflects the override choices.
