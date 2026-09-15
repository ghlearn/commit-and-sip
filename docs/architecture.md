# Architecture and validation

## Components

| Component | Responsibility |
| --- | --- |
| `extension.mjs` | Join the SDK session and wire configuration, error reporting, and live adapters |
| `canvas.mjs` | Declare the canvas and schemas, permit empty setup opens, guard assignments and manage panel lifecycle |
| `panel.mjs` | Bind explicit new/resume rehearsal selections to a running panel; preserve stable run identity and forbid switching/fallback |
| `domain.mjs` | Orders, domain validation, rehearsal fixtures, safe public run projection, handle generation |
| `content.mjs` | Load the canonical single-step guide and Markdown templates; render catalog-driven rehearsal instructions, field-specific feedback, and final learning summary |
| `store.mjs` | Persistent run/result ledger, exclusive file lock, atomic fsynced persistence |
| `engine.mjs` | State transitions, factual checkpoint, live evidence gates, approval/serve separation, completion retries |
| `server.mjs` | Per-panel loopback HTTP boundary and renderer assets; dispatch only validated actions for the bound run |
| `renderer/` | Attendee presentation and controls; not an authority for live review evidence |
| Service adapters | Server-side GitHub and completion integration; see the integration contract for unresolved native evidence |
| `services/authority.mjs` | `CompletionAuthority`: independent server-owned evidence validation, durable receipt/handle reservation, comment finalization, anonymous leaderboard projection; not a hosted/authenticated service |
| `services/pilot.mjs` | Read-only assigned issue/PR preflight using shared assignment validation and the independent GitHub adapter; never certifies host or event readiness |
| `services/live.mjs` | Post-`joinSession` live adapter wiring; authenticated completion submission, finalized receipt verification, and local state update; no local completion-comment writes |
| `booth/` | Machine-readable orders, curated handle words, scoring, staff example configuration, runbook |
| `scripts/` and `tests/` | Maintainer validation, explicit rehearsal reset, approved-URL QR generation |

The state/engine/server/renderer/services boundaries matter: the browser renders a public projection and requests actions; only the engine and trusted service adapters may validate authoritative facts.

## Single-step content and lifecycle

`.github/steps/1-review-and-serve.md` is the canonical learner guide, presented inside the rehearsal canvas as text-only sections. Keep its format to one Step 1 title, level-two headings, and plain paragraphs; the small content parser rejects unsupported structure instead of guessing how to render it. `.github/markdown-templates/` contains rehearsal-order, order-feedback, and step-completion copy. Template inputs must be present and unresolved placeholders fail explicitly. No runtime package or external Markdown service is needed.

The public `exercise` projection is computed from current content, not persisted as another source of truth. Existing runs keep their assigned issue bodies and saved state. Fresh rehearsal issues use the current template and catalog. Completion copy is available only after finalization; it never substitutes for the authority's live receipt or comment. The UI moves keyboard focus to the result after a successful serve/retry and offers an in-panel link back to Changes for incorrect checkpoint answers.

The existing state phases are activities within one Skills step. Actions validate code and menu data only; they do not initialize learner issues, advance steps, close issues, or compete with `CompletionAuthority.finalize`. Staff preparation is outside the learner step. Future native PR panels may open elsewhere inside the App, but trusted live evidence remains unresolved.

## Canvas color palette

The setup and exercise share an intentionally light green-and-white palette in `renderer/style.css`: white canvas and receipt, pale-green supporting surfaces, forest-green text and primary actions, and a dark-green menu with white lettering. Semantic tokens cover text, muted text, borders, action/hover/focus, menu contrast, and red error feedback. The host monospace font token is retained; host color overrides are intentionally not used so a dark surrounding App cannot replace the requested white canvas. Both HTML entrypoints declare a light color scheme; forced-colors support remains available.

Cup and saucer artwork use the same palette tokens, with brown reserved for the coffee itself. Errors retain literal messages and distinct red treatment; progress still uses labels and borders rather than color alone. `tests/palette.test.mjs` checks the authored text, controls, and focus contrast ratios, including disabled controls. Palette values are locally authored, not outputs from an asset-generator service.

## Typography and pilot presentation

Green-and-white colors remain unchanged. **Mona Sans** handles reading, controls, headings, the cafe title, receipt drink name, and menu display. Code and run/revision data retain the host monospace stack. Guide paragraphs have a 70ch maximum measure, stronger label hierarchy, and readable menu copy; numeric results use tabular figures.

