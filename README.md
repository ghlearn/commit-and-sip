# Commit & Sip

**Order Up at the Level Up Lounge:** a five-minute, app-only naming competition. Invent one coffee that carries `mona`, `ducky`, or `copilot`, get it scored out of 5,000 by a local rubric, and put it on the house menu for the rest of the event.

## One step, entirely in the App

**Audience:** beginners and GitHub-curious booth attendees. **Goal:** invent a drink name nobody has served here yet. **Duration:** about five minutes, with no speed or hint penalties.

You need only the booth's preconfigured Copilot App. No coding, cloning, account setup, GitHub sign-in, terminal, or external editor is required, and the attendee never opens a pull request. Staff supply the device and handle setup and recovery.

**Open:** click **Commit & Sip** with no input. The booth canvas is the default canvas and takes no open input; the counter opens idle and ready.

**Start:** choose **Start my order**. The station mints a barista handle, then follow **Step 1: Name a drink for the house menu**: pick a mascot and where it sits, type your name, and choose **Add it to the menu**. The [canonical learner step](.github/steps/1-name-a-drink.md) matches what the screen tells you.

**Finish:** read the score breakdown, take your place on the leaderboard, then choose **I'm done - hand over to the next barista**. That clears the counter for the next attendee; your drink stays on the menu and your entry stays on the leaderboard. See the [reset procedure](booth/RUNBOOK.md#reset-between-attendees).

Mona Latte, Copilot Cortado, and Ducky Cold Brew are worked examples. They are never scored and never appear on the leaderboard. The menu is first come, first served, so a name already taken is reported back and you try another.

This is a canvas-led adaptation of a GitHub Skills exercise: one learner step with several activities, not a five-step course. Staff setup is outside the learner step. Actions validate the repository; they do not drive learner transitions, create exercise issues, or gate play on workflow queue time. There is no Step 2 or automatic issue closure.

## Status: a working booth station, not event-ready

Commit & Sip is a project-local Copilot App canvas extension, registered as `commit-and-sip`. The booth flow runs end to end today: handle, name validation, rubric score, house menu, standings, and hand-over all work locally and persist across panel closure and extension reload.

It is **not** event-ready. Four things are missing and none of them is code:

- **The moderation blocklist is an unreviewed placeholder.** `booth/blocked-terms.json` ships with no real terms, and the extension logs a warning on every start while that is true. A human must review and approve the list before attendee names go on a public menu. Staff can take a drink down after the fact with `npm run remove`, which is what makes an imperfect list survivable, but that is a response and not a substitute.
- **No leaderboard service is deployed.** The client seam exists and is local-first, so a missing service never blocks an attendee, but nothing receives submissions.
- **There is no public QR destination.** Do not publish a placeholder QR as a production link.
- **Brand, trademark, and privacy review** of the mascot names and artwork has not happened.

The earlier pull-request review flow, its live and canvas-pilot modes, and its provisioning scripts have been removed. No code path in this repository reads or writes GitHub.

## Staff: open the booth

Staff need Node.js 22 or newer and a Copilot App/CLI build supporting project canvas extensions. The pinned version lives in `.nvmrc`; run `nvm use` before npm scripts. Open this repository in that host.

1. Reload extensions after checking out or changing extension files.
2. List extensions and confirm the project `commit-and-sip` extension is loaded. If it fails, inspect its entry and log before continuing.
3. Watch the log on start. A moderation warning means the blocklist is still unreviewed.
4. Inspect the registered `commit-and-sip` canvas capabilities.
5. Open the canvas with no input, or `{}`. The counter opens idle and ready for the next attendee.

To take a drink off the menu, see [taking a drink down](booth/RUNBOOK.md#taking-a-drink-down). Removal is a staff command, deliberately not a button on the attendee screen.

An agent driving the host uses `extensions_reload`, `extensions_manage` (`list`/`inspect`), `list_canvas_capabilities`, `open_canvas`, and `invoke_canvas_action`. These are host tools, not shell commands. Discover the loaded extension and provider identifiers instead of inventing them. Choose a panel `instanceId` when opening, then reuse that panel handle for actions.

The host resolves `@github/copilot-sdk/extension` automatically. Do not install an SDK package to run the extension. Maintainers use:

```sh
nvm use
npm ci
npm test
npm run check
```

`npm ci` installs development dependencies, including the QR generator; it is not an attendee step.

`npm test` and `npm run check` refuse to start on Node older than the `engines` floor, and `npm ci` fails the same way because `engine-strict` is enabled. That guard is deliberate: on Node 18 the loopback `fetch` suites leave experimental undici handles open, so the run hangs forever instead of reporting failures. The suite also runs with a per-test timeout and forced exit, so a leaked handle cannot stall it.

## What attendees practice

- Read the constraints before submitting: one mascot, a chosen placement, an allowed character set, and no duplicate already on the menu.
- Treat a published rubric as something you can reason about and improve against, rather than guessing at a black box.
- See their own contribution land on a shared artifact that the rest of the event can see.

Scores run from 1 to **5,000** and come from a deterministic rubric in code, not a language model. The same name always scores the same. Speed, retries, and accessibility assistance do not reduce a score. Mona Latte, Copilot Cortado, and Ducky Cold Brew are worked examples: never scored, never ranked.

## Documentation

| Document | Audience |
| --- | --- |
| [Step 1: Name a drink for the house menu](.github/steps/1-name-a-drink.md) | Canonical learner instructions |
| [Learner entry guide](docs/learner-guide.md) | Attendees and facilitators |
| [Booth runbook](booth/RUNBOOK.md) | Setup, moderation, recovery, reset, and event staff |
| [Integration contract](docs/integration-contract.md) | Leaderboard and service implementers |
| [Architecture and validation](docs/architecture.md) | Maintainers |
| [Asset capture checklist](.github/images/README.md) | Authentic screenshots, accessible QR, branding |
| [Order Up skill](.github/skills/order-up/SKILL.md) | In-app guided facilitation |
| [Approved exercise outline](docs/exercise-outline.md) | Preserved design source |

The approved outline is preserved verbatim, including its original proposals and open questions. It describes the original pull-request shape of this exercise. The booth naming competition supersedes it; current decisions live in this README, the architecture notes, and the integration contract, not in edits to that preserved source.

## Staff configuration and data

The booth reads one optional ignored file, `booth/local-config.json`. It currently supports a single key:

```json
{"leaderboardUrl": "https://example-leaderboard-host/board"}
```

That URL must be public HTTPS with no credentials, fragment, or nonstandard port. Retired pull-request keys such as `mode`, `runs`, `repo`, and `requiredChecks` are rejected on start rather than ignored, so a stale config cannot look configured. Never put credentials in that file, the renderer, the repository, or a QR URL.

State persists in `$COPILOT_HOME/extensions/commit-and-sip/artifacts/ledger.json`; `COPILOT_HOME` defaults to `~/.copilot`. Staff may set `COMMIT_AND_SIP_DATA_DIR` to an absolute directory before the host launches. The store uses `ledger.lock` and atomic, fsynced writes. Closing or reloading a panel does not reset the booth, and hand-over does not erase the house menu.

Neither a device's loopback renderer nor repository assets are public phone destinations. Do not publish an event QR until an approved, publicly reachable HTTPS leaderboard exists.
