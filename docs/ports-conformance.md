# Ports conformance

Modules that declare `provides: ["<Port>@<version>"]` must export an implementation that satisfies the corresponding TypeScript interface. To make this check deterministic:

1. Add a `port_exports` section to your `module.json`, mapping each provided port to the file and export name:
   ```json
   "port_exports": {
     "DiffPort@1": { "file": "src/index.ts", "export": "diffPort" }
   }
   ```
2. Ensure the referenced file exports a symbol that matches the declared port interface from `runtimes/ts/ports`.
3. Run `node tm.mjs gates shipping --emit-events ...`; the gate generates temporary harnesses that type-check your exports with `tsc --noEmit`.
4. On failure, inspect the emitted `port_conformance_failed` diagnostics and update your implementation or mapping. Full compiler output is written to `winner/.tm/tsc.log`.

## Interface mapping

Current port versions map to interface names as follows:

| Manifest value | Interface |
| -------------- | --------- |
| `DiffPort@1`   | `DiffPort` |
| `IndexPort@1`  | `IndexPort` |
| `WorktreePort@1` | `WorktreePort` |
| `SafetyPort@1` | `SafetyPort` |

Future versions append `V<version>` (e.g., `DiffPort@2` → `DiffPortV2`).

## Troubleshooting

- `port_exports` missing: gates emit a warning and attempt a default export; add explicit mappings to silence the warning.
- Missing file/export: shipping gates fail with `port_export_not_found`. Fix the `file` or `export` entry.
- Type mismatch: gates fail with `port_conformance_failed`; update your implementation to satisfy the interface or adjust the interface version.
