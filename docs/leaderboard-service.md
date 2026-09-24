# Leaderboard service design

**Status: a proposal awaiting decisions. Nothing is deployed, and no client ships.**

The booth already defines the half of this that matters. `services/leaderboard.mjs` fixes the payload, the receipt, and the failure behaviour, and `BoothEngine` fixes when publication is attempted. A service is free in how it stores and ranks, and constrained in how it answers. This document settles what is still open, and flags two requirements that are not optional because existing client behaviour already implies them.

## What the booth already guarantees

- **It saves first, always.** A failed submission can never cost an attendee their drink or their score.
- **The payload is `{handle, id, name, score}`** and nothing else. No run ID, no device, no booth identity, because an anonymous handle is all a public board needs.
- **The client owns its timeout.** A booth queue must not wait on a slow service.
- **A local booth rank and an event rank are never conflated.** Until a receipt arrives the canvas says the place is still being confirmed.

## Two requirements that are already decided

These are not preferences. Existing code will misbehave against a service that ignores them.

### Publication must be idempotent on `(handle, id)`

`BoothEngine.publish` republishes whenever sync state is `pending` or `failed` (`booth-engine.mjs:163`), and `refresh` calls it (`booth-engine.mjs:186`). An attendee sitting on the served screen through a transient failure will therefore resubmit the same entry repeatedly.

A service that appends on each call will accumulate duplicates of one drink and inflate its own entry count. Treat `(handle, id)` as the natural key: re-publication updates in place and returns the current rank.

### The receipt must echo the submission byte-for-byte

`validateReceipt` rejects any receipt whose `handle`, `name`, or `score` differs from what was sent, and the booth then displays no event rank at all.

This is the likeliest way a working service still fails in front of an attendee: a backend that trims whitespace, title-cases the drink name, or coerces the score to a float is being helpful and will silently produce a blank rank line at every booth. **Store a normalized form if you want, but reply with exactly what arrived.** `rank` must be a positive integer, and `entries`, if present, must be at least `rank`.

## Decisions needed

### 1. Hosting

The service needs a write API and a public read page on the same HTTPS origin, because the QR target must satisfy `validateLeaderboardUrl`: HTTPS, no credentials, no fragment, no nonstandard port, no private or reserved host.

| Option | Fit |
| --- | --- |
| **Azure Static Web Apps + managed Functions** | Public page and API in one resource, HTTPS and custom domain built in, free tier covers booth volume |
| **Azure Container Apps** | Most control, scale-to-zero, but needs a container build and its own front door |
| **GitHub Pages + Actions** | Read-only by nature; writes would need a token per booth and a commit per entry, which is slow and racy |

**Recommendation: Static Web Apps + Functions**, with Table Storage behind it. Booth volume is a few hundred rows per event, so anything heavier is unjustified. GitHub Pages is listed only to record why it was rejected: a board that commits on every publish will lose entries to concurrent booths.

**Unknown to the author:** which subscription, org policy, and custom domain this would live under. That is a decision, not a detail — the QR points at it and cannot change mid-event.

### 2. Booth authentication

The payload deliberately carries no booth identity, so the service cannot tell who published from the body — and it should not learn it from there, because that would put booth identity into a document the public page renders.

**Recommendation: a per-booth API key, presented as a request header, mapped server-side to a booth ID that is recorded on the entry and never rendered publicly.** Keys are issued per event, revocable individually, and rotated between events. This keeps the payload anonymous, gives retraction and abuse response something to work with, and lets one compromised booth be cut off without disturbing the others.

Writes must not be anonymous. An unauthenticated endpoint that accepts a handle and a score is a board anyone can fill.

### 3. Retraction

The contract already requires this, and staff takedown is incomplete without it: today a drink can be pulled from a booth menu while the public board still shows it.

**Recommendation: retract as a tombstone, mirroring the booth.** The entry stops being displayed and stops counting toward ranks, but `(handle, id)` stays reserved.

A hard delete is the wrong choice for a specific reason: the contract makes cross-booth uniqueness the service's job. If a retracted name is fully forgotten, a name removed at booth A can be re-submitted at booth B, and the service is the only component positioned to refuse it.

**Open:** whether a booth key may retract only its own entries, or any entry. Suggested split — booth keys retract what they published, a separate admin key retracts anything — but the failure case is real: staff at booth B may be the ones who notice something published at booth A.

### 4. Server-side moderation

**This is the point most easily missed.** Booths run from *copies* of a template repository, so each booth's blocklist is frozen at whatever the admin cloned. A booth set up a month ago is screening against a month-old list, and nothing propagates an update to it.

The service is the only component that can hold a current list. It must re-screen every submission at publish time rather than trusting that the booth already did. That is defence in depth against stale clones, not distrust of the booth.

A rejected publish must fail the submission, not silently alter it — the receipt rule above means a sanitized name would surface as a blank rank rather than an explanation.

### 5. Retention

Entries are low-PII by construction: handles are curated anonymous phrases and carry no attendee identity. Drink names are user-generated content.

**Recommendation: entries live for the event plus a defined window, then are purged or archived; retraction records outlive entries, because they are the audit trail for a moderation decision.** The specific windows are a human decision, like the blocklist content, and should be recorded rather than defaulted.

### 6. The public page

It is scanned from a phone, in a queue, by someone who has just met it. Show handle, drink name, score, and rank. Do **not** show booth identity, run IDs, or staff attribution. Retracted entries must not appear. It should be legible without JavaScript if practical, and must meet the same accessibility bar as the canvas.

## Proposed API

```
POST /api/entries          # authenticated; idempotent on (handle, id)
  -> 200 { handle, name, score, rank, entries }   # echoed verbatim

POST /api/entries/retract  # authenticated; tombstones (handle, id)
  -> 200 { retracted: true }

GET  /                     # public board, the QR destination
```

`validateLeaderboardClient` currently requires only `publish(submission)`. It needs a matching retraction method before the client side of this is complete — that is a change to this repository, not to the service.

## Non-goals

Live-updating displays, per-booth boards, historical events, attendee accounts, and any form of login for attendees. The exercise is five minutes long and anonymous by design.

## What blocks launch, separately from build

A public board publishes attendee-invented names to the internet, where the booth cannot retract them. **The moderation blocklist is still an unreviewed placeholder** (see [sourcing proposal](blocklist-sourcing.md)). That content decision gates turning a board on, not building one, and it has no engineering dependency — it can be settled in parallel.
