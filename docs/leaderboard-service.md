# Leaderboard service

**Status: deployed at <https://commit-and-sip-leaderboard.azurewebsites.net> (short link <https://gh.io/commit-and-sip-leader>), redeployed on 2026-10-01 and verified end to end through the booth canvases. The attendee QR (`leaderboardUrl`) stays unset until the blocklist is reviewed; the event owner has switched it on for one booth machine ahead of that review, for staff testing.**

> **What is live.** Everything in this document is deployed, including the captured tally, the board page's 24 px quiet zone around the repository QR, and `POST /api/board/clear` (deployed on 2026-10-02 from the branch that adds it, ahead of its merge). A later change ships with the next code deploy from an identity with Contributor (`npm run leaderboard:package`, then the `az webapp deploy … --async true` command and the version check in the runbook).

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

**The lock is a lease with a heartbeat and fencing.** The lease names its owner. A live holder beats every five seconds on its **own** heartbeat file, which no other instance writes, so a renewal can never overwrite anyone's lease and the lock is never absent while held. A lease is taken over only when its owner has shown no sign of life for 15 seconds, judged from the lease and that same owner's heartbeat. Takeover and release move the lock aside in one atomic rename and compare it with the lease they expected. Anything else is put back with an exclusive create, never overwritten. Immediately before the rename that commits a write, the holder checks the lease is still its own; if not, it retries from disk. **Residual risk, stated plainly:** a holder that passes that final check and then stalls for more than 15 seconds before its rename completes could still overwrite a write made in between. Plain files have no compare-and-swap that rules this out. The window is two consecutive filesystem calls wide, the version check narrows it further, and `npm run leaderboard:republish` restores anything lost from each booth's authoritative copy.

**How the file store stays correct across instances:** the plan runs one instance, but App Service does not guarantee that. During scale operations or platform maintenance, a second instance can run against the same `/home` share, and `WEBSITE_DISABLE_OVERLAPPED_RECYCLING` only affects recycling within one VM. So correctness does not rest on either setting. Every write takes a lock file created exclusively on the share. It re-reads the board from disk rather than trusting its own memory, applies its change, checks that the board's version has not moved, and replaces the file atomically through a uniquely named temporary file. Reads always come from disk. A lock older than 15 seconds is treated as left by a dead instance and taken over. If two instances ever did hold it at once, the version check refuses the later write and retries it. If the file is unreadable, the service refuses to start rather than start empty and overwrite it. Unreadable includes a structurally valid file with a bad row: a duplicate ID or handle, or a row missing a valid `id`, `handle`, `name`, `score` (an integer from 1 to 5,000, the rubric's range) or `createdAt` (a `tokenHash`, when present, must be 64 hex characters; rows written before publication tokens have none). Every reservation must be a 64-hex HMAC-SHA256 fingerprint, and a `keyId`, when present, 16 hex characters: a reservation in any other form would match nothing and silently release the name it was meant to hold. A running instance that finds such a file fails `/healthz` with 503 and serves no board, rather than serving rows the board page cannot render. **Cost:** every request reads the board file. At a few hundred rows that is small, but this store is built for one busy booth event, not for scale-out.

**Why the board is a projection:** every booth machine keeps the authoritative copy of its own drinks and takedowns. `npm run leaderboard:republish` rebuilds the board from a booth. It replays every takedown first, so removed names are reserved again, and then sends every drink. Each takedown, settled or not, is marked owed (`replaying`) in the booth's ledger before it is sent, and keeps whatever outcome the replay gets, so a replay that fails or is interrupted stays owed: the dashboard warns and the wipe waits. If any takedown is not reserved (the service is unreachable, or the machine has no staff key), it sends **no** drink and fails, because the replacement board would otherwise accept a removed name. Run it on each booth machine, with the staff key, after data loss or an `EVENT_ID` change. With several booths it runs in **two phases across the event**: `--takedowns` on every booth, then `--drinks` on every booth, so one booth's drinks never reach the new board before another booth has reserved the names it took down. Each booth enforces its own half: the drinks phase refuses unless that booth's takedown phase ran onto the board being served now. Every board carries a random `boardId`, minted when the board is first written and reported by `GET /api/board`. The takedown phase records it, and a board replaced again in between is not mistaken for the one the takedowns reached. The service enforces the order across booths: a board it creates from nothing starts closed to drinks, so every booth's publishing (rebuild or ordinary) gets a retryable `503 board_rebuilding` while takedowns still land, until a staff machine calls `POST /api/board/open` (`npm run leaderboard:republish -- --open`). When to open it, once every booth has replayed its takedowns, is the operator's decision. A board file written before this gate existed has no flag and stays open. `--all` runs takedowns, opens the board, then sends drinks, all on one machine: only for a single-booth event, since it opens the board before any other booth could replay. A drinks phase held by the gate or the network keeps its place and can be run again. It also publishes drinks served before the booth was configured, which would otherwise never be sent.