The two unmodified variable WOFF2 files come from [GitHub's Mona Sans v2.0.27 webfont release](https://github.com/github/mona-sans/releases/tag/v2.0.27): `MonaSansVF[opsz,wght].woff2` and `MonaSansVF-Italic[opsz,wght].woff2`, stored under shorter filenames in `renderer/fonts/`. Both cover weights 200–900 and optical sizing; the separate italic face avoids synthesized italics. The original [SIL Open Font License and copyright notice](../.github/extensions/commit-and-sip/renderer/fonts/OFL.txt) accompany them. Tests pin their SHA-256 digests to preserve upstream provenance.

Both pages preload the normal face from the loopback server; italic loads on demand. `font-display: swap` keeps text visible during loading, and system sans-serif remains the fallback. CSP allows only same-origin fonts, served through explicit asset routes with `font/woff2` MIME types. No external font service, device font installation, or attendee dependency download is needed. Mona Sans is an explicit user choice, not an asset-generator output.

## Live pilot foundation

`RunEngine.syncReview` reads only an injected trusted provider and independently rechecks the PR head, menu and checks. The shared `runTransaction` boundary applies durable revocation to live verification in start, synchronization, checkpoint, approval (including post-write verification), serving, and completion. When a verification gate fails, it restores the pre-action run, clears views, evidence head, assessment success, copied review data, and synchronization time, commits under the same store lock, and then rethrows the original error. Previously saved phases, events, issue, served menu/revision, handle, and result identity remain intact. Invalid input and completion-service transport errors retain normal transaction rollback and do not revoke valid evidence. Normal refresh remains read-only. Capability and assignment projections let the canvas explain why native verification is blocked without exposing reviewer identities. The shipped extension still lacks a real provider.

`preflight-live.mjs` calls `inspectLivePilot` with the real GitHub adapter, never a write method. It verifies the prepared issue/PR and reports `liveReady: false`, exiting 2 even when those GitHub checks pass. It is not a readiness bypass or a deployment. `tests/pilot.test.mjs` covers GET-only behavior, failed/used assignments, invalid evidence, progress revocation, read-only refresh, and durable served state without event success.

Live serving records the actual merge SHA with the menu. The **Your app result** panel is separate from accepted event results: it can show a served drink and pending finalization without a score, issue comment claim, or completion summary. The live step guide explains this distinction and keeps all learner work inside the App. Native navigation remains a host integration dependency, not a guessed URL scheme.

## Canvas opening and setup

The existing SDK registration is retained, with its declaration extracted into `canvas.mjs` for direct lifecycle testing. Empty/omitted open input displays `renderer/launcher.html`; partial assignments are still invalid. This fixes the previous empty-open `runId`/`mode` schema failure without inventing those values or silently creating a rehearsal.

`PanelRun` is an ephemeral binding shared by SDK and HTTP actions. An explicit new selection calls the existing engine with atomic `requireNew`; resume first verifies the ID exists and is rehearsal. A panel cannot switch runs, and overlapping selections cannot create two runs behind one panel. Same-selection retries reconcile uncertain responses; `refresh` returns either setup or the bound run. Live setup remains staff-assigned via a complete open input.

The server serves the launcher until selection, then the existing exercise page at the same URL. Selection is protected by the existing ticket/origin/host checks. Launcher input and returned catalog names render as text, not HTML. A suggested ID is not a persisted run; no attendee data is enumerated. On provider restart, empty-input opens return to setup and require explicit resume by domain run ID. Complete assignments rehydrate directly. Neither path deletes or rekeys saved exercise data.

## State and retry behavior

```text
order → reviewing → approved → served → completed
           ↑
      inspect + checkpoint
```

Rehearsal progresses through local fixtures. Live progression adds independent GitHub and trusted native evidence gates. Live `view` actions cannot certify native views. `approve` checks prerequisites and records/verifies approval; it never merges. `serve` requires the actual authorized merge and validates the resulting menu.

Approval reserves a private assignment-bound attempt before any GitHub write. Its exact marker is placed in the SHA-bound review body. Matching effective approvals can be reconciled after a lost response or post-write verification failure without accepting pre-existing or unrelated approvals. The attempt survives revocation and restart, but never enters the renderer projection.

Serving is durable before finalization. Completion reserves the generated handle in storage before remote submission. If the completion endpoint or issue update is unavailable, retry `complete` for the same run. Completed results must not be recreated, renamed, or posted as duplicate issue comments on refresh/reopen/retry.

The ledger lives outside the checkout by default, under `$COPILOT_HOME/extensions/commit-and-sip/artifacts/`, with `COPILOT_HOME` defaulting to `~/.copilot`. `COMMIT_AND_SIP_DATA_DIR` is a staff-only absolute-directory override. This keeps results across panel closure, extension reload, and worktree changes. Do not commit ledger data or browser connection URLs.

The deployed `CompletionAuthority` needs its own dedicated server store, separate from this client rehearsal ledger. Its `accept({runId, handle})` recomputes eligibility from server-owned assignments and independent GitHub, native-view, and acceptance-checkpoint readers; callers cannot supply evidence or scores. The assignment pins the target base branch, effective required checks, and trusted approval-attempt UUID with chronological native-review/checkpoint/decision timestamps. Reader completion times must match that registration, and GitHub must confirm this attempt's effective marked review on the assigned head/base plus a submission time not preceding the decision at GitHub's second precision. Generic reviewer approval alone cannot certify completion.

The engine likewise pins the application branch and effective check list when a live run is created, uses them for subsequent inspection, and rejects changed policy on reopen. Existing live runs without that policy fail closed instead of inheriting current defaults. The GitHub adapter validates the assigned base branch on initial/final inspection and before review or merge writes.

Authority verification and comment posting occur outside the global ledger lock. Short transactions acquire per-run claims, commit guarded results, and atomically reserve unique handles; ownership heartbeats prevent ordinary overlapping same-run workers while unrelated runs proceed. Expired claims can be recovered, but stale workers cannot commit under a successor's claim. An accepted run reserves a 1,000-point receipt and competition-rank snapshot. Global handle collisions retain the curated three-word phrase plus a deterministic eight-hex suffix. The canonical handle is reserved before the comment, and retries with the original candidate return that same reservation. Unknown or different phrases for an existing run fail.

Authority receipts persist their original assignment snapshot and refuse changed registrations on retry, even after restart or finalization. The comment target comes from the reserved issue, not current configuration; snapshots remain private and unbound legacy receipts fail closed. Native surface evidence must be exactly the three unique allowlisted names.

`finalize` is the sole live completion-comment writer. It reuses that receipt and records the verified positive comment ID from its trusted, idempotent `postComment` callback. The callback receives a stable idempotency key and must atomically deduplicate remote writes across retries/restarts. `GithubAdapter.upsertCompletionComment` and `IssueCompletionWriter` supply marker reconciliation and body verification, but their read-then-create operation is not a distributed atomic writer. Heartbeats/fencing prevent ordinary overlap and stale ledger commits; they cannot undo a remote call already in flight after lease loss. A production deployment must supply atomic remote idempotency rather than treating these helpers alone as an exactly-once guarantee. `prepareCompletionComment` verifies QR/leaderboard configuration and builds the body without requiring the final comment ID. `leaderboard()` exposes only confirmed-comment receipts projected to handles, scores, and recalculated `liveRank`, not receipt identities or assignments. Native checkpoint evidence must verify actual order criteria, not just surface opens. HTTP authentication, trusted reader integration, and hosting are still missing deployment work.

The live client posts only `{runId, handle}` to an endpoint that invokes authority `finalize`. The endpoint returns the authoritative receipt only after persisting a positive `commentId`; an acceptance-only receipt is insufficient. The client verifies that finalized receipt and updates local state. It never posts scores/evidence or writes completion comments locally. All uncertain completion outcomes retry the same remote finalization by run ID.

Receipt validation permits only the client's original curated phrase or its canonical eight-hex-suffix form, never an unrelated replacement. The authenticated canonical value is then persisted locally. This is server-authorized collision resolution, not client-side handle regeneration.

`ledger.lock` serializes file access; writes use an atomic replacement and fsync. A lock is not safe to delete merely because a UI appears frozen. See [lock recovery](../booth/RUNBOOK.md#lock-and-storage-recovery).

## Trust and privacy

The loopback server is an implementation detail, not public hosting. It uses a per-panel connection ticket, same-origin/host checks, bounded JSON actions, and a fixed run binding. Do not share its URL or ticket. None of those controls establishes native review provenance.

Hints are limited in the engine to order/reviewing/approved phases, not just disabled in the UI; post-serving calls cannot alter saved completion copy or hint counts.

Rehearsal has no remote GitHub writes or event submissions. Its persistent local results must remain segregated from live results. All correct completions score 1,000; hints and timing are not penalty inputs.

The live adapter must validate the exact changed menu and head, required checks, reviewer identity and approval, and merged menu. No secrets belong in renderer code or committed configuration. Public anonymity does not eliminate the need to protect private run/issue/reviewer mappings.

Only live mode with a configured completion endpoint requests `COMMIT_AND_SIP_COMPLETION_TOKEN`, after joining the host session, through an explicit SDK user grant. There are no blanket permission handlers. GitHub credentials stay in server-side `gh` execution. QR images must use a configured `approvedQrOrigins` allowlist and pass public image reachability checks.

## Validation

Run from the repository root:

```sh
npm ci
npm test
npm run check
```

The QR development dependency is installed by `npm ci`; the host supplies its extension SDK separately. Tests and syntax checks do not require a live GitHub approval or merge.

For staff validation of a prepared committed order delta, use full commit SHAs:

```sh
node scripts/grade-order.mjs --base <FULL_BASE_SHA> --head <FULL_HEAD_SHA> --order mona-latte
```

The grader validates the exact committed menu-only delta against the assigned catalog order; use the appropriate order ID. It is not a working-tree check or a substitute for native review evidence, GitHub checks, approval, or merge verification. An independent Git-fixture test covers this command.

Keep regression coverage for:

- Empty and complete canvas opens, rejection of partial input, authenticated setup, new/resume separation, conflict/overlap protection, and provider-restart resume without duplicate runs or live fallback.
- Shared guide/template rendering, required template values, catalog parity, single-step completion timing, and one actionable checkpoint mismatch at a time.
- Full loopback rehearsal lifecycle, persistence across new engine/panel instances, and zero remote calls even when adapters are supplied.
- View order and factual checkpoint gating; invalid inputs and mismatched order IDs.
- Live refusal without native evidence; exact run/repository/PR/head identity matching.
- Head changes, missing or failed required checks, unrelated menu changes, wrong reviewer, and premature merge.
- Approval not serving; serving not succeeding until merge/menu verification.
- Retry after remote failure, durable candidate/canonical handle identity and deterministic global collision suffixes, rejection of changed phrases, one result/comment per run, and tie ranking.
- Concurrent store access, persistence after reopen, safe rehearsal reset, and loopback action boundaries.
- QR target public reachability, generated PNG/manifest consistency, and independent `jsqr` decoding of the generated image.

Passing local tests is not acceptance evidence for missing native host integration, remote verification, public hosting, real App navigation, or phone QR scanning.

## Rehearsal validation boundary

The Node suite includes catalog-wide guide/template and loopback lifecycle coverage. A local headless Chromium walkthrough also exercised all three drinks at 1280px, 390px, and 320px widths: keyboard-operated guide and return-to-Changes link, blank learner answers, failed checkpoint recovery, explicit approval before serving, result focus, resume with the same handle, and one durable result per run. It made no nonlocal requests, opened no extra pages, and reported no renderer errors or horizontal page overflow at those widths. Browser validation tooling was session-local, not added to attendee dependencies.

The rebuilt launch layer was additionally checked with strict AJV schema compilation and a headless browser: omitted/empty inputs, new rehearsal creation, missing/duplicate-ID rejection, same-panel reload, provider-restart simulation followed by explicit resume, SDK selection reflected in the setup UI, and full exercise completion. Setup fit 320px, 390px, and 1280px widths and opened no external pages. The automated Node suite includes seven canvas lifecycle/selection regressions alongside the existing exercise checks.

A later pilot UI walkthrough used explicitly labeled local GitHub/view/completion test fixtures, not real native evidence, at 320px, 390px, and 1280px widths. It covered a missing reader, partial progress, checkpoint unlock, stale-head revocation, separate approval/merge, visible served menu with pending event results across reload, and final result rendering. All original rehearsal journeys also passed. These checks validate state wiring and typography, not a live pilot. No GitHub learner issue/PR was provisioned, approved, or merged in this walkthrough.

This verifies the local renderer and engine, not the Copilot App extension lifecycle. Host tools were unavailable for extension reload and in-App navigation verification. Staff must still perform the runbook warm-up in the actual booth build; native live review, real GitHub writes, public QR scanning, and pilot targets are not certified by this rehearsal walkthrough.

## Release evidence still needed

1. Authentic App captures and keyboard/touch/accessibility walkthrough.
2. End-to-end live run with separately authorized author/reviewer/merger and trusted native evidence.
3. Cross-device completion idempotency, unique-handle reservation, and timeout reconciliation.
4. Public mobile leaderboard and issue QR rendering/scan verification.
5. Brand/trademark, privacy/access/retention, and event operator approval.
6. Recorded pilots against the targets in the preserved outline; targets are not measured outcomes.

The [approved outline](exercise-outline.md) remains unchanged. Its source SHA-256 is `8a9090ed93894edfb6e17fc322dde0e1a8ee05cfcd16bfe125edba0df02443b6`. Implementation clarifications belong in current documentation, not edits to that preserved source.

The renderer uses `renderer/result-links.mjs` for completed live result links, trusting the server-validated host projection (including public IP literals) rather than reimplementing public-address policy. Safe HTTPS syntax remains checked in the browser; network/QR-origin validation remains server-side.
