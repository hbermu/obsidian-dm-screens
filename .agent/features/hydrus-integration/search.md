# Hydrus Search

> Tag-driven file search executed against Hydrus through the Client API. Tags are entered as a comma-delimited string in the explorer search box; the modal parses, sends, and renders results.

## Source files

- `src/hydrus/tagInput.ts` — `parseTagQuery(raw)` splits on commas, trims, drops empties
- `src/hydrus/client.ts` — `searchFiles(tags, limit)`, `getFilesMetadata(hashes)`
- `src/views/HydrusExplorerModal.ts` — `runSearch(raw)` orchestrates parse → search → metadata → render

## Settings used

- `hydrusDefaultSearchTags`, `hydrusTagServices`

## Requirements

1. `parseTagQuery` shall split the raw input on commas, trim each segment, and drop empties.
2. `runSearch` shall accept the raw input string from the search box (or Search button) and call `parseTagQuery` to produce the tag list.
3. The explorer shall only ever return media. `runSearch` shall collect the checked kinds (`image`, `video`); with none checked it shall short-circuit with an empty result (no upstream call). A Hydrus search shall always append `system:filetype is <kinds joined by ", ">` — `system:filetype is image, video` with both boxes checked — before calling `client.searchFiles(tags, HARD_CAP)`, because Hydrus also holds non-media files tagged like the maps (the Foundry module zips carry their map's `name:`). A local-cache search (`searchLocal(tags, kinds)`, used when Local only is on, Hydrus is offline or no client is configured) shall keep only entries whose MIME starts with a checked kind (`image/`, `video/`) and that match every parsed tag; the `system:filetype` predicate is not applied to it, since it is not a tag the cache can match.
4. `client.searchFiles` shall append `system:limit=<limit>` to the tag array before submitting.
5. After hashes are returned, `runSearch` shall call `client.getFileMetadata(hashes)` and populate the tile array. The request is capped at `HARD_CAP` so a single round-trip is sufficient — no client-side chunking.
6. The modal shall render the first page of `PAGE_SIZE` tiles immediately and provide Prev / Next page controls.
7. While a search is in flight (`busy = true`), the modal shall not accept a new search.
8. The modal shall report per-search errors via the status row (`dm-hydrus-status`). The banner (`dm-hydrus-banner`) is reserved for connectivity / configuration warnings (Hydrus unreachable, missing config), set by `resolveMode` rather than per-search.

## Tests covering this

- `src/__tests__/tag-input.test.ts` — comma split, trim, empty filtering
- `src/__tests__/hydrus-client.test.ts`, `hydrus-client-extra.test.ts` — `searchFiles` URL construction and error mapping
- `src/__tests__/pagination.test.ts` — paging
- `src/__tests__/hydrus-end-to-end.integration.test.ts` — search → metadata → cache flow end-to-end with mocked `requestUrl`
- `src/__tests__/hydrus-explorer-search.test.ts` — a Hydrus search always carries `system:filetype is image, video` (or the single checked kind), no request with neither kind checked, a local-cache search drops non-media entries and filters by MIME per checked kind (req 3)

## Non-goals

- Tag operators beyond plain inclusion. Hydrus's `system:` and `-` (exclusion) prefixes are passed through verbatim; the parser does not validate.
- OR groups. Each tag is ANDed.
- Sort options. Hydrus's default order is used.
