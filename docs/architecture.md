# Architecture and validation

## Components

| Component | Responsibility |
| --- | --- |
| `extension.mjs` | Join the SDK session, load the catalog, name rules and optional staff config, and register the booth canvas |
| `canvas.mjs` | Declare the canvas, its action schemas, and panel lifecycle |
| `booth-panel.mjs` | Bind one open panel to the local service and dispatch validated actions |
| `booth-engine.mjs` | Attendee phase machine: handle, name validation, scoring, house menu, leaderboard publication |
| `domain.mjs` | Shared validation helpers, catalog loading, curated handle generation, staff config validation |
| `store.mjs` | Persistent ledger, exclusive file lock, atomic fsynced persistence |
| `server.mjs` | Loopback HTTP boundary and renderer assets; dispatches only validated actions |
| `renderer/` | The single attendee screen; presentation and controls only |
| `services/coffee-name.mjs` | Name rules, mascot and placement validation, blocklist lookup |
| `services/name-score.mjs` | Deterministic rubric scoring out of 5,000 |
| `services/booth-menu.mjs` | House menu projection, duplicate detection, standings |
| `services/moderation.mjs` | Evasion-resistant blocklist matching and readiness reporting |
| `services/leaderboard.mjs` | Client seam for an event leaderboard; no client ships today |
| `services/qr.mjs` | Server-side QR data URLs, required because CSP forbids remote scripts |
| `services/public-url.mjs` | Strict public-HTTPS validation and reachability checks for any configured leaderboard |
| `booth/` | Orders, curated handle words, name rules, blocklist, runbook |
| `scripts/` and `tests/` | Maintainer validation, Node version guard, approved-URL QR generation |

The engine owns every authoritative fact. The browser renders a projection and requests actions; it cannot set a score, a handle, or a menu entry.

## Booth flow

```text
idle → naming → served → complete → (reset for the next attendee)
```

An attendee starts, receives a curated three-word handle, chooses a mascot and where to place it, submits a name, receives a rubric score, sees their standing, scans a QR code, and marks complete. Marking complete clears the counter for the next attendee; it does not erase the served result or the house menu.

There are no pull requests, GitHub writes, issues, reviewers, merges, or checks in this flow. The earlier pull-request review mode, its provisioning scripts, and its canvas pilot were removed rather than left dormant, so no code path can silently reach GitHub.

## Naming rules and scoring

A name must match the allowed character set, contain exactly one of the three mascots in the attendee's chosen placement, stay within length limits, avoid duplicates already on the house menu, and pass the blocklist. Duplicate detection compares normalized names so spacing and case cannot smuggle a repeat onto the menu.

Scoring is a deterministic rubric in `services/name-score.mjs`, not a language model. The same name always scores the same, a rank can be recomputed from stored names, and staff can explain any score from the returned breakdown. The component maximums sum to exactly 5,000 and a test pins that total, so "out of 5,000" stays true. The three seeded drinks are worked examples and are never scored or ranked. Never describe a rubric score as Copilot's opinion.

The rubric lives in code rather than in a data file. `booth/scoring-rubric.json` described the retired pull-request flow, was read by nothing, and was removed. An attendee-facing published rubric would need a test pinning it to the scorer to prevent drift.

## Moderation

`services/moderation.mjs` folds digits to letters, strips separators, and collapses repeats on both sides before matching, so `b4d`, `b a d`, and `baaad` cannot evade a listed term. Word-mode matching joins runs of consecutive tokens for the same reason. The name character set rejects non-ASCII before the blocklist runs, so homoglyph and zero-width evasion is structurally impossible and no confusable table is needed.

`booth/blocked-terms.json` ships as an explicit placeholder. Its content is a human moderation decision, not a generated list. `extension.mjs` logs a warning on every start while the list is unreviewed, so a booth cannot quietly publish attendee names behind an unapproved filter.

## Leaderboard seam

Publication is local-first. The engine commits the served result inside the store transaction, releases the lock, and only then attempts a remote publication. A failed publication never blocks or alters the attendee's local result; a refresh retries it.

Receipts are accepted only when the handle, name, and score match what was submitted. A mismatched receipt is recorded as a failure and never displayed. The payload deliberately excludes the run ID, device, and booth identity.

No leaderboard service is deployed and `leaderboardClient` defaults to null. Any configured URL must pass `validateLeaderboardUrl`: HTTPS only, no credentials, fragment, or nonstandard port, and no private, loopback, reserved, or reserved-suffix host. Do not present a placeholder QR as a production destination.

