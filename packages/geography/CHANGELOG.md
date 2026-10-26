# Changelog

## Unreleased

- Correct global, antimeridian, polar, and radius queries; bound sparse-grid traversal for large searches.
- Preserve exact tile bounds and reject invalid spatial parameters.
- Require explicit supported country metadata for country assignment; coverage rectangles remain coarse discovery filters.

## 0.1.0

- Initial release with position/bounds validation, `US`/`CA`/`MX`/`AM` regional coverages, and grid spatial index.
