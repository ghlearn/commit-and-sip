# Commit & Sip: booth staff cheat sheet

Quick reference for a configured booth. [First-time setup](../README.md#run-commit--sip-in-the-github-copilot-app) | [Full runbook](RUNBOOK.md)

**Before public use:** moderation and brand/trademark/privacy reviews are still outstanding. Complete the [launch reviews](../README.md#status-a-working-booth-station-not-event-ready); a working station is not event approval.

## Open the booth

Start an **Interactive** session under **Projects** for this repository, not **Chats**. Copy these prompts into Copilot using each block's copy button.

**One-prompt setup.** Copilot asks for the location of `local-config.json` first, and you give it a path, never the keys:

```text
Ask me for the location of the folder or file that holds the booth's local-config.json (the leaderboard keys).
Copy it, don't symlink it, to booth/local-config.json without ever exposing the keys: first create an empty temporary file next to the destination and make it owner-only (chmod 600 and chmod -N on macOS), then copy the contents into that file, then rename it over booth/local-config.json. Never print or echo the keys.
Reload extensions and confirm commit-and-sip is running.
Then open the Commit & Sip attendee canvas, the Commit & Sip staff canvas, and a browser canvas at https://gh.io/commit-and-sip-leader.
```

Or step by step:

```text
Reload extensions and list them.
```

Confirm `commit-and-sip` is **running** and inspect start-up warnings before continuing.

```text
Open the commit-and-sip canvas with no input and a browser canvas at https://gh.io/commit-and-sip-leader.
```

Do a warm-up run: scan the attendee QR from a phone, then hand over and confirm **Start my order** returns.

On **this booth machine**, turn the screen away from attendees before opening staff controls:

```text
Open the commit-and-sip-admin canvas with no input.
```

Keep the staff panel out of view of the queue. It exposes staff details and destructive controls. Lock the App/device whenever unattended.

## One attendee

1. Choose **Start my order**. The screen assigns a barista handle; no GitHub account, terminal, or editor is needed.
2. Let them invent a name containing `mona`, `ducky`, or `copilot` anywhere, with more than the mascot alone. The screen has only a name field, with a hint that a mascot is required; the station reads the mascot and placement from the name.
3. Choose **Add it to the menu**. The score is **1 to 5,000**, from a deterministic rubric, not an AI judge. Mid-range scores are normal; placement, speed, and retries do not affect points. House examples are never scored or ranked.
4. Let them scan their personal leaderboard QR or use its link before choosing **I'm done - hand over to the next barista**. Confirm the counter is idle before inviting the next person. Hand-over keeps their drink and score.

Only a **confirmed event rank** describes the shared leaderboard; a booth rank is local. Never invent commentary or improve a name on the attendee's behalf.

## Quick fixes

| Situation | Staff action |
| --- | --- |
| Connection lost | Choose **Refresh connection**; reopen the canvas if needed. Saved drinks and scores persist. |
| Attendee leaves mid-order | Staff dashboard: **Open stations**, select the station, give your name, and close it. Do not wipe the event. |
| Name rejected | Read the actual message. Let the attendee try another; do not guess whether a generic rejection was moderation or a previous removal. |
| Offline or leaderboard unreachable | With a leaderboard configured, nothing is served until it admits the drink: the attendee stays naming and tries again in a moment, and a retry never adds the drink twice. Use **Refresh and retry** on the staff dashboard. |
| "Another drink already has that score" | Normal. Let the attendee tweak the name (add, swap, or respell a word) and submit again. |
| Drink needs removal | **Take a drink down**: select it, give your name and reason. Confirm the public outcome. Pending takedowns need **Refresh and retry on this same booth**, with deployed staff keys; follow the [takedown guide](RUNBOOK.md#taking-a-drink-down). |

For extension failures, inspect privately:

```text
Show the log for the commit-and-sip extension.
```

Do not expose logs, keys, or staff details to attendees. Storage/lock errors: stop intake and follow [recovery](RUNBOOK.md#lock-and-storage-recovery); never erase the ledger or guess which lock to delete.

## Links and settings

| Purpose | Setting in `booth/local-config.json` | Current value |
| --- | --- | --- |
| Attendee board / QR | `leaderboardUrl` | Default: <https://gh.io/commit-and-sip-leader>; `null` hides the QR. |
| Publishing service | `leaderboardApi.url` | This event: <https://commit-and-sip-leaderboard.azurewebsites.net>; no automatic default. |

Use [URL configuration instructions](RUNBOOK.md#leaderboard-urls) to change these safely, then reload extensions and reopen the canvases: the booth reads them only at start-up. Replace the URL in the launch prompt too. Keep the key-holding file owner-only; never paste it into chat.

## Close safely

**Shift ending, event continuing:** stop intake, preserve approved backups, and close panels. Do not wipe the ongoing event.

**Whole event ending:** follow [Ending an event](RUNBOOK.md#ending-an-event).

1. On **every booth**, close open orders. In **End the event**, give your name and type `wipe`; this archives and resets that booth. If pending publications or takedowns block it, resolve them first.
2. Verify the reported archive and **copy it off each machine**. Exporting results alone is not an archive.
3. **Only after every booth is archived, reset, and backed up**, use a staff-key machine to **Check the public leaderboard**, give your name, and confirm `clear board`. This clears the shared board for everyone. If the result is uncertain, check the board before retrying.

Deleting the repository does **not** delete attendee data.
