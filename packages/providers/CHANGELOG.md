# Changelog

## Unreleased

- Add shared origin rate limits, bounded transient GET/HEAD retries with jitter, `Retry-After` cooldowns, queue limits and cancellation through `createProviderFetch`.

- Validate source timestamps, wind measurements, station identities, and provider pagination instead of publishing fabricated or mismatched observations.
- Isolate authenticated observation caches and constrain WeatherLink cookie requests to the configured HTTPS origin.
- Preserve aliases across discovery and HTTP routes; apply spatial filters before limiting results and validate GeoJSON feed requests consistently.
- Separate private discovery locators from public catalogue exports and document provider-specific configuration requirements.

## 0.1.0

- Initial release with multi-vendor station discovery, live observation adapters, curated North America + Armenia seed stations, and mountable HTTP handler.
