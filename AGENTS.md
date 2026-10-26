# Layered complexity

Use progressive disclosure throughout this repository: a small outer contract,
then deeper detail when needed. Apply this to code, types, docs, tests, commands
and UI.

- Start with purpose, inputs, outputs and ownership. Link to the next layer.
- Read the nearest README and public types before implementation files.
- Keep entry points small and explicit. Expose what consumers use; keep helpers private.
- Keep required units, references, absence, errors and lifecycle obligations at
  the boundary. Put algorithms, provenance and troubleshooting deeper.
- Give each fact one owner. Generate signatures from code; link to details
  instead of copying them across layers.
- Keep primary UI decisions visible. Reveal explanation and diagnostics on demand;
  keep errors, stale-data notices and immediate limits visible.
- Extract around a distinct responsibility. Add a layer only when it reduces
  what a caller must understand. Prefer direct code over forwarding scaffolding.
- Preserve public contracts and observation semantics during structural edits.
  Validate changes with the [root checks](README.md#development-checks).
