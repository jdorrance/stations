# XCTrack widget review

## Implementation update — 27 October 2026

The correctness and reliability fixes are implemented. At the user's request,
the original **tile-only interface, icons, colors, geometry, layout, and intentional
fading are preserved**. `web/xct.css` and `web/xct.html` match the pass-3 snapshot
byte for byte. There is no units/count header, detail panel, warning icon, or
added scrolling UI.

- **Fixed:** F01–F03, F05–F07, F10, F12–F14, F16, F18. Invalid/stalled GPS expires;
  losing position clears tiles; observation age advances from server time;
  nearby discovery refills past unavailable candidates; catalogue categories and
  `altGps` are used; absent direction and positive gust formatting preserve their
  meaning; empty results finish loading; setup inputs are validated; the browser
  entry is type-checked and production assets are minified.
- **Partially fixed:** F04. Initial failures are distinct from empty results, and
  partial failures preserve last good readings with their original age anchors.
  Retained-reading failures are described in the existing title/accessibility
  text. Persistent visible banners and per-tile warning styling were removed
  with the UX rollback, so the visibility portion remains open.
- **Visual findings remain open after the requested rollback:** F08, F09, F11,
  F17, F19. The existing age-chip contrast fix F15 remains intact.
- **Additional reliability:** explicit URL coordinates override GPS; missing
  altitude clears the previous value; successful refresh cancels pending retries;
  position/age rendering continues independently of slow requests; unchanged
  SVGs are retained instead of reparsed every second.

Validation: **`pnpm verify` passed all 171 tests**, including strict browser types,
package/API checks, and the independent packed consumer. The final web build
passed. Chromium verified 30 tiles, original colors and arrow points, no added
UI, stable SVG node identity across timer updates, and no application JavaScript
errors. Actual XCTrack/Android device validation remains outstanding.

Operational limits: native/browser fixes expire after 30 seconds; discovery
checks at most 90 nearby candidates per cycle. A limited search with no usable
tiles is reported in the existing empty state. Remaining visual issues are
recorded above rather than represented as fixed.

The review below is the **pre-fix evidence**, retained for traceability. Its line
links and fingerprints describe that earlier snapshot and can differ from the
implementation now in this checkout.

## Pre-fix review

Re-reviewed **27 October 2026, pass 3** against the latest saved **774-line** `web/xct.ts`, **318-line** CSS, setup page, and the supplied screenshot. This pass focused on the revised dial, station-bearing orbit, wind bands, fixed age-chip palettes, and gust formatting. No application code was changed by this review.

**Pre-fix result: 18 open findings — 5 P1, 10 P2, and 3 P3; one resolved finding.** **F15 (age-chip contrast) is fixed. F17–F19 are new.** F08 remains partially addressed. The five high-priority location/data issues remain unchanged. IDs are preserved across passes; resolved findings are separated below.

**Intentional fading is accepted design.** It is not counted as a defect. F11 concerns live, fully opaque readings only. The new fixed age-chip pairs are readable, and wind/bearing direction calculations match their documented conventions. The desktop screenshot does not expose the narrow-widget layout failure or every wind direction/value combination, so those were tested separately.

Priority meanings: **P1** = fix before flight-deck use; **P2** = material correctness, usability, or regression risk; **P3** = lower-impact formatting, optimization, or input hardening. I would address F01–F05 before relying on the widget in flight. No application JavaScript exception was observed in this pass's browser probes; the actual Android/XCTrack WebView remains untested.

## Prioritized findings

### F01 — P1: Losing position freezes previously live readings indefinitely

**Location:** [xct.ts:677](/Users/johndorrance/projects/flying/stations/web/xct.ts:677), `updateView`, lines 677–679.

When `myPosition` becomes null, rendering returns before recalculating age, applying `maxage`, or removing existing tiles. The page displays “wait for position,” but old speeds, distances, freshness classes, and titles remain intact. This is distinct from F02: even a correctly detected loss of location leaves the observations misleading.

**Reproduced:** load 30 fresh stations, make `XCTrack.getLocation()` return `null`, advance the client clock three hours, and call `updateView()`. All 30 tiles remain; the first still says **“live · 1 min ago”**, despite the default two-hour expiry. Reproduced again in pass 2: **none of the 30 tiles gains an age chip**, so the newly documented “no chip means live” indication also freezes.

