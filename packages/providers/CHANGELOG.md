# Changelog

## Unreleased

- Split New Zealand providers by ownership (`wmo-nz`, `hilltop`, `ecan`, `zephyr`); stop inventing WMO regional labels and empty Zephyr conditions; parse Hilltop timestamps in council local time; omit Hilltop from default discovery while GetData is unreachable; Chatham Islands get `Pacific/Chatham` via `defaultTimeZoneForPoint`.
- Correct New Zealand WMO regional-council overrides, and reject Ogimet reports whose wind-unit indicator is missing or whose speed is the `ff=99` sentinel without an `00fff` group.
- Add shared origin rate limits, bounded transient GET/HEAD retries with jitter, `Retry-After` cooldowns, queue limits and cancellation through `createProviderFetch`.

- Validate source timestamps, wind measurements, station identities, and provider pagination instead of publishing fabricated or mismatched observations.
- Isolate authenticated observation caches and constrain WeatherLink cookie requests to the configured HTTPS origin.
- Preserve aliases across discovery and HTTP routes; apply spatial filters before limiting results and validate GeoJSON feed requests consistently.
- Separate private discovery locators from public catalogue exports and document provider-specific configuration requirements.

## 0.1.0

- Add New Zealand coverage: Ogimet `wmo_nz` SYNOP, council `hilltop`, Environment Canterbury `ecan`, and Zephyr aggregator fallback, plus NZ country hints for WeatherLink, Wunderground, CWOP and WindGuru.
- Initial release with multi-vendor station discovery, live observation adapters, curated North America + Armenia seed stations, and mountable HTTP handler.