## Canvas color palette and typography

The booth screen uses an intentionally light green-and-white palette in `renderer/style.css`: white canvas, pale-green supporting surfaces, forest-green text and primary actions, and a dark-green menu with white lettering. Semantic tokens cover text, muted text, borders, action/hover/focus, menu contrast, and red error feedback. Host color overrides are intentionally unused so a dark surrounding App cannot replace the requested white canvas. Errors keep literal messages and distinct red treatment; progress uses labels and borders rather than color alone. `tests/palette.test.mjs` checks authored text, control, and focus contrast, including disabled controls.

**Mona Sans** handles reading, controls, headings, and menu display; run data and numeric results retain the host monospace stack with tabular figures. The two unmodified variable WOFF2 files come from [GitHub's Mona Sans v2.0.27 webfont release](https://github.com/github/mona-sans/releases/tag/v2.0.27), stored under shorter filenames in `renderer/fonts/` with the original [SIL Open Font License and copyright notice](../.github/extensions/commit-and-sip/renderer/fonts/OFL.txt). Tests pin their SHA-256 digests. The page preloads the normal face from the loopback server; CSP allows only same-origin fonts. No external font service or attendee download is involved.

## Trust and privacy

The loopback server is an implementation detail, not public hosting. It uses a per-panel connection ticket, same-origin and host checks, and bounded JSON actions. Do not share its URL or ticket.

The ledger lives outside the checkout by default, under `$COPILOT_HOME/extensions/commit-and-sip/artifacts/`, with `COPILOT_HOME` defaulting to `~/.copilot`. `COMMIT_AND_SIP_DATA_DIR` is a staff-only absolute-directory override. `ledger.lock` serializes file access and writes use atomic replacement with fsync. A lock is not safe to delete merely because a UI appears frozen; see [lock recovery](../booth/RUNBOOK.md#lock-and-storage-recovery).

Attendee handles are curated three-word phrases, not identities. Do not commit ledger data or loopback connection URLs. The booth reads one optional staff file, `booth/local-config.json`; retired pull-request keys in it are rejected rather than ignored so a stale config cannot look configured.

## Validation

Run from the repository root:

```sh
nvm use
npm ci
npm test
npm run check
```

`scripts/require-node.mjs` runs as `pretest`/`precheck` and from the QR script. It compares `process.version` with the `engines.node` floor and exits non-zero with switch instructions instead of letting an unsupported runtime proceed. This matters because the loopback `fetch` suites never release Node 18's experimental undici handles, which previously made `npm test` hang with no output rather than fail. `npm test` also passes `--test-timeout` and `--test-force-exit`, `.nvmrc` pins the major version for `nvm use` and CI, and `.npmrc` sets `engine-strict`.

Keep regression coverage for:

- Handle generation, uniqueness, and the curated collision suffix.
- Name validation: character set, length, mascot presence and placement, duplicates, and blocklist evasion.
- Rubric determinism and the 5,000-point total.
- Phase transitions, including that completing clears the counter without erasing the served result or house menu.
- Local-first publication, receipt mismatch rejection, and retry on refresh.
- Loopback action boundaries: capability ticket, exact origin and host, content type, and bounded bodies.
- Palette contrast, bundled font provenance, and QR decoding of the generated image.

### Browser verification is required for the attendee form

Two real defects reached a fully green suite and were caught only in a browser: a `required` attribute on a control whose default option had an empty value, and a mascot picker that defaulted to a real selection the attendee never made. API-level tests do not exercise HTML form validation or default-selected `<option>` semantics. Any change to `renderer/booth.html` or `booth.js` needs a browser walkthrough, not just `npm test`.

## Release evidence still needed

1. Authentic App captures and a keyboard, touch, and accessibility walkthrough.
2. A reviewed moderation blocklist, approved by a human before any public booth use.
3. A deployed leaderboard service and a real public QR destination, verified by scanning from a phone.
4. Brand and trademark review of the mascot names and artwork.
5. A decision on public template visibility.

Passing local tests is not acceptance evidence for any of these.

The [approved outline](exercise-outline.md) remains unchanged. Its source SHA-256 is `8a9090ed93894edfb6e17fc322dde0e1a8ee05cfcd16bfe125edba0df02443b6`. That outline describes the original pull-request shape; the current booth flow supersedes it and clarifications belong here, not in edits to that preserved source.
