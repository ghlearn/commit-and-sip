# Integration contract

This document separates supported extension behavior from unresolved production integrations. It is not evidence that a live booth deployment has been approved.

## Confirmed Skills adaptation

The delivery is a single-step exercise that runs entirely inside the canvas. The canvas owns the whole attendee journey: handle, naming, scoring, house menu, standings, and hand-over. Staff setup is outside the learner step. Repository Actions validate the repository only; they do not drive learner transitions, create issues, or gate play on workflow queue time. There is no Step 2 and no automatic issue closure.

`.github/steps/1-name-a-drink.md` is the canonical learner guide. It parses under the repository's strict step parser — one Step 1 heading, level-two activity headings, plain paragraphs — so it can be rendered in a canvas later without rework. It is not currently rendered by the canvas, because the booth screen explains itself inline; it exists so the written instructions and the screen cannot drift apart unnoticed.

The earlier pull-request review flow has been removed, not merely disabled. `engine.mjs`, `panel.mjs`, `content.mjs`, the GitHub, provisioning, pilot, live, completion, authority, and issue-writer services, the review renderer pages, the provisioning and reset scripts, and the Markdown templates are all gone. Nothing in this repository reads or writes GitHub, so there is no dormant path to reach it by configuration.

## Booth flow: the canvas-only naming competition

The booth exercise is a creative naming competition run entirely inside the Copilot App canvas. An attendee invents one coffee name, it joins the house menu, a rubric scores it, and they leave with a handle and a place on the leaderboard. The attendee performs no pull-request review, approval, or merge, and touches no GitHub surface at all. This supersedes the earlier pull-request review framing and amends the preserved [outline](exercise-outline.md) sections 3, 5, and 6 and open questions 3 and 4. This section records design intent only; it certifies no live readiness.

| Step | Implemented behavior |
| --- | --- |
| Distribution | The exercise repository is a template a booth admin copies to their own handle and adds to the Copilot App. The canvas extension, skill, catalog, and name rules travel with the repository. Ignored `booth/local-config.json` and the run store do not, so each booth configures its own. |
| Handle | `BoothEngine.open` mints a curated three-word handle immediately, before the attendee invents anything, so they can note it down and find themselves on the leaderboard later. Handles are unique within a booth. Reopening a run returns the same handle. |
| Naming | The attendee types one name that must contain `mona`, `copilot`, or `ducky`, and chooses where it sits: at the start, in the middle, at the end, or blended into a word such as `Monachino`. `mascotPlacement` reports the placement actually used, and a declared mascot or placement is checked against the typed name rather than quietly overridden. The mascot is something to build on, so a bare `Mona` is rejected — the attendee has to add something of their own. `validateCoffeeName` applies the structural anti-injection rules and the single moderation list in `booth/blocked-terms.json`. |
| Uniqueness | Enforced on the canonical menu ID, so casing and spacing variants collide. The attendee is told which existing drink clashed, including when it is a house example. A refused name costs nothing: the phase, menu, and ledger are unchanged, and they simply try again. |
| Scoring | A deterministic rubric in `services/name-score.mjs` scores 1-5000 over alliteration, coffee craft, wordplay, house shape, and invention. Placement is recorded but never scored, so no position is worth more than another and the choice stays free. |
| Result | The canvas shows the score breakdown, the updated house menu, and the attendee's rank. A leaderboard link or QR appears only once staff configure an approved public destination. |
| Completion | `complete` closes out the attendee so the booth can be handed to the next one. It requires a served drink, is idempotent against a double click, and finishes the run rather than erasing it: the drink stays on the house menu and the leaderboard, and remains unavailable to later attendees. The next attendee is a new run with a new handle. |

### Scoring is a rubric, not a judge

The score is a pure function of the submitted name, so the same name always scores the same, a rank can be recomputed server-side from stored names, and staff can explain any score at the booth from the returned breakdown. This preserves rather than amends the existing rule that primary rank is deterministic and server-recomputable.

No model call is involved and no model output is implied. Copilot commentary remains unavailable unless a real attributed, moderated, trusted judge is configured, and would remain commentary rather than rank. The component maximums sum to exactly 5000, which a test pins, so attendees can only be told "out of 5000" while that remains true.

The three house drinks are worked examples. They are seeded on the menu unscored, are refused for scoring, and never appear on the leaderboard, so nobody competes against the demo entries.

### Leaderboard integration

One booth is authoritative only for its own menu and cannot know what was invented elsewhere, so cross-booth uniqueness and the global ranking belong to the leaderboard service. `addDrink` takes the menu as input, so a caller may merge remotely known IDs before calling and have the same duplicate check cover both. Stored entries carry the run ID, handle, name, and score needed to reconcile a booth with the service.

