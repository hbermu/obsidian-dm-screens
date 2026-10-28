# Map Screen — Physical Calibration

> Browsers cannot read a display's true physical DPI (a CSS inch is always 96 px regardless of the panel), so physical 1-inch scale needs a per-screen profile: the DM enters the screen's diagonal once, verifies against a real ruler with an on-screen test pattern, and fine-tunes. Profiles are keyed by resolution and reused automatically. The same profile carries the screen's media quality: optimized derivatives or the original files.

## Source files

- `src/map/transform.ts` — `profileKey`, `cssPixelsPerInch`, `FALLBACK_PPI`
- `src/views/MapCalibrationModal.ts` — diagonal input, fine-tune slider, media-quality dropdown, test-pattern toggle
- `src/views/MapScreenPanel.ts` — resolution badges open the modal; uncalibrated warning in physical mode
- `src/map/map.ts` — profile lookup by own window key, calibration card rendering, uncalibrated hint chip
- `src/main.ts` — `broadcastMapCalibration()` (server start and every profile change)

## Settings used

- `mapScreenProfiles` — `Record<"WxH@dpr", { diagonalInches, fineTune, quality? }>`; `quality` is `"original"` or absent (optimized)

## Requirements

1. Profiles shall be keyed by `profileKey(width, height, devicePixelRatio)` = `"WxH@dpr"`, computed from `window.innerWidth`/`innerHeight` on the map client and from the reported `client-info` on the DM side, so both sides resolve the same profile for the same browser window.
2. `cssPixelsPerInch(w, h, profile)` shall return `hypot(w, h) / diagonalInches × fineTune`, and `96` (`FALLBACK_PPI`) when the profile is missing or its diagonal is not positive.
3. Clicking a map screen's resolution badge in the DM panel shall open the calibration modal for that resolution; badges show `✓` when the profile has a positive diagonal, and ` · original` when it sets `quality: "original"`.
4. Every diagonal, fine-tune or quality change in the modal shall save the profile while it has a positive diagonal or `quality: "original"` (and delete it otherwise), and broadcast `map-calibration` with the full profiles record so connected map screens re-scale and re-source live.
4a. The modal shall offer a "Media quality" dropdown — Optimized (default; the profile carries no `quality`) or Original (`quality: "original"`). A screen whose profile sets `quality: "original"` shall load every map as the untouched original instead of a sized derivative (`overview.md` requirement 7a), so a capable screen can show full quality while a low-memory TV keeps the optimized media.
5. The modal's test-pattern toggle shall broadcast `map-calibration-overlay`; while shown, the map client shall render a card with its resolution/key, its effective px/inch, a 6-inch ruler bar, and a 1-inch square — all sized with the currently effective ppi so fine-tuning is verifiable with a physical ruler. Closing the modal hides the pattern.
6. The map client shall pick its own profile from the last `map-calibration` payload using its current window key, re-resolving on resize (entering fullscreen changes `innerWidth`/`innerHeight` and may switch profiles).
7. While in physical mode without a matching profile that has a positive diagonal, the map client shall show an "Uncalibrated screen" hint chip, and the DM panel shall show a warning under the pan preview; both disappear once a profile matches.
8. `map-calibration` shall be broadcast on server start so late-joining map screens always receive the profiles from the cache replay.

## Broadcast / IPC

| Message type | Direction | Payload | When |
|--------------|-----------|---------|------|
| `map-calibration` | DM → map | `{ profiles: Record<string, { diagonalInches, fineTune, quality? }> }` | Server start; any profile change in the modal |
| `map-calibration-overlay` | DM → map | `{ show: boolean }` | Test-pattern toggle; forced off when the modal closes |

## Tests covering this

- `src/__tests__/map-transform.test.ts` — `profileKey` encoding, diagonal→ppi math, fine-tune multiplier, 96-ppi fallback
- `test/e2e/specs/map-controls.e2e.ts` — real Obsidian: a `client-info` report surfaces the resolution badge; the calibration modal's test-pattern checkbox broadcasts `map-calibration-overlay`
- `test/e2e/specs/calibration.e2e.ts` — real Obsidian: entering a diagonal saves the `1920x1080@1` profile and broadcasts `map-calibration` with it; the badge gains a `✓`; the fine-tune slider updates the broadcast profile; clearing the diagonal deletes the profile and broadcasts its removal; choosing Original keeps a profile without a diagonal, broadcasts `quality: "original"` and marks the badge ` · original` without `✓`; returning to Optimized deletes that profile

## Non-goals

- Automatic DPI detection. Not possible from a browser; the diagonal + fine-tune flow is the design.
- Distinguishing two different physical screens that report the same resolution and dpr. The key is resolution-based; the last calibration wins.
- Calibration UI on the map page itself. The TV has no input device; the modal lives in Obsidian.
