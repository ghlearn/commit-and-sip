# Commit & Sip booth runbook

**The booth runs entirely in the canvas.** Attendees never open GitHub, a terminal, or an editor. Commands below are staff-only and run from the repository root unless stated otherwise.

**Not event-ready.** The moderation blocklist is an unreviewed placeholder, no leaderboard service is deployed, there is no public QR destination, and brand review has not happened. See those sections before running a public booth.

## Exercise shape

There is one learner step: **Name a drink for the house menu**. The [canonical instructions](../.github/steps/1-name-a-drink.md) match what the screen tells the attendee. Getting a handle, choosing a mascot and its placement, submitting a name, reading the score, and handing over are activities within that one step, not separate lessons.

The attendee flow is `idle → naming → served → complete`. Marking complete clears the counter for the next attendee; it does not remove the served drink from the house menu or the booth standings.

The earlier pull-request review flow and its live, pilot, and provisioning procedures were removed from this repository. Nothing here reads or writes GitHub. If an attendee asks about pull requests, explain that this station is the naming competition.

Reload extensions after changing extension code or the step document.

## Before a session

1. Use Node.js 22+ (`nvm use` reads the pinned `.nvmrc`) and a Copilot host supporting project canvas extensions.
2. Run `npm ci`, `npm test`, and `npm run check`. The extension SDK is host-resolved; do not install it.

   The booth *runs* without `npm ci` — a fresh clone serves both canvases and the whole attendee flow. What it loses is the **QR code on the served screen**: `qrcode` is a development dependency, so without it `renderQrDataUrl` returns `null` and the panel falls back to the plain link. That fallback is deliberate rather than a broken image, but it is easy to miss, so the extension now logs a warning at start-up when a leaderboard is configured and the encoder is absent. Treat it like the blocklist warning: read the start-up log. Verified by running a booth from a fresh clone both ways.
3. Keep the data directory writable by the booth operator and inaccessible to unrelated users. Default: `$COPILOT_HOME/extensions/commit-and-sip/artifacts/`, where `COPILOT_HOME` defaults to `~/.copilot`. To isolate a staff device, set `COMMIT_AND_SIP_DATA_DIR` to an approved absolute directory before launching the host. Do not point it into the repository.
4. Reload extensions in the host. List loaded extensions, then inspect the project `commit-and-sip` entry and its log if it is failed. Reinspect after reload; file existence alone is not evidence the provider is running.
5. **Read the start-up log.** A moderation warning means the blocklist is still an unreviewed placeholder. Treat it as a release blocker, not noise.
6. Open `commit-and-sip` with no input, or `{}`, and complete a warm-up run yourself. Check keyboard access, text status, visible error messages, and that hand-over returns the counter to idle.

Host tool sequence: `extensions_reload` → `extensions_manage` with `list`/`inspect` → `list_canvas_capabilities` → `open_canvas`. These names are not terminal commands. Use the actual loaded extension ID and log location reported by the host.

Choose a distinct panel `instanceId`. Actions address that instance; persistent data uses the run ID the station mints.

## Staff configuration

The booth reads one optional ignored file, `booth/local-config.json`, with a single supported key:

```json
{"leaderboardUrl": "https://example-leaderboard-host/board"}
```

The URL must be public HTTPS with no credentials, fragment, or nonstandard port. Retired pull-request keys (`mode`, `runs`, `repo`, `requiredChecks`) are rejected on start with a `retired_config` diagnostic rather than ignored, so a stale config cannot look configured. A valid JSON file containing `null`, an array, or a scalar is not valid staff configuration; correct it using the explicit `invalid_config` diagnostic rather than treating it as a network error.

Never put credentials in that file, the renderer, the repository, or a QR URL.

## Moderation blocklist — review required before publishing attendee names