If a write to disk fails, the in-memory board is put back as it was, so the service never reports success for something that would vanish on restart. Reads wait for any write queued before them, so they never see a change that has not reached the disk.

A drink the service refused for good (`duplicate_drink`, `unavailable_drink`, or `handle_taken`, when both handles a publication can use are already taken) is recorded on the booth as `rejected` with that code. It is never sent again, not by a refresh and not by a rebuild. That holds when the refusal comes during a rebuild for a drink that was confirmed on a board since lost: the current service's answer replaces the old confirmation, and the lost board's rank is discarded. Otherwise, after a data loss, the booth that lost a name clash could republish first and take the name from the attendee who holds it. The attendee is told the event board did not accept the name, without the reason.

The service uses Node built-ins only. There are no runtime dependencies to audit, install, or patch.

### Booth authentication: two keys, two capabilities

| Key | Can | Lives |
| --- | --- | --- |
| Booth key | Publish only | `booth/local-config.json` on every booth machine, and an App Service setting |
| Staff key | Retract only | `booth/local-config.json` on machines allowed to take drinks down, and an App Service setting |

Keys are presented as `Authorization: Bearer`, compared in constant time, and must be at least 32 characters and differ from each other. `npm run leaderboard:configure` generates them **only for a brand-new deployment**. Every other machine gets the deployed keys copied with `--from`, and a booth-only machine is promoted to staff the same way. The copy is itself a credential: `--from` refuses a file that other users can read (POSIX), and the operator is told to delete it once the keys are stored (runbook: *Copying the keys to another machine*). Minting a new staff key there would not match the service, and redeploying to accept it would lock out every other staff machine, so the command refuses. The same keys go into the deployment as `@secure()` Bicep parameters, so an infrastructure redeploy cannot silently wipe settings that were added by hand.

**Handles are made unique across booths by the service.** A booth draws its handle from 512 phrases and knows only its own. If another entry already uses the phrase, the service stores the drink under a *canonical* handle: the phrase plus eight hex characters derived from the drink ID. It returns that handle in the receipt. The rule lives in `canonicalHandle()` in `services/leaderboard.mjs`, which both sides import, so the booth accepts the original handle or exactly that canonical one and nothing else. The attendee is told if their board handle differs. Their QR link carries an opaque publication reference (`ref`, derived from the hash of the publication token) as well as the handle. It finds their own drink even before the publish is confirmed, and it spells out nothing of the name, which request logs would otherwise keep. Once the reference matches, the handle may be the plain phrase or its canonical form in either direction. A rebuild can replay booths in a different order and reverse which of two colliding drinks holds the plain phrase, and a saved link must still find its drink. Admission is one serialised store operation covering the reservation check, the handle choice and the write, so concurrent requests cannot interleave.

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

The service deletes the entry and **reserves the drink ID**. An ID that was not on the board is reserved too, and answered with `200 {"retraction":"absent"}` rather than a 404. A 404 also comes from a build without this route, or from the front end of a stopped app. The booth settles a takedown as absent only on the service's own answer, and treats anything else as a failure that it retries. That ID is derived from the normalised name, so a name taken down at booth A cannot be republished from booth B, or from booth A again. **Departure from the proposal:** the proposal stored the reservation as a readable tombstone. This build stores only an HMAC fingerprint of the ID. Its key is generated by the service on first start and kept beside the board on the app's private storage, mode 0600. The key is not derived from the staff key, because rotating that key would then silently void every reservation. The board records which key it is bound to (`keyId`). Each instance opens the key and binds it under the cross-instance lock before serving, and every write checks the binding under that lock. If the key file is ever replaced while an older instance is still running, that instance's writes are refused with `503 reservation_key_mismatch` and its `/healthz` fails. The same happens if the board loses its binding altogether: a write would otherwise bind it back to a key that may be the obsolete one, and a restart binds it correctly. It therefore cannot record a reservation that the rest of the service would not match, and App Service recycles it onto the current key.

The stored board therefore holds no name, reason, or record of who removed anything. Those stay in the booth's local ledger. A refused resubmission gets `409 unavailable_drink` with the booth's own blocklist wording, so the counter cannot tell a takedown from a blocklist hit.