**Recommendation:** age observations independently of position acquisition. On fix loss, clear tiles or retain them with an explicit unusable-position state and suppress current bearing/distance. Test valid fix → no fix → expiry → recovered fix, including the warning and every retained tile.

### F02 — P1: Invalid or stale GPS fixes continue to drive “nearby” results

**Locations:** [xct.ts:256](/Users/johndorrance/projects/flying/stations/web/xct.ts:256), lines 256–275; [xct.ts:358](/Users/johndorrance/projects/flying/stations/web/xct.ts:358), lines 358–365.

The native bridge accepts any finite numeric coordinates without checking `isValid`, fix time, or coordinate bounds. XCTrack publishes `isValid` and `time` in its [documented JavaScript interface](https://xctrack.org/JavaScriptInterface.html). The browser fallback also ignores every geolocation error after the first fix, retaining that position without expiry or a warning.

**Reproduced:** a native payload with `isValid: false` and an old timestamp still triggers a feed request. Separately, after a successful browser GPS callback, a position-unavailable error leaves `geoError: null`; subsequent requests continue using the old coordinates.

**Impact:** refreshed weather can appear current while station order, distance, bearing, and the search area are tied to an obsolete pilot location.

**Recommendation:** maintain a validated, timestamped fix with explicit valid/stale/unavailable states for both providers. Handle errors after acquisition and validate native coordinate ranges. Test invalid native fixes, expired fixes, permission revocation, timeout, and recovery. Establish the bridge timestamp format before implementing expiry.

### F03 — P1: Device clock errors turn stale observations into live data

**Locations:** [xct.ts:505](/Users/johndorrance/projects/flying/stations/web/xct.ts:505), lines 505–530; [xct.ts:746](/Users/johndorrance/projects/flying/stations/web/xct.ts:746), lines 746–749.

The feed's real `servedAt` is discarded. `buildTileModels()` substitutes the current device clock as the server timestamp and resets the receipt time on every render. The displayed age and hard expiry also use the device clock directly. This bypasses the shared contract's protection against clock skew.

**Reproduced:** server time 12:00, observation 11:15, device time 10:00. The shared helper with the real server anchor reports **stale**; the widget reports **live, age zero**. With device time 14:00, the same observation is treated as 165 minutes old and removed.

**Recommendation:** retain the response's server timestamp and client receipt time, then advance age using elapsed time. Use one anchored age calculation for freshness, labels, and `maxage`. Test fast/slow clocks and later renders of a retained response.

### F04 — P1: Feed failures have no visible error state

**Locations:** [xct.ts:236](/Users/johndorrance/projects/flying/stations/web/xct.ts:236), lines 236–238; [xct.ts:740](/Users/johndorrance/projects/flying/stations/web/xct.ts:740), lines 740–754; [xct.ts:697](/Users/johndorrance/projects/flying/stations/web/xct.ts:697), lines 697–704.

`setOnlineState(false)` only writes a body data attribute; neither the stylesheet nor rendered UI consumes it. Retained tiles hide the empty-state message. On an initial request failure, the message becomes “no recent wind nearby,” which incorrectly resembles a successful search result.

**Reproduced:** after a successful feed, make fetch reject. State becomes offline, but the warning is hidden and the prior tiles remain visually unchanged apart from ordinary observation aging.

There is a related partial-failure problem: an HTTP-200 feed containing an unavailable station replaces its last good observation, removes its tile, and marks the feed online. The station's failure reason is never shown.

**Recommendation:** visibly distinguish loading, successful empty results, request failure, and partial provider failure. Show last successful refresh and mark retained data accordingly. Test network, HTTP, timeout, parse, and per-station failures, both before and after a successful response.

### F05 — P1: Thirty unusable candidates can permanently hide fresh nearby wind

**Locations:** [xct.ts:732](/Users/johndorrance/projects/flying/stations/web/xct.ts:732), lines 732–736; [xct.ts:510](/Users/johndorrance/projects/flying/stations/web/xct.ts:510), lines 510–516; [handler.ts:510](/Users/johndorrance/projects/flying/stations/packages/providers/src/handler.ts:510), with the feed cap at line 547.

The requested limit applies to nearest catalogue candidates **before** availability and reading age are known. The widget then drops unavailable/expired stations without replacing them. Every retry selects the same candidates. Dense stale stations or a network missing credentials can crowd out every usable station.

**Reproduced against the real API handler:** 30 unavailable stations within 3.34 km plus a fresh station at 4.45 km. The widget's query returns 30 unavailable stations; directly requesting the omitted station returns an `ok` reading. The UI can therefore say “no recent wind nearby” when fresh wind is available nearby.

**Recommendation:** separate candidate discovery capacity from visible tile capacity and implement bounded refill or availability-aware selection. Both local and production handlers cap feeds at 30, so increasing the client limit alone is insufficient. Keep request budgets bounded and expose incomplete coverage. Add the 31-station regression case.

### F06 — P2: The XCTrack altitude field is never read

**Locations:** [xct.ts:256](/Users/johndorrance/projects/flying/stations/web/xct.ts:256), lines 256–274; [xct.ts:492](/Users/johndorrance/projects/flying/stations/web/xct.ts:492), lines 492–498.

The bridge parser checks `alt`, `altitude`, and `elevation`; XCTrack documents **`altGps`**. Native pilot altitude therefore remains unknown and peak/valley classification uses the absolute-elevation fallback. A later missing altitude also retains a previous value indefinitely in both location paths.

**Reproduced:** a valid native fix with `altGps: 2500` leaves `myAltitudeM` null and labels an 1800 m station `peak`; the existing relative-altitude rule would classify it `valley`.

**Recommendation:** consume the actual bridge field after confirming its altitude reference and units. Define how missing or stale altitude invalidates the previous value. Test native GPS altitude, absent altitude, browser altitude becoming null, and the configured URL override. Source: [XCTrack interface](https://xctrack.org/JavaScriptInterface.html).

### F07 — P2: Vendor inference loses the catalogue's real station category

**Locations:** [xct.ts:481](/Users/johndorrance/projects/flying/stations/web/xct.ts:481), lines 481–483; [xct.ts:523](/Users/johndorrance/projects/flying/stations/web/xct.ts:523), lines 523–545.

The server filters by the catalogue's category, but the widget reconstructs category from the vendor UID. Curated categories can differ from vendor defaults, changing both freshness thresholds and the unknown-elevation terrain fallback.

**Verified with a real catalogue entry:** `weatherlink:00f36029-437f-4b9d-95c1-81bdfa781fbe`, Corbett Vista House, is `freeflight`. The widget treats it as `pws`; a 20-minute reading is shown as **aging** instead of **stale**, and its unknown-elevation fallback changes from peak to valley.

**Recommendation:** preserve authoritative category metadata through the client boundary or retrieve the relevant catalogue metadata. The wire `Station` currently does not carry category, so this needs a deliberate boundary change. Test a category override independently of the vendor default.

### F08 — P2, partially addressed: Units and secondary details still require hover

**Locations:** [xct.ts:619](/Users/johndorrance/projects/flying/stations/web/xct.ts:619), lines 619–660; [xct.css:167](/Users/johndorrance/projects/flying/stations/web/xct.css:167), lines 167–185.

**Improved:** aging/stale readings now show a compact age chip. Stale readings have an outline arrow and dashed ring, so freshness is no longer represented only by color. The setup page explains these symbols.

**Still open:** visible wind numbers have no speed-unit label; the same number can mean km/h, mph, knots, or m/s. Full truncated names, elevation, direction detail, and live-reading age still depend on `title`. Tiles remain plain divs without a tap or keyboard detail action, and the dial SVG is `aria-hidden`. The chip reduces the space available for aging station names. Station bearing is now encoded by the outer arc; its compass text remains available only in the title.

Native title tooltips are not a dependable touch/keyboard interface; [MDN documents those limitations](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Global_attributes/title#accessibility_concerns). A separate setup explanation does not reveal the selected unit or hidden station details on the flight deck.

**Recommendation:** retain the age/stale improvements, keep the selected speed unit visible, and provide a large tap/focus target for secondary details with an explicit accessible label. Verify unit modes, long names, touch, keyboard, and grayscale rendering.

### F09 — P2: Small viewports silently cut off station tiles

**Locations:** [xct.css:32](/Users/johndorrance/projects/flying/stations/web/xct.css:32), lines 32–49; [xct.ts:686](/Users/johndorrance/projects/flying/stations/web/xct.ts:686), lines 686–690.

The page and list both hide overflow, while all selected tiles are appended without fitting complete rows, scrolling, paging, or a hidden-count indicator.

**Reproduced on the latest saved styles at 320 × 160 CSS pixels:** 30 tiles exist, but only **3 are fully visible**, **3 are partially cut off**, and **24 are entirely hidden**. Increasing `size` reduces visible capacity further. The user cannot reveal the remaining stations through the widget.

**Recommendation:** fit complete tiles to the available widget area and show how many remain, or provide deliberate paging/scrolling. Test narrow, shallow, portrait, landscape, enlarged-size, and resized layouts; include footer visibility in the assertions.

### F10 — P2: Missing wind direction is incorrectly described as calm

**Locations:** [xct.ts:656](/Users/johndorrance/projects/flying/stations/web/xct.ts:656), lines 656–659; dial direction handling at [xct.ts:438](/Users/johndorrance/projects/flying/stations/web/xct.ts:438).

The condition combines actual calm with `windDirectionDeg === null`. The [observation contract](/Users/johndorrance/projects/flying/stations/docs/toolkit-contracts.md) explicitly allows null direction on a blowing reading to mean a missing or unserviceable vane.

**Reproduced:** 12 m/s and null direction yields a title beginning **“calm 43/… km/h”** while the wind band is `trim`. The dial has no arrow but does not identify the unavailable direction.

**Recommendation:** classify calm from speed only; represent non-calm/null direction as “direction unavailable.” Test real calm, a dead vane in strong wind, and valid cardinal directions separately.

### F11 — P2: Live wind numbers still have low contrast in the light theme

**Locations:** [xct.css:18](/Users/johndorrance/projects/flying/stations/web/xct.css:18), wind colors; [xct.css:78](/Users/johndorrance/projects/flying/stations/web/xct.css:78), mountain background; [xct.css:245](/Users/johndorrance/projects/flying/stations/web/xct.css:245), numeric text styling.

The palette and type size changed, but some live wind colors still lack contrast at full opacity. The deliberate fading of older readings is outside this finding's scope.

**Calculated using the new palette:** `fresh` orange (`#e08a00`) has **2.28:1** contrast against the plain tile and **1.58:1** over the mountain silhouette. `active` gold has **3.23:1 / 2.23:1**, and `strong` orange **3.53:1 / 2.44:1**. At the default 57 px dial, average text is approximately **19.6 px bold**, qualifying for the 3:1 large-text criterion; gust text is approximately **13.7 px**, requiring 4.5:1. The fresh average and all these gust colors fall short of their respective [contrast criteria](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html). Actual sunlight legibility was not tested.

**Recommendation:** improve the base palette or numeric background for live readings while preserving the intended fading and band distinctions. Test each wind band against both terrain backgrounds.

### F12 — P2: A successful empty result remains “wait for data” forever

**Location:** [xct.ts:697](/Users/johndorrance/projects/flying/stations/web/xct.ts:697), lines 697–701.

An empty successful response sets `feedOnline` true and leaves `liveByUid.size` zero. Because the loading branch accepts anything except false, every subsequent render says “wait for data,” even though the request has completed normally.

**Reproduced:** return a valid HTTP-200 feed with `stations: []`; state is online and the message remains “wait for data.” The pilot cannot distinguish loading from a completed search with no catalogue matches.

**Recommendation:** model initial loading separately from successful empty results. Test initial loading, successful empty feed, all stations filtered out, and request failure as distinct states.

### F13 — P2: The normal verification gate does not exercise the widget

**Locations:** [package.json:17](/Users/johndorrance/projects/flying/stations/package.json:17); [build-web.mjs:17](/Users/johndorrance/projects/flying/stations/scripts/build-web.mjs:17); [explorer.test.mjs:59](/Users/johndorrance/projects/flying/stations/scripts/test/explorer.test.mjs:59).

The existing XCT integration assertions check HTML strings; the new setup-page assertions likewise check markup and parameter headings rather than executing its controls. Package/Worker checks do not type-check this browser entry, and esbuild bundling is not a type check. GPS transitions, request failures, expiry, layout, and rendering can all regress while the root gate is green—as this review demonstrates.

**Validation:** all 135 root tests passed in the previous pass. The latest saved entry also passed a temporary strict browser-only TypeScript check in this pass. A check that includes ambient Node types instead reports `number` versus `Timeout` at line 716 because the timer variable uses global `setTimeout` while assignment uses `window.setTimeout`; this is a configuration/type issue, not a demonstrated JavaScript crash.

**Recommendation:** add a dedicated browser TypeScript configuration to the gate and focused deterministic browser tests for F01–F12. Preserve the server-level starvation regression as well. These tests should assert visible behavior, not only internal flags or HTML presence.

### F17 — P2, new: Narrow tiles place the station-bearing circle inside the wind circle

**Locations:** [xct.css:64](/Users/johndorrance/projects/flying/stations/web/xct.css:64), fixed width/height and shrink behavior; [xct.css:144](/Users/johndorrance/projects/flying/stations/web/xct.css:144), orbit sizing; [xct.css:188](/Users/johndorrance/projects/flying/stations/web/xct.css:188), dial sizing.

Flex layout can shrink a tile's width while leaving its height fixed. The full-tile orbit SVG and the wind SVG then scale independently. This breaks the new visual contract that the station-bearing mark is outside the wind rose. It is separate from F09's inaccessible rows: an individual visible tile can have incorrect ring placement.

**Reproduced using rendered SVG transforms:** at normal size, the place radius is **28 px** and the wind radius **23.75 px**. In an **80 px-wide widget**, the tile shrinks to 70 × 84, leaving only 24.5 px versus 23.75 px, so the ring strokes crowd together. At **60 px**, the tile becomes 50 × 84 and the place radius is **17.5 px**, inside the **20.83 px** wind circle. A 100 px-wide widget with supported `size=100` also reproduces the inversion and truncates the enlarged distance footer.

**Recommendation:** scale the complete tile proportionally, or enforce a minimum tile width and handle insufficient space explicitly. Test the minimum widget width for each supported size, asserting that the bearing orbit remains outside the wind circle and its favorable-direction band.

### F19 — P2, new: The north-wind arrow touches the average digit

**Locations:** [xct.ts:96](/Users/johndorrance/projects/flying/stations/web/xct.ts:96), arrow geometry; [xct.ts:438](/Users/johndorrance/projects/flying/stations/web/xct.ts:438), arrow construction; [xct.ts:456](/Users/johndorrance/projects/flying/stations/web/xct.ts:456), average baseline; [xct.css:252](/Users/johndorrance/projects/flying/stations/web/xct.css:252), average font size.

The enlarged arrow extends into the space occupied by the larger, raised average text. Because the arrow and number share a color, the shapes merge instead of remaining distinct wind-direction and speed indicators.

**Reproduced:** north wind, average **8 km/h**, gust **10 km/h**. The arrow tip joins the upper loop of the `8` at ordinary tile proportions. A separate rasterization of the actual arrow and Arial glyph confirms intersecting filled pixels; the magnified browser reproduction below makes the contact visible. Diagonal 33/35 cases were also checked and did not show the same filled-shape intersection.

![Fourfold magnification of the north-wind arrow touching the 8](/Users/johndorrance/projects/flying/stations/docs/reviews/assets/xct-arrow-overlap.png)

**Recommendation:** reserve a central text region and keep the arrow outside it for every direction, or adjust the text baseline/size to provide a visible gap. Add screenshot checks for single- and double-digit averages with and without gusts, especially north wind.

### F14 — P3: The widget's cold-start JavaScript has avoidable overhead

**Location:** [build-web.mjs:24](/Users/johndorrance/projects/flying/stations/scripts/build-web.mjs:24), lines 24–29.

The browser build is unminified. The first-pass output measured approximately **812 KB raw / 130 KB gzip**; an equivalent in-memory minified build measured approximately **483 KB / 103 KB gzip**. Those are first-pass measurements, not a new bundle benchmark; the build configuration remains unminified. Validation-library code, locales, and schema utilities account for much of the bundle, beyond this small widget's own logic.

**Impact:** additional cold-load transfer and parsing on a slow connection or modest device. No resulting device-level stall was demonstrated.

**Recommendation:** enable production minification and investigate smaller validation entry points/tree shaking while retaining runtime validation. Measure compressed transfer and cold start on the intended device before making larger architectural changes.

### F16 — P3: The setup page copies invalid settings without warning

**Location:** [xct-use.html:150](/Users/johndorrance/projects/flying/stations/web/xct-use.html:150), lines 150–177.

`widgetUrl()` does not validate the controls before updating the Copy/Open URL. Positive fractional maximum ages are rounded after validation, and nonempty latitude/longitude strings are copied without numerical/range checks. The controls are not submitted through a form, so HTML validity constraints do not prevent this.

**Reproduced using the actual page controls:** enter max age `0.4`, latitude `200`, longitude `44.73`. The page reports no error and produces `?maxage=0&lat=200&lng=44.73`, even though the age control's `checkValidity()` is false. The widget interprets zero age as its **120-minute default**, rejects the coordinates, and falls back to device location when available. The resulting behavior is different from the entered configuration.

**Recommendation:** validate age as an integer in the accepted range, validate paired coordinates and their bounds, and disable Copy/Open until invalid inputs are corrected. Show field-specific errors. Valid configurations were also tested and generate the expected URL.

### F18 — P3, new: Positive gusts become “missing” when display rounding reaches zero

**Locations:** [xct.ts:387](/Users/johndorrance/projects/flying/stations/web/xct.ts:387), lines 387–390; [xct.ts:452](/Users/johndorrance/projects/flying/stations/web/xct.ts:452), lines 452–457; [xct.ts:654](/Users/johndorrance/projects/flying/stations/web/xct.ts:654), tooltip formatting.

The new helper does more than suppress raw zero gusts: it converts a positive measurement to null when that measurement rounds to zero in the selected display unit. The dial then removes it and the title displays an absence dash. Measurement availability therefore changes when units change.

**Verified with schema-valid readings:** **0.4 m/s** displays as `1` in km/h, mph, and knots but disappears in m/s. **0.2 m/s** displays as `1` in km/h but disappears in the other modes. This is a low-wind formatting issue, not a strong-gust alarm failure.

**Recommendation:** preserve positive measurements through formatting, using a decimal, `<1`, or rounded zero. Apply any intended raw-zero suppression separately. Test positive values below each unit's rounding threshold and retain the distinction between missing and measured data.

## Resolved findings

### F15 — Resolved: Age-chip contrast

The interpolated foreground/background choice was replaced with three fixed palettes selected by [ageChipStep](/Users/johndorrance/projects/flying/stations/web/xct.ts:582). Browser probes confirmed the early/late/stale classes and the new CSS colors. Calculated contrast is **8.20:1** for early aging, **10.85:1** for late aging in light mode, **17.40:1** for stale in light mode, **14.20:1** for late aging in dark mode, and **17.40:1** for stale in dark mode. The former intermediate brown-on-brown failure no longer occurs. Intentional tile fading remains unchanged and is not part of this resolved defect.

## Validation and coverage

- Compared pass 2 with the latest **774-line** TypeScript entry, **318-line** stylesheet, and setup page. Inspected the supplied desktop screenshot and rechecked source fingerprints before delivery, including the later arrow/gust edits.
- **This pass:** the final entry passed a strict browser-only TypeScript check and isolated browser bundling. The focused explorer route test passed **1/1** under Node 24.22.0. Build/check configuration and server behavior were unchanged, so the full gate was not repeated. **Previous pass:** `pnpm verify` passed **135/135** tests plus API/consumer checks.
- Browser fixtures verified live/aging/stale chip styles, normal and narrow layouts, north/diagonal arrow placement, and the station-bearing SVG transforms. No application `pageerror` occurred in these probes. The arrow-detail image is a fourfold magnification of the same SVG proportions, not a proposed design.
- The new wind-band arithmetic was checked across 12,221 average/gust combinations and half-unit boundaries; emitted classes match CSS. Tests confirm the documented rounding/promotion rule, not the appropriateness of a universal flight-speed threshold. The later gust helper was separately tested with schema-valid positive readings.
- Checked bearing wrap at north and all cardinal directions, plus early/late/stale chip selection. New direction math is correct; F17 concerns layout scaling, not the calculated bearing.
- At **320 × 160**, the new layout still exposes only **3 complete tiles and 3 partial tiles**, leaving **24 entirely hidden**. Verified the more specific ring inversion at 80/60 px widths and with enlarged tiles.
- Re-read the unchanged position, freshness, feed-failure, category, and candidate-selection paths. Prior reproductions remain applicable; these correctness issues were not fixed by the front-end edits.
- The setup page changed only its explanatory paragraph; its script still reproduces invalid URL generation (F16). Routing and valid configuration generation continue to pass their focused checks.
- Actual Android/XCTrack WebView behavior, sunlight readability, sleep/resume, and device-level battery/cold-start performance remain untested.

## Areas checked without a confirmed defect

- Station names and footer strings are escaped before insertion; the special-character fixture did not inject markup. Numeric SVG values originate in validated feed data.
- Rendering work is bounded to 30 tiles and fixed-size dial geometry; no unbounded rendering loop or growing station cache was found in the final implementation.
- The in-flight guard prevents overlapping feed requests; the client supplies request timeout/cancellation behavior. No out-of-order overlapping-feed bug was demonstrated.
- Speed/distance conversions, wind-band threshold order, compass wrapping, ordinary dial direction geometry, and favorable arcs were inspected. No additional concrete defect was established. The contract treats equivalent arc endpoints as a single bearing, so the zero-span arc handling is not reported as a full-circle bug.
- The age formatter produces the expected `4m`, `59m`, `1h`, `1h05`, and `2h` strings. Fixed chip palettes resolve F15, and no new asynchronous defect was found.

## Remaining validation and lower-priority hardening

These are follow-ups, not additional confirmed target-device failures:

- Test the actual XCTrack/Android WebView version, GPS bridge permissions, external GPS, sleep/resume, loss/recovery of connectivity, device rotation, and the intended widget dimensions. The build targets ES2022 and uses `String.replaceAll`; no minimum compatible WebView is documented or enforced.
- Check recovery latency: native position sampling and normal rendering are tied to feed polling, with no visibility/online resume handler. A newly available native fix can wait for the next poll; a slow feed delays age updates. Define and test the desired latency.
- Validate URL configuration visibly. An unrecognized `category` currently broadens the request to all categories when no valid token survives; a typo can change the requested coverage silently.
- Check request scheduling and battery use during a long flight. A pending retry is not cancelled on successful interval refresh, and polling/high-accuracy geolocation continue without an explicit hidden-page policy. These are bounded inefficiencies, not demonstrated leaks.
- Decide whether a tile's mountain silhouette means station terrain or elevation relative to the pilot. The current deliberate heuristic can change classification during a climb and assumes some unknown-elevation stations are peaks; that interpretation should be clear to the pilot.

## Suggested implementation order

1. Fix position validity, fix loss, and anchored observation age together: **F01–F03**.
2. Add persistent failure/coverage states and bounded candidate refill: **F04–F05**, including the empty-result state in **F12**.
3. Correct altitude, category, and unknown-direction handling: **F06–F07, F10**.
4. Finish units/details and viewport presentation, live-number contrast, and the new ring/arrow geometry issues while preserving intentional fading: **F08–F09, F11, F17, F19**.
5. Gate behavior with targeted tests, validate setup inputs and small-gust formatting, then optimize cold start: **F13, F16, F18, F14**.

## Reviewed file fingerprints

Final source fingerprints identify the reviewed versions despite concurrent edits. Source links above refer to this checkout; later edits can move their line numbers.

```text
web/xct.ts       0881e39a4573c30854ec9ac1a7314ac18680ca862cf1e41861973fffb17eb3ad
web/xct.css      a91b0d81606f8dcdd2337222e7b92e2c33ad5d350fec1b4a02fc3b0bea33ab80
web/xct.html     82b1b1ed692b55f4bdeb48959a0dc06b941df8751dfe573086390212356a3de3
web/xct-use.html 9f46948fd257c4cd6c6ad470bff1d717c03620ac2c9833db7c9be7789cf6f95f
```
