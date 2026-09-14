# Architecture and validation

## Components

| Component | Responsibility |
| --- | --- |
| `extension.mjs` | Register `commit-and-sip`, validate open/action schemas, manage panel lifecycle |
| `domain.mjs` | Orders, domain validation, rehearsal fixtures, safe public run projection, handle generation |
| `store.mjs` | Persistent run/result ledger, exclusive file lock, atomic fsynced persistence |
| `engine.mjs` | State transitions, factual checkpoint, live evidence gates, approval/serve separation, completion retries |
| `server.mjs` | Per-panel loopback HTTP boundary and renderer assets; dispatch only validated actions for the bound run |
| `renderer/` | Attendee presentation and controls; not an authority for live review evidence |
| Service adapters | Server-side GitHub and completion integration; see the integration contract for unresolved native evidence |
| `services/authority.mjs` | `CompletionAuthority`: independent server-owned evidence validation, durable receipt/handle reservation, comment finalization, anonymous leaderboard projection; not a hosted/authenticated service |
| `services/live.mjs` | Post-`joinSession` live adapter wiring; authenticated completion submission, finalized receipt verification, and local state update; no local completion-comment writes |
| `booth/` | Machine-readable orders, curated handle words, scoring, staff example configuration, runbook |
| `scripts/` and `tests/` | Maintainer validation, explicit rehearsal reset, approved-URL QR generation |

The state/engine/server/renderer/services boundaries matter: the browser renders a public projection and requests actions; only the engine and trusted service adapters may validate authoritative facts.

## State and retry behavior

```text
order → reviewing → approved → served → completed
           ↑
      inspect + checkpoint
```

Rehearsal progresses through local fixtures. Live progression adds independent GitHub and trusted native evidence gates. Live `view` actions cannot certify native views. `approve` checks prerequisites and records/verifies approval; it never merges. `serve` requires the actual authorized merge and validates the resulting menu.

Serving is durable before finalization. Completion reserves the generated handle in storage before remote submission. If the completion endpoint or issue update is unavailable, retry `complete` for the same run. Completed results must not be recreated, renamed, or posted as duplicate issue comments on refresh/reopen/retry.

The ledger lives outside the checkout by default, under `$COPILOT_HOME/extensions/commit-and-sip/artifacts/`, with `COPILOT_HOME` defaulting to `~/.copilot`. `COMMIT_AND_SIP_DATA_DIR` is a staff-only absolute-directory override. This keeps results across panel closure, extension reload, and worktree changes. Do not commit ledger data or browser connection URLs.

The deployed `CompletionAuthority` needs its own dedicated server store, separate from this client rehearsal ledger. Its `accept({runId, handle})` recomputes eligibility from server-owned assignments and independent GitHub, native-view, and acceptance-checkpoint readers; callers cannot supply evidence or scores. It reserves a 1,000-point receipt and competition-rank snapshot. Global handle collisions retain the curated three-word phrase plus a deterministic eight-hex suffix. The canonical handle is reserved before the comment, and retries with the original candidate return that same reservation. Unknown or different phrases for an existing run fail.

`finalize` is the sole live completion-comment writer. It reuses that receipt and records the verified positive comment ID from its trusted, idempotent `postComment` callback using `GithubAdapter.upsertCompletionComment`. The callback must reconcile timeout-after-write cases by run ID. `prepareCompletionComment` verifies QR/leaderboard configuration and builds the body without requiring the final comment ID. `leaderboard()` exposes only confirmed-comment receipts projected to handles, scores, and recalculated `liveRank`, not receipt identities or assignments. Native checkpoint evidence must verify actual order criteria, not just surface opens. HTTP authentication, trusted reader integration, and hosting are still missing deployment work.

The live client posts only `{runId, handle}` to an endpoint that invokes authority `finalize`. The endpoint returns the authoritative receipt only after persisting a positive `commentId`; an acceptance-only receipt is insufficient. The client verifies that finalized receipt and updates local state. It never posts scores/evidence or writes completion comments locally. All uncertain completion outcomes retry the same remote finalization by run ID.

Receipt validation permits only the client's original curated phrase or its canonical eight-hex-suffix form, never an unrelated replacement. The authenticated canonical value is then persisted locally. This is server-authorized collision resolution, not client-side handle regeneration.

`ledger.lock` serializes file access; writes use an atomic replacement and fsync. A lock is not safe to delete merely because a UI appears frozen. See [lock recovery](../booth/RUNBOOK.md#lock-and-storage-recovery).

## Trust and privacy

The loopback server is an implementation detail, not public hosting. It uses a per-panel connection ticket, same-origin/host checks, bounded JSON actions, and a fixed run binding. Do not share its URL or ticket. None of those controls establishes native review provenance.

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

- View order and factual checkpoint gating; invalid inputs and mismatched order IDs.
- Live refusal without native evidence; exact run/repository/PR/head identity matching.
- Head changes, missing or failed required checks, unrelated menu changes, wrong reviewer, and premature merge.
- Approval not serving; serving not succeeding until merge/menu verification.
- Retry after remote failure, durable candidate/canonical handle identity and deterministic global collision suffixes, rejection of changed phrases, one result/comment per run, and tie ranking.
- Concurrent store access, persistence after reopen, safe rehearsal reset, and loopback action boundaries.
- QR target public reachability, generated PNG/manifest consistency, and independent `jsqr` decoding of the generated image.

Passing local tests is not acceptance evidence for missing native host integration, remote verification, public hosting, real App navigation, or phone QR scanning.

## Release evidence still needed

1. Authentic App captures and keyboard/touch/accessibility walkthrough.
2. End-to-end live run with separately authorized author/reviewer/merger and trusted native evidence.
3. Cross-device completion idempotency, unique-handle reservation, and timeout reconciliation.
4. Public mobile leaderboard and issue QR rendering/scan verification.
5. Brand/trademark, privacy/access/retention, and event operator approval.
6. Recorded pilots against the targets in the preserved outline; targets are not measured outcomes.

The [approved outline](exercise-outline.md) remains unchanged. Its source SHA-256 is `8a9090ed93894edfb6e17fc322dde0e1a8ee05cfcd16bfe125edba0df02443b6`. Implementation clarifications belong in current documentation, not edits to that preserved source.