A retraction for a drink that never synced returns `200 {"retraction":"absent"}`, and the booth records that as `absent`. A `404` is never read as absent: it may mean the route is missing, so it is a failure that is retried. It **still reserves the name**, because staff often catch a name before it syncs. Only `retracted` and `absent` are settled. Anything else is retried on the admin canvas's **Refresh** or with `npm run remove -- --retry`: `failed` (network), `not-configured` (a staff key added later), and a missing outcome (the machine stopped mid-removal). A publish still in flight when staff remove the drink is retracted again once its receipt arrives. Until then the takedown is recorded as `in-doubt`, not settled, even if the service already answered `absent`: that answer says nothing about a send that lands afterwards. A retraction settles only if no send of that drink is claimed (a claim left by a crash stops counting after a minute) and none ended while the retraction was on the wire. So a stop between the landing and the follow-up retraction leaves the takedown owed and retried, rather than recorded as done. An unsettled takedown is **owed**: the dashboard warns about it and the event wipe waits for it. The board is keyed by drink ID, not by booth, so on a booth that publishes every unsettled takedown is owed, including one for a drink this booth never sent or one the service refused as `duplicate_drink`, because another booth's entry may hold that ID. The only exception is `unavailable_drink`, the service's own word that the ID is already reserved. A booth that does not publish at all owes a takedown only for a drink it did send.

### Receipts are checked on every field

The service replies with `{handle, id, name, score, rank, entries}`. `id`, `name` and `score` are echoed exactly as they arrived. `handle` is either the submitted handle or, when another booth used the phrase first, exactly `canonicalHandle(handle, id)`, and the booth accepts nothing else. As the proposal asked, `validateReceipt` now also compares `id`, so a receipt about a different entry that shared the handle, name and score is refused.

### The public page

`GET /` shows rank, drink, barista handle, and score, for the top 20 plus the true total. With `?handle=…&ref=…` it also shows "your drink" wherever it ranks. **Both are required:** a handle is unique only at one booth, so a handle alone returns no personal row, and `ref` is the opaque publication reference the booth puts in the attendee's QR link. It shows no booth identity, run IDs, or staff attribution, and **no mascot art**, because `mona.png` is not cleared for publication. It polls every 10 seconds. If polling fails, it keeps the last board and says how old it is, so a dropped connection gives a visibly stale board rather than a silently wrong one.

Security measures:

- A strict CSP with no inline script or style.
- All attendee text is assigned through `textContent`.
- `nosniff` and `no-referrer` headers.
- `no-store` on the API.

**Not done:** the page needs JavaScript. The proposal asked for it to be legible without JavaScript "if practical". Server-rendering was judged not worth the second escaping surface for a board read on phones and a monitor.

### Retention: still open

Each `EVENT_ID` is a separate board file, so setting a new ID starts a fresh board and leaves the old one on disk. Staff can also empty the board under the same ID from a staff machine's dashboard (`POST /api/board/clear`), which keeps the cleared board beside it as `<EVENT_ID>.cleared-<time>.json`. How long old and cleared boards are kept, and when they are deleted, is a human decision that has not been made.

## API

```
GET    /                        public board (the future QR destination)
GET    /api/board[?handle=&ref=]    { asOf, boardId, captured, rebuilding, total, entries[<=20], you? }  (ref is opaque, never the drink ID)
                                captured: every drink ever admitted to this board, for tracking. Only a
                                clear resets it: takedowns leave it, resends do not add. total: drinks on the board now.
POST   /api/entries             booth key. 201 new, 200 same entry again (handle
                                may be canonical), 409 duplicate_drink |
                                unavailable_drink | handle_taken,
                                422 score_mismatch | rejected_name | invalid_handle
POST   /api/retractions         staff key. Body exactly { id }. 204 retracted, 200 {"retraction":"absent"}.
                                Reserves either way. The ID is never in a URL, so web-server
                                logs hold no removed name.
POST   /api/board/open          staff key. Body exactly { "open": true }. Opens a board created closed. 200.
POST   /api/board/clear         staff key. Body exactly { boardId } naming the board staff checked.
                                200 { boardId (new), cleared: { total, captured } }: no entries, no
                                reservations, captured 0, open. The old board is kept on disk as
                                <EVENT_ID>.cleared-<time>.json. 409 board_changed for any other board.
GET    /healthz                 200 { ok, moderation: "reviewed" | "placeholder" }, or
                                503 when the board on /home cannot be read
```

## Non-goals

Live-updating push displays, per-booth boards, historical events, attendee accounts, and any form of login for attendees.

## What blocks launch, separately from build

A public board publishes attendee-invented names to the internet. Two gates remain, and neither is engineering:

- **The moderation blocklist is still an unreviewed placeholder** (see the [sourcing proposal](blocklist-sourcing.md)). Until it is reviewed, do not set `leaderboardUrl`, which is the setting that puts a QR code in front of attendees.
- **Brand review of the mascot art** (see [the asset checklist](../.github/images/README.md)).

The service is configured separately from the QR code: `leaderboardApi` controls publishing, and `leaderboardUrl` controls the QR code. That separation is deliberate. The whole pipeline can be proven with staff test entries while the QR code stays off.