Booth standings rank by score with equal scores sharing a rank: `1 + the number of entries with a strictly higher score`. A service should use the same convention so a booth and the event never disagree about what a tie means.

Handles are unique within a booth. `generateHandle` draws from curated word lists and, once the phrase pool is exhausted, keeps the curated phrase with a deterministic eight-hex suffix. Global uniqueness across booths is the service's responsibility. The service keeps the first entry under a phrase, and stores a later one under `canonicalHandle(handle, id)` (`services/leaderboard.mjs`): the phrase plus eight hex characters derived from the drink ID. It returns that value in its receipt. `validateReceipt` accepts the submitted handle or exactly that canonical form, the attendee's QR link uses the confirmed handle, and the booth never regenerates one.

`services/leaderboard.mjs` is the client seam. A client implements `publish(submission)` and owns its own timeout, and may implement `retract(id)`. `services/leaderboard-client.mjs` is the HTTP client for [the leaderboard service](leaderboard-service.md); it is built only when staff configure `leaderboardApi`, and `leaderboardClient` is null otherwise. The flow is local-first: `submit_name` commits the drink inside the store transaction, the lock is released, and only then is the entry published. A slow or unreachable service therefore cannot hold up the counter, fail an attendee's submission, or lose a drink that was already earned.

A receipt is accepted only when its handle, ID, name, and score match what was sent (the handle may instead be its canonical form, when another booth used the phrase first); anything else is recorded as a failure rather than shown, so a service answering about a different entry can never rank this attendee. Failures are retried on the next refresh, so a network blip recovers without staff. The submitted payload is deliberately minimal — handle, ID, name, score, and a random per-publication token that stays the same across retries, so the service can tell a retry from another attendee who drew the same handle and name — carrying no run ID, device, or booth identity, since an anonymous handle is all a public board needs.

`syncView` keeps two facts apart that are easy to conflate: the booth standing is local and the booth owns it, while an event rank exists only once the service confirms it. Until then the canvas says the place is still being confirmed, and the booth rank is labelled "at this booth" so it cannot be read as an event-wide placing.

The leaderboard destination is unresolved. `leaderboardUrl` stays null unless staff configure an approved destination, and no link or QR is invented. `BoothEngine` refuses a non-web `leaderboardUrl` at construction rather than rendering a code that scans to nothing, exposes `attendeeUrl` only after the attendee has played, and leaves it null when nothing is configured. The existing requirement for an approved publicly reachable HTTPS destination and a real issue-renderable QR asset is unchanged.

### Moderation

`services/moderation.mjs` owns blocklist matching, separately from the structural name rules. Matching folds digits to letters, strips separators, and collapses repeated characters on both sides, so `b a d`, `b-a-d`, `baaad`, and `b4d` reduce to one entry and cannot be listed around. Non-ASCII never reaches this layer, because the name charset rejects it first, so homoglyph and zero-width evasion are already structurally impossible and no confusable table is needed.

Entries declare `substring` or `word`. Substring mode rejects the fragment anywhere; word mode requires the term to consume whole words so a real list does not reject `Grinder` for containing `grind`. Word mode also joins runs of consecutive tokens, because tokenizing alone would let a spaced-out term evade it: that flaw was caught by its own test rather than shipped.

`booth/blocked-terms.json` is an explicit placeholder. `validateBlocklist` enforces structure and provenance, while `blocklistStatus` reports readiness separately, so a placeholder still loads and the booth still runs, but never claims approval. The extension logs a warning naming the gap on every booth start. Nothing here certifies a list as adequate; that remains a human decision recorded in the file's `review` block.

This is the only moderation list. A second flat `blockedTerms` array in `booth/name-rules.json` was removed: it matched by plain substring with no evasion resistance and no word mode, and the runbook's review procedure never mentioned it, so a reviewer could complete that procedure and leave a second list untouched. The key is now rejected at start-up rather than ignored.

A blocklist is a prediction about what someone will type, so it cannot be the only control. `removeDrink` is the one that works after the fact: staff take an entry off the menu and the standings, and the ID becomes a tombstone that refuses resubmission with the same wording as a blocklist hit. It is reached through `npm run remove`, never through `dispatch`, because the canvas runs on a screen facing the queue and a takedown control there would let anyone delete a rival's entry. Every removal records a named person and a reason, and a run whose drink was removed stops claiming a rank, a QR, and a place on the menu.

### Canvas wiring

There are two canvases over one `BoothEngine`: `commit-and-sip` for the attendee and `commit-and-sip-admin` for staff. Neither takes open input, which is precisely why staff operations cannot be a mode of the attendee canvas — there is no input to select one with. The attendee canvas exposes `begin`, `submit_name`, `complete`, and `refresh`. The staff canvas exposes `refresh`, `export_results`, `remove_drink`, `close_station`, and `archive_and_wipe`.