The booth publishes attendee-invented names on the house menu, so the blocklist is event-safety configuration, not a code detail. `booth/blocked-terms.json` ships as an explicit placeholder: `review.placeholder` is `true`, the entries only demonstrate the two match modes, and no moderation decision has been made. The booth still runs with it, and the extension logs a warning naming the gap every time it starts in booth mode. Treat that warning as a release blocker, not noise.

To make it event-ready, replace `entries`, set `review.placeholder` to `false`, and record `reviewedBy`, `reviewedAt`, and `source`. `blocklistStatus` refuses to report readiness until all of those are present, so a half-finished edit cannot look approved. Have a named human owner accept it. Nothing in this repository certifies a list as adequate.

[Sourcing the moderation blocklist](../docs/blocklist-sourcing.md) sets out where terms can come from and why a short reviewable list is recommended over a large vendored one. It is a proposal, not an approval.

Choose the match mode deliberately. `substring` rejects every name containing the fragment anywhere, so reserve it for terms that are never part of an innocent word. `word` requires the term to consume whole words, so `grind` does not reject `Grinder`. Getting this wrong is the common failure: an over-broad `substring` entry silently rejects ordinary names at the counter, and attendees see only "That name is not available."

This is the only moderation list. An earlier `blockedTerms` array in `booth/name-rules.json` was removed because it used a plain substring test with no evasion resistance and no word mode, and this procedure never mentioned it — so a reviewer could follow these steps exactly and leave a second list untouched. The key is now rejected at start-up rather than ignored. If a station fails to start citing `blockedTerms`, move those terms into `entries` here and delete the key.

Do not add spaced, doubled, or leetspeak spellings of a term you already list. Matching folds digits to letters, removes spaces, hyphens, and apostrophes, and collapses repeated characters before comparing, and `word` mode also joins runs of consecutive tokens, so `b a d`, `b-a-d`, `baaad`, and `b4d` all reduce to the same entry. Extra variants add false positives without adding coverage.

The blocklist is one layer. The name charset already rejects non-ASCII, so homoglyph and zero-width evasion cannot reach the list, and links, mentions, and repeated punctuation are rejected structurally. None of that substitutes for human moderation of what a list should contain, or for brand and trademark review of names and artwork.

## Facilitate a run

1. Open the canvas and confirm the counter is idle before the attendee sits down.
2. Have them choose **Start my order**. The station mints their barista handle; write nothing down for them, the screen holds it.
3. Let them pick a mascot and where it sits, then type a name. The mascot may appear anywhere in the name; that placement is their choice, not a rule.
4. If the name is rejected, read the actual message and do not paraphrase it. A duplicate names itself — "Mona Meridian is already on the menu" — because that drink is already visible on the menu in front of them, so there is nothing to protect. The generic "That name is not available. Try another." means something else: a blocklist hit or a drink staff took down. Those two are worded identically on purpose, so never speculate aloud about which, and in particular never guess "someone already had that" — a duplicate would have said so itself.
5. Read the score breakdown with them. It is a published rubric, not Copilot's opinion, and every component is explainable from the screen.
6. Point out that "rank 1 of 1 at this booth" is this booth's menu only. Only a confirmed event line reflects the wider competition.
7. Finish with **I'm done — hand over to the next barista**.

Scores run from 1 to 5,000. Speed, retries, and accessibility assistance never reduce a score. Mona Latte, Copilot Cortado, and Ducky Cold Brew are worked examples: never scored, never ranked. Never describe a rubric score as model output, and never invent a judge's commentary.

## Reset between attendees

Hand-over is the reset. The attendee chooses **I'm done — hand over to the next barista** and the counter returns to idle for the next person. There is no reset command and none is needed.

