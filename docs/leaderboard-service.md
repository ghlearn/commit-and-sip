# Leaderboard service

**Status: deployed at <https://commit-and-sip-leaderboard.azurewebsites.net> and verified end to end with a staff test entry (2026-09-30). No attendee-facing QR code points at it, and none may until the blocklist is reviewed.**

This document began as a proposal. It now records what was built, the decisions taken, and where the build departs from the proposal and why. The booth-side contract is still `services/leaderboard.mjs`. The service is constrained by it, not the other way round.

## What the booth guarantees

- **It saves first, always.** A failed submission can never cost an attendee their drink or their score.
- **The payload is `{handle, id, name, score, token}`** and nothing else. The `token` is a random per-publication token that stays the same across retries, so the service can tell a retry from another attendee who drew the same handle and name. It identifies the publication, never the booth, device or run, and the service keeps only its hash. No run ID, no device, no booth identity.
- **The client owns its timeout** (4 seconds). A booth queue never waits on a slow service.
- **A local booth rank and an event rank are never conflated.** Until a receipt arrives, the canvas says the place is still being confirmed.

## Decisions

### Hosting: one App Service B1 instance, board on `/home`

| Considered | Outcome |
| --- | --- |
| Static Web Apps + managed Functions + Table Storage | **Rejected after measuring the subscription.** Managed Functions cannot use managed identity, so Table Storage would need a shared key, which breaches GitHub storage control GH.15.05 from day one. Static Web Apps is also not offered in `westus3`. |
| App Service + Table Storage via managed identity | **Rejected.** Granting the identity a data role needs `roleAssignments/write`, which the deployer (Contributor) does not have and cannot activate. |
| **App Service B1, board as a JSON file on `/home`** | **Chosen.** Two resources, no storage account, no key, no role grant. `/home` is Azure-backed and survives restarts and redeploys. |

Hosting is subscription **GitHub - NonProd - skills**, region `westus2`, resource group `rg-commit-and-sip-lb-westus2`, app `commit-and-sip-leaderboard`. West US 3 was chosen first, but at deployment time it had no B1 capacity in either of two resource groups. A quota check does not detect that: it confirms entitlement, not physical capacity. The full reasoning, including the policy findings, is in `.azure/deployment-plan.md`.

**What the file store costs:** exactly one instance may write. The plan pins capacity to 1, `WEBSITE_DISABLE_OVERLAPPED_RECYCLING=1` prevents a second instance overlapping during a recycle, and every write within the process is serialised and lands atomically through a rename. If the file is unreadable, the service refuses to start rather than start empty and overwrite it.

**Why the board is a projection:** every booth machine keeps the authoritative copy of its own drinks and takedowns. `npm run leaderboard:republish` rebuilds the board from a booth. It replays every takedown first, so removed names are reserved again, and then sends every drink. Run it on each booth machine, with the staff key, after data loss or an `EVENT_ID` change. It also publishes drinks served before the booth was configured, which would otherwise never be sent.

If a write to disk fails, the in-memory board is put back as it was, so the service never reports success for something that would vanish on restart.

The service uses Node built-ins only. There are no runtime dependencies to audit, install, or patch.

### Booth authentication: two keys, two capabilities

| Key | Can | Lives |
| --- | --- | --- |
| Booth key | Publish only | `booth/local-config.json` on every booth machine, and an App Service setting |
| Staff key | Retract only | `booth/local-config.json` on machines allowed to take drinks down, and an App Service setting |

Keys are presented as `Authorization: Bearer`, compared in constant time, and must be at least 32 characters and differ from each other. `npm run leaderboard:configure` generates them once and keeps them after that. The same keys go into the deployment as `@secure()` Bicep parameters, so an infrastructure redeploy cannot silently wipe settings that were added by hand.

**Handles are made unique across booths by the service.** A booth draws its handle from 512 phrases and knows only its own. If another entry already uses the phrase, the service stores the drink under a *canonical* handle: the phrase plus eight hex characters derived from the drink ID. It returns that handle in the receipt. The rule lives in `canonicalHandle()` in `services/leaderboard.mjs`, which both sides import, so the booth accepts the original handle or exactly that canonical one and nothing else. The attendee is told if their board handle differs. Their QR link carries the drink ID as well as the handle, so it finds their own drink even before the publish is confirmed. Admission is one serialised store operation covering the reservation check, the handle choice and the write, so concurrent requests cannot interleave.

**Departure from the proposal:** the proposal suggested per-booth keys mapped to a booth ID. This build uses one shared booth key. The cost is that one compromised booth cannot be cut off without re-keying all of them. For an event with a few booth machines, that was judged acceptable. Per-booth keys would also put a booth identity into storage, and at present everything stored is either shown publicly or unreadable.

### Every submission is re-checked with the booth's own code

