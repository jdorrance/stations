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

## Documentation owners

| Doc | Owns |
| --- | --- |
| [README.md](README.md) | Product purpose, quick start, doc index, checks |
| [docs/toolkit.md](docs/toolkit.md) | Package map and compositions |
| [docs/toolkit-serving.md](docs/toolkit-serving.md) | HTTP routes, credentials, cache, batching, deploy |
| [docs/toolkit-contracts.md](docs/toolkit-contracts.md) | Units, absence, freshness, terminology |
| [docs/toolkit-development.md](docs/toolkit-development.md) | Providers, crawl, explorer, verify |
| `packages/*/README.md` | Package purpose, snippet, ownership, next-layer links |
| [packages/providers/docs/transport.md](packages/providers/docs/transport.md) | Retry and rate-limit internals |

Do not copy catalogue counts, route tables or unit rules across layers — link
to the owning doc (or `data/catalogue/manifest.json` for live counts).