Keeping them apart is a boundary, not tidiness. The attendee screen is unattended and faces a queue, so no destructive operation may be reachable from it; the engine's attendee dispatch whitelist rejects every staff action name, and a test pins that in both directions. The loopback server scopes its page and script assets per panel so a booth server cannot serve the dashboard's script either.

Be precise about what that boundary is. It stops a *destructive action being routed through the attendee surface* — the page in front of the queue, and the HTTP endpoints behind it. It is **not** an authorization check: both canvases are registered in one App session, so any actor who can drive that session can open the staff canvas. The ledger is protected by physical control of the App, and the `wipe` confirmation and recorded staff name are friction and audit, not authentication.

This is an accepted decision, not an oversight. The booth is staffed and the machine running it is staff equipment, so physical control is the boundary the exercise relies on; see [the runbook](../booth/RUNBOOK.md#staff-dashboard) for what that requires of staff in practice. An unattended booth, or a deployment where the App session is reachable by attendees, needs a real staff secret added before it can claim one.

`BoothPanel` is the station: one panel serves attendee after attendee, holding only the current run, so `begin` mints a fresh handle and `complete` clears the cursor and returns the counter to idle with the previous drink still on the house menu. A double click on `begin` is refused rather than stranding a started run.

That cursor is a cache, and the ledger can move without it — staff closing an abandoned station, or an event archive wiping the ledger. The panel therefore reconciles before it trusts the cursor: a run that is gone or already finished releases the station instead of refusing the next attendee as `already_started` or failing a refresh as `run_missing`. Any surface that holds a run ID across staff operations owes the same reconciliation.

QR codes are rendered server-side into a data URL because the loopback server's `script-src 'self'` policy forbids a CDN; `services/qr.mjs` returns null rather than a broken code if rendering fails. The QR is derived from the verified destination on each read rather than stored, so it cannot outlive or contradict the configured leaderboard.

The loopback server keeps its per-panel capability ticket, exact origin and host checks, content-type enforcement, and bounded request bodies. Those protections are independent of which flow runs behind them and were retained through the retirement, along with their tests.

### Event lifecycle and data ownership

Attendee data lives in the data directory outside the checkout. **Deleting the cloned repository is not a cleanup**: it removes the reviewed blocklist and staff configuration and leaves every attendee name and removal record untouched. Any implementer or operator instruction that treats repository deletion as end-of-event data handling is wrong.

The ledger is per machine. A multi-station event has one menu, one set of standings, and one duplicate check per booth, and must be archived once per booth. Cross-booth uniqueness is a leaderboard-service responsibility, not something a station can provide.

`archive_and_wipe` is the only operation that destroys data. Its ordering is required, not incidental: write the archive inside the ledger transaction, read it back off disk, compare it against the live ledger, and only then reset. The comparison must cover the whole ledger, not only summary totals — equal counts and an equal score sum do not make a file a restorable copy. A failed read-back must leave the event intact, and must not leave the unverified file where staff could mistake it for a good archive. Artifacts must never overwrite an existing file, and must never be written into the checkout.

A wipe must be refused while a station is mid-order. Because attendee hand-over requires a served drink, staff must have an explicit way to close an abandoned station, or an attendee who walks away strands the machine permanently. Closing a station ends a turn and keeps any drink already served on the menu; it is not a takedown and must not be recorded as one.

Retention of archive files — duration, owner, deletion schedule — is still unapproved. Do not invent one.

### Browser verification is part of the contract

Every screen under `renderer/` must be driven through a browser before it is considered verified, including the staff dashboard, where the refusal paths matter as much as the successful wipe. The booth screen was verified in a real browser twice, and each time it found a defect that the whole passing suite had missed. First, `#pick-placement` carried `required` while its default option had an empty value, so `reportValidity()` silently blocked every submission with no visible error. Second, `#pick-mascot` defaulted to a real selection, so a typed name was rejected for a mascot claim the attendee never made.

API-level tests do not exercise HTML form validation or default-selected `<option>` semantics. Static checks now assert that neither picker is `required` and that both keep an empty-value default. Treat form-bearing canvas UI as unverified until it has been driven through a browser.

### Not yet built

Four gaps remain, and none of them is code.

The moderation blocklist needs reviewed content. The mechanism is built, the gap is reported at every start, and staff can now take a name down after the fact, but no list has been approved, and nothing in this repository certifies a list as adequate.

The leaderboard service is deployed (`leaderboard-service/`, <https://commit-and-sip-leaderboard.azurewebsites.net>), but no attendee-facing QR code points at it. Publishing (`leaderboardApi`) and the attendee QR (`leaderboardUrl`) are configured separately, so the service can be proven with staff entries while the QR stays off. Do not present a placeholder QR as a production link.

Brand and trademark review of the mascot names and artwork has not happened. The cup illustration is original work carried over from the retired review page, but the froth now carries the official Mona mascot (`renderer/mona.png`), so unapproved official brand art is on the attendee screen today. Unlike the other three gaps, this one is not something the repository merely withholds: it ships, and a negative review would require removing it. Provenance, modifications, and the outstanding decision are recorded in [the asset checklist](../.github/images/README.md).

Making the repository a public template is a visibility change requiring its own review.

## Supported canvas boundary

The project extension entrypoint is `.github/extensions/commit-and-sip/extension.mjs`. The installed host's extension SDK documentation is the authority for `joinSession`, `createCanvas`, lifecycle callbacks, action schemas, and error handling. Consult that installed documentation; do not infer undocumented navigation or telemetry APIs from the existence of a canvas.

The SDK is host-resolved. No standalone SDK installation is required.

Registered canvas ID: `commit-and-sip`. Open it with omitted input or `{}`; it accepts no open input at all. Opening creates no attendee and no run. A panel's caller-selected `instanceId` is a lifecycle handle, not a durable identity; the run ID the station mints is the persistent one, and no record is keyed by `instanceId`.

| Action | Input | Meaning |
| --- | --- | --- |
| `begin` | `{}` | Mint a barista handle and start one attendee's order. Refused if the station already has one. |
| `submit_name` | `{"name":"Mona Moonrise","mascot":"mona","placement":"start"}` | Validate, score, and add the drink. `mascot` and `placement` are optional; when supplied they are checked against the typed name rather than overriding it. |
| `complete` | `{}` | Finish this attendee and clear the station. Idempotent against a double click. |
| `refresh` | `{}` | Read the current station state, house menu, and standings. Retries a failed leaderboard publication. |

Unexpected input properties are rejected. Actions other than `begin` and `refresh` require a started order and otherwise return `not_started`.

Publication happens after the store transaction commits and the lock is released, so a slow or unreachable leaderboard can never hold the counter, fail a submission, or lose a drink that was already earned.

## Implementer requirements for a leaderboard service

[The leaderboard service](leaderboard-service.md) implements these requirements and records the decisions taken: hosting, booth authentication, retraction, and server-side moderation. It is deployed and was verified end to end with a staff test entry.

A client implements `publish(submission)` and owns its own timeout. The booth must never wait on a slow service.

The submitted payload is deliberately minimal — handle, drink ID, name, score, and a random per-publication token that stays the same across retries, so the service can tell a retry from another attendee who drew the same handle and name. The booth saves the token before the first send. It carries no run ID, device, or booth identity, because an anonymous handle is all a public board needs.

A receipt is accepted only when its handle, ID, name, and score match what was sent (the handle may instead be its canonical form, when another booth used the phrase first). Anything else is recorded as a failure and never displayed, so a service answering about a different entry cannot be shown as this attendee's rank. Failed publications retry on the next refresh.

Cross-booth uniqueness and global ranking belong to the service. One booth is authoritative only for its own menu and cannot know what was invented elsewhere. `addDrink` takes the menu as input, so a caller may merge remotely known IDs before calling and have the same duplicate check cover both. Equal scores share a rank.

Any configured URL must pass `validateLeaderboardUrl` in `services/public-url.mjs`: HTTPS only, no credentials, fragment, or nonstandard port, and no private, loopback, reserved, or reserved-suffix host. `BoothEngine` refuses a non-conforming URL at construction rather than rendering a code that scans to nothing. `verifyPublicUrl` additionally performs an unauthenticated, non-redirecting HEAD with DNS pinned at socket creation, so a second lookup cannot turn a previously public address into an internal target.

`syncView` keeps two facts apart that are easy to conflate: the booth standing is local and the booth owns it, while an event rank exists only once the service confirms it. Until then the canvas says the place is still being confirmed, and the booth rank is labelled "at this booth" so it cannot be read as an event-wide placing.

**A service must offer retraction, and this one does.** A takedown commits locally first, then calls `retract(id)`. The outcome (`retracted`, `absent`, `failed`, or `not-configured`) is recorded on the removal and shown to staff, and failures are retried on admin **Refresh** or with `npm run remove -- --retry`. A publish still in flight when staff remove the drink is retracted again once its receipt arrives. The service reserves the retracted ID, keeping only a keyed fingerprint, so another booth cannot republish the name. The canvas stops displaying a confirmed rank for a removed drink rather than advertising one the booth has withdrawn.