Hand-over needs a served drink. If somebody leaves before naming one, see [closing an abandoned station](#closing-an-abandoned-station). Resetting the booth for a *new event* is a different operation: see [ending an event](#ending-an-event).

Hand-over deliberately keeps the served drink on the house menu and the entry in the booth standings. That is the point of the station: the menu grows through the event. If an attendee asks to remove their drink, that is a moderation decision for staff, not a self-service action. See [taking a drink down](#taking-a-drink-down).

## Staff dashboard

Staff operations have their own canvas, `commit-and-sip-admin`, opened with no input like the booth one. It is a **second canvas, not a mode of the attendee screen**: that screen faces a queue, so nothing on it can export, close a station, take a drink down, or erase an event. The booth canvas rejects those action names outright.

Open it on a staff device, or on the booth machine turned away from the counter. It shows removal reasons and staff names, so it is not a screen to leave facing attendees.

**Understand what separates this from the attendee screen.** Keeping staff actions off the booth canvas prevents *mis-routing*: the attendee-facing page cannot export, close a station, or erase an event, and the booth canvas rejects those action names outright. That is not an authorization boundary. Anyone who can drive this Copilot App session can open the staff canvas and archive the event, so **the thing actually protecting the ledger is physical control of the App** — not a permission check. Typing `wipe` and recording a staff name are deliberate friction and an audit trail, not authentication.

In practice: do not leave the App session unattended and unlocked at a staffed booth, and treat the machine running the booth as staff equipment. If an event needs a stronger guarantee than that, the dashboard should be run from a separate staff device rather than the booth machine.

It reports the event totals, which stations are still open, whether the blocklist is approved, whether a leaderboard is configured, where the data actually lives on disk, the house menu, the removals log, and the files written so far. Everything it shows is read from the same ledger the booth writes; it is a view, not a second source of truth.

The same drink takedown is available there as well as on the command line. The dashboard is more convenient mid-event; the command works when no host is running.

## Closing an abandoned station

Hand-over is the attendee's own action and it requires a served drink. An attendee who starts an order and walks away therefore leaves a station **nobody can hand over**, and that blocks the end-of-event archive.

Close it from the dashboard: pick the station under **Open stations**, give your name, and confirm. Any drink they already served stays on the house menu and in the standings — closing a station ends a turn, it is not a takedown. Who closed it is recorded in the ledger.

The booth screen returns to the house menu by itself the next time it is used or refreshed. It does not need to be closed and reopened, and the next attendee can start an order straight away.

## Ending an event

Everything an attendee produced lives on **this machine**, under the data directory, not in the repository. Deleting the cloned repository deletes the reviewed blocklist and the staff configuration while leaving every attendee name and removal record exactly where it was. It is not a cleanup. Do not use it as one.

The ledger is also **per machine**. A multi-station event has one menu and one set of standings per booth, and each machine is archived separately.

1. Close or hand over every open station. The archive is refused while an attendee is mid-order, because wiping under them would delete the drink on the screen in front of them.
2. Optionally **Export results** first. This is read-only and safe at any point during an event; it does not replace the archive, and the archive does not require it.
3. Under **End the event**, give your name and type `wipe` to confirm. Typed rather than clicked, because this erases every attendee record at this booth.
4. Read what the dashboard reports back: the archive path, and how many drinks and removals now exist **only** in that file.
5. **Copy the archive off this machine** before the device is reimaged, returned, or handed to another team. The dashboard cannot restore it, and nothing else holds a copy.

The order is archive, verify, then wipe. The archive is written inside the ledger lock so no run can slip in between, then read back off disk and compared against the ledger before anything is erased. The comparison covers the **whole ledger**, not just the totals, so an archive that is not a restorable copy cannot pass it. If the read-back does not match, nothing is wiped, the event survives, and the failed file is removed rather than left in `exports` where it could be mistaken for a good archive. Preserve the ledger and check storage before retrying.

Archives and exports are written to `<data directory>/exports`, never into the repository, and an existing file is never overwritten.

After a wipe the booth opens with only the three house examples, no standings, and no removals. Names reserved by the archived event are free again, so a drink invented at the last event can be invented again at the next one.

Retention of the archive files themselves — how long to keep them, who owns them, and when they are deleted — still needs approval. Do not invent a duration.

## Taking a drink down

A blocklist is a guess about what someone will type. This is the control that works after the fact, and it is why an imperfect list is survivable.

Removal is staff-only. The booth screen faces a queue, so a takedown control on it would let anyone delete a rival's entry; it lives on the [staff dashboard](#staff-dashboard) and on the command line instead. Both write through the same ledger lock as the booth, so either is safe to run while a station is live.

From the dashboard, choose the drink under **Take a drink down** and give your name and a reason. From a terminal, find the ID, then remove it, recording who you are and why:

```
npm run remove -- --list
npm run remove -- --id mona-something --by "your name" --reason "reported at the counter"
```

Both `--by` and `--reason` are required and the removal is refused without them. The record is kept in the ledger with the original name, the barista handle, and the time. That is deliberate: whoever answers for the decision later needs to see what was actually taken down.

What removal does:

- The drink leaves the house menu and the booth standings, and the remaining ranks close up.
- The name stays reserved. The next attendee retyping it is refused with the same "not available" wording as a blocklist hit, so the counter cannot tell the two apart and start speculating aloud about what somebody else typed.
- If the attendee is still at the station, their screen stops congratulating them and says the drink was removed. It shows no QR and no rank. Staff identity and your stated reason are never shown to the attendee.

What removal does **not** do: it cannot retract an entry a leaderboard service already accepted. The booth publishes; it has no retraction path. If a leaderboard is deployed and the entry was confirmed, remove it there too. The command says so every time.

House examples cannot be removed this way. They are booth configuration, so edit `booth/orders.json` instead.

If a panel is closed or the extension reloads mid-run, reopen the canvas. Saved state persists; the attendee resumes where they were.

## Offline, slow, and failed operations

| Symptom | Staff response |
| --- | --- |
| No network | Keep running. The booth is local-first and needs no network. Only the event leaderboard line is unavailable, and the canvas says so rather than inventing a rank. |
| Name rejected unexpectedly | Check the blocklist for an over-broad `substring` entry. Do not read the matched term aloud or add exceptions mid-session. |
| Entries stay unconfirmed on the event leaderboard | Expected while no service is deployed. Check the extension log before assuming a fault. |
| Panel connection lost | Reopen the canvas. Saved state persists. Do not share loopback URLs or tickets. |
| Counter stuck on a previous attendee | Use hand-over. If the UI does not respond, inspect the provider log before touching the store. |
| Unexpected provider error | Inspect the extension's host-reported log. Keep stack traces and internal identifiers off attendee screens and out of public reports. |

Avoid concurrent recovery operations from multiple panels against the same data directory.

## Lock and storage recovery

The store uses `ledger.json` and `ledger.lock`, with atomic fsynced ledger writes. Slow I/O can legitimately hold the lock. Leaderboard publication happens outside the lock by design, so a slow service never holds it.

1. Stop intake and note the affected run IDs. Inspect the exact provider log and lock metadata. Determine the actual data directory from the host environment; do not guess.
2. Verify the recorded lock-owner PID with `ps -p <pid> -o pid,ppid,lstart,command`. Compare the process identity and start time, not just PID existence; PIDs can be reused.
3. If the owner or provider is active, **do not remove the lock**. Allow the operation to finish, or shut down the specific extension or provider through the host. Check for other active providers sharing the directory.
4. Only after confirming no active provider or writer owns this store, back up the ledger and lock to an approved staff-only location. Keep backups out of Git and public attachments.
5. If the lock is proven stale, remove only that exact `ledger.lock`. Do not use wildcard deletion, erase the ledger, or kill processes by name.
6. Restart or reload one provider, inspect its health, reopen the canvas, and verify the ledger, house menu, and standings.

If ownership is uncertain, leave the lock in place and escalate. If JSON is corrupt or storage is full or unwritable, preserve evidence and restore only through a reviewed backup procedure. Do not replace it with an empty ledger to make the error disappear.

## Event leaderboard submission

The booth is local-first. A drink is committed to this booth's menu before anything is sent anywhere, so an unreachable event leaderboard cannot fail an attendee's submission or lose a name they earned. If submission fails, the attendee still sees their drink, their score, and their booth standing; only the event place is missing, and the canvas says so rather than inventing a rank.

No leaderboard client ships, because no destination is deployed. `leaderboardClient` is null by default and the canvas then shows no event line at all. A client implements `publish(submission)` and must own its own timeout; a booth must never wait on a slow service.

A failed submission retries on the next refresh, so a brief network outage recovers without staff. A receipt whose handle, name, or score does not match what was sent is recorded as a failure, not displayed: a service answering about a different entry must never be shown as this attendee's rank. Check the extension log if entries stay unconfirmed.

Read ranks carefully when helping an attendee. "Rank 1 of 1 at this booth" is this booth's own menu and nothing more. Only a confirmed event line reflects the wider competition.

## Leaderboard and QR readiness

There is no approved deployment or public URL yet. A local `127.0.0.1` renderer cannot host an attendee phone experience, and repository assets are not a public destination. Never use credential-bearing URLs to make private images appear public.

After the public destination is approved and configured:

```sh
npm run qr -- <configured-HTTPS-leaderboard-URL>
```

Review the generated `.github/images/leaderboard-qr.png` and scan it from a personal phone on attendee Wi-Fi or cellular, without staff credentials. Confirm the exact destination, high contrast, quiet zone, descriptive alternative text, and a readable fallback link. No placeholder image may be labeled a scannable production QR.

The canvas renders its own QR server-side as a data URL, because the content security policy forbids remote scripts. This script is for producing a reviewable PNG artifact, not for the in-canvas code.

The generator verifies public URL reachability before producing the PNG and its `.github/images/leaderboard-qr.png.json` manifest, which records the encoded URL and the PNG SHA-256 digest. Retain and review both together. Automated tests independently decode generated QR images with `jsqr`, but that does not replace a phone scan of the real published destination.

## Daily operations

Before opening: validate host and extension health, confirm the start-up log is free of the moderation warning once the list is approved, and complete a staff warm-up run.

Keep staff-only daily observations of completion time, staff intervention, rejected-name causes, and hand-over success. The preserved outline proposed these targets:

- At least 85% complete without staff intervention.
- Median completion within five minutes.
- Consistent hand-over between attendees.

Those are historical proposed targets, not results already achieved. Measurement tooling is unresolved. Do not invent evidence.

### What has actually been measured

The **system** is not the constraint. Twenty scripted runs on one booth machine, growing the menu from 3 to 23 drinks, put the whole engine path at a **76 ms median and 150 ms worst case** — counter load, minting a handle, scoring and serving, and hand-over combined. It does not slow down as the menu fills.

The **reading burden** is measurable too: roughly 136 words on the counter screen, 177 on the naming screen, and 143 on the served screen. At normal adult silent reading rates that is somewhere under two to about three minutes across the whole flow, and the naming screen is the heaviest.

Nothing here establishes the five-minute median, and it should not be quoted as if it does. The dominant term is an attendee inventing a name, which no scripted run can simulate — one person takes fifteen seconds and the next stares at the field for two minutes. Rejections add a whole further think, and collisions get *more* likely as the menu fills, so a median measured early in an event will understate the end of it. That needs timing real people, including at least one session late in a busy event.

End of day: preserve approved backups, close panels, and stop intake. At the end of the whole event, follow [ending an event](#ending-an-event) and copy the archive off the machine. Event-data retention period, deletion schedule, responsible owner, and access policy still need approval; do not invent a duration or delete records while the event continues. Publish only approved anonymous outputs.