A key proves which service a request is allowed into, not that the booth code is unmodified. The service therefore imports the booth's modules and applies them itself:

- `scoreCoffeeName` rechecks the name rules, the blocklist, and the house-example exclusion, and recomputes the score. The request is refused with `422 score_mismatch` if the score or ID differ, and with `422 rejected_name` if the name is refused.
- The handle must be built from `booth/handle-words.json`, optionally with the eight-hex collision suffix, or the request is refused with `422 invalid_handle`.
- Ranking is the booth's own `leaderboard()`: competition ranking, where equal scores share a rank and the next rank skips. The booth and the board cannot disagree about a tie.

The service moderates with the blocklist deployed alongside it. Updating the blocklist means redeploying the service. `/healthz` reports `moderation: "placeholder"` until the list is reviewed, and the service logs a warning at start-up.

**Version skew is real.** A rubric change that reaches the service before the booths makes their submissions fail with `score_mismatch`. The booth shows those drinks as still being confirmed, and the reason is in its sync record. Deploy the service from the same commit the booths run.

### Retraction: delete the entry, reserve the name everywhere

Staff take a drink down from the admin canvas or with `npm run remove`. The booth commits the removal locally first. The network is never on that path. It then asks the service to retract the drink.

The service deletes the entry and **reserves the drink ID**. That ID is derived from the normalised name, so a name taken down at booth A cannot be republished from booth B, or from booth A again. **Departure from the proposal:** the proposal stored the reservation as a readable tombstone. This build stores only an HMAC fingerprint of the ID. Its key is generated by the service on first start and kept beside the board on the app's private storage, mode 0600. The key is not derived from the staff key, because rotating that key would then silently void every reservation.

The stored board therefore holds no name, reason, or record of who removed anything. Those stay in the booth's local ledger. A refused resubmission gets `409 unavailable_drink` with the booth's own blocklist wording, so the counter cannot tell a takedown from a blocklist hit.

A retraction for a drink that never synced returns `404`, and the booth records that as `absent`. It **still reserves the name**, because staff often catch a name before it syncs. Only `retracted` and `absent` are settled. Anything else is retried on the admin canvas's **Refresh** or with `npm run remove -- --retry`: `failed` (network), `not-configured` (a staff key added later), and a missing outcome (the machine stopped mid-removal). A publish still in flight when staff remove the drink is retracted again once its receipt arrives.

### Receipts are checked on every field

The service replies with `{handle, id, name, score, rank, entries}`, echoing exactly what arrived. As the proposal asked, `validateReceipt` now also compares `id`, so a receipt about a different entry that shared the handle, name and score is refused.

### The public page

`GET /` shows rank, drink, barista handle, and score, for the top 20 plus the true total. With `?handle=` it also shows "your drink" wherever it ranks. It shows no booth identity, run IDs, or staff attribution, and **no mascot art**, because `mona.png` is not cleared for publication. It polls every 10 seconds. If polling fails, it keeps the last board and says how old it is, so a dropped connection gives a visibly stale board rather than a silently wrong one.

Security measures:

- A strict CSP with no inline script or style.
- All attendee text is assigned through `textContent`.
- `nosniff` and `no-referrer` headers.
- `no-store` on the API.

**Not done:** the page needs JavaScript. The proposal asked for it to be legible without JavaScript "if practical". Server-rendering was judged not worth the second escaping surface for a board read on phones and a monitor.

### Retention: still open

Each `EVENT_ID` is a separate board file, so setting a new ID starts a fresh board and leaves the old one on disk. How long old boards are kept, and when they are deleted, is a human decision that has not been made.

## API

```
GET    /                        public board (the future QR destination)
GET    /api/board[?handle=&drink=]  { asOf, total, entries[<=20], you? }
POST   /api/entries             booth key. 201 new, 200 same entry again (handle
                                may be canonical), 409 duplicate_drink |
                                unavailable_drink | handle_taken,
                                422 score_mismatch | rejected_name | invalid_handle
DELETE /api/entries/:id         staff key. 204 retracted, 404 absent. Reserves either way
GET    /healthz                 { ok, moderation: "reviewed" | "placeholder" }
```

## Non-goals

Live-updating push displays, per-booth boards, historical events, attendee accounts, and any form of login for attendees.

## What blocks launch, separately from build

A public board publishes attendee-invented names to the internet. Two gates remain, and neither is engineering:

- **The moderation blocklist is still an unreviewed placeholder** (see the [sourcing proposal](blocklist-sourcing.md)). Until it is reviewed, do not set `leaderboardUrl`, which is the setting that puts a QR code in front of attendees.
- **Brand review of the mascot art** (see [the asset checklist](../.github/images/README.md)).

The service is configured separately from the QR code: `leaderboardApi` controls publishing, and `leaderboardUrl` controls the QR code. That separation is deliberate. The whole pipeline can be proven with staff test entries while the QR code stays off.
