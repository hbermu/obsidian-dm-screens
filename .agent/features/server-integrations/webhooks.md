# Webhooks Through the Server

> A webhook target's URL carries its own credential — a Telegram bot token sits in the path — so in remote mode the targets live on the server and the controller names one instead of holding it. The DM picks a target by name, the server posts the image it already stores.

## Source files

- `server/src/integrations/webhooks.rs` — the configured targets, the multipart post, the per-target rate limit
- `src/integrations/remote.ts` — `RemoteGateway.webhooks()`: names from `control-hello`, send over the route below
- `src/integrations/local.ts` — `LocalWebhooks`: today's `sendWebhookImage`
- `src/webhooks/client.ts`, `src/webhooks/multipart.ts` — unchanged; the local gateway's implementation
- `src/views/SendToWebhookModal.ts` — the caller, now through `plugin.gateway.webhooks()`

## Settings used

- `DM_SCREEN_WEBHOOKS` (or `DM_SCREEN_WEBHOOKS_FILE`) — a JSON array of `{name, url, imageField, captionField, extraFields}`, the same shape as the `webhooks` setting without its `id`
- `webhooks` — embedded mode only

## Requirements

1. The server shall parse its webhook targets at startup and refuse to start when the JSON is malformed, a name is empty or repeated, or a URL fails the outbound policy.
2. `control-hello` shall carry the target names only (`overview.md` requirement 4); no response shall ever carry a target's URL or extra fields.
3. `POST /api/webhooks/<name>/send` with `{asset, caption}` shall require the control token, look the target up by name, read the asset from the store, and post it as `multipart/form-data` with the target's image field, caption field and extra fields.
4. `<name>` shall be matched exactly against a configured target; an unknown name shall answer `404` without any outbound request.
5. `asset` shall be an `/assets/<sha256>.<ext>` URL of a stored asset; anything else shall answer `400`, so the route cannot be used to post arbitrary bytes.
6. `caption` shall be at most 1024 characters.
7. The server shall allow at most one send per target per second and at most 20 per minute, answering `429` beyond that, because a webhook is the one integration that writes somewhere public.
8. A send shall answer `204` on success and `502` on an upstream failure, with the target name and the upstream status logged and nothing of the body or the URL (`overview.md` requirement 16).
9. While the controller is read-only it shall not offer the send action (`overview.md` requirement 18).
10. The send modal shall list the gateway's targets in both modes and preview the layer as it does today. It shall send what the transport makes reachable (`publishMedia`): the layer's data URL in embedded mode, its published asset in remote mode.

## Tests covering this

- `server/tests/webhooks.rs` — target parsing and its startup errors, the names in the hello without URLs, a send's multipart shape against a stub target, unknown name, a non-asset body, the caption cap, the rate limit, `502` with nothing of the upstream body
- `src/__tests__/gateway-remote.test.ts` — the remote `WebhooksApi` lists names and sends by name with the asset
- `src/__tests__/send-to-webhook-modal.test.ts` — the modal lists the gateway's targets and sends through it

## Non-goals

- Editing targets from the plugin. They are deployment configuration (`overview.md` requirement 7).
- Sending anything but a stored image. Arbitrary payloads are out (requirement 5).
- Delivery guarantees. A send is one attempt, reported by its status.
