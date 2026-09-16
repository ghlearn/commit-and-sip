# Integration contract

This document separates supported extension behavior from unresolved production integrations. It is not evidence that a live booth deployment has been approved.

## Confirmed Skills adaptation

The current delivery is a rehearsal-first, single-step exercise. The canvas owns initialization, review activities, checkpoint feedback, approval, serving, and the local result. Staff initialization is outside the learner step. Actions remain repository validation only: no issue-driven Step 0/Step 1 transition workflows, automatic issue closure, or Step 2 are added.

`.github/steps/1-review-and-serve.md` is the canonical rehearsal guide. `content.mjs` loads it and the repository-owned Markdown templates at module initialization; no dependency install or remote content fetch occurs during play. The public run projection includes `exercise: { title, sections: [{ heading, paragraphs }], completion }`. Scored-mode completion text is `null` until `phase` is `completed`; the unranked pilot instead exposes a learning summary at `pilot-served`. Both are presentation, not independent completion evidence. Existing saved runs obtain current guide content without changing their persisted phases, events, results, or issue body.

The renderer uses text nodes for the guide and templates, not HTML evaluation or a general Markdown renderer. The guide permits one Step 1 heading, level-two activity headings, and plain paragraphs. Missing content, unsupported structure, or unresolved placeholders fails explicitly. Reload the extension after changing content. Rehearsal and newly provisioned live order criteria share `order-criteria.md`, rendered from `booth/orders.json`. Provisioning owns only initial live issue creation; existing issue edits and the remote completion-comment writer retain their existing ownership.

Rehearsal stays entirely in the panel. The explicit unranked canvas pilot reviews real GitHub data in the panel, without claiming native evidence. Future native `live` review may open authentic PR views elsewhere inside the Copilot App. This scope decision does not implement native navigation or evidence capture; all existing native-live gates remain mandatory. No learner GitHub.com navigation, production deployment, or simulated native-live certification is introduced.

## Supported canvas boundary

The project extension entrypoint is `.github/extensions/commit-and-sip/extension.mjs`. The installed host's extension SDK documentation is the authority for `joinSession`, `createCanvas`, lifecycle callbacks, action schemas, and error handling. Consult that installed documentation or the host extension authoring guide; do not infer undocumented navigation or telemetry APIs from the existence of a canvas.

The SDK is host-resolved. No standalone SDK installation is required.

Registered canvas ID: `commit-and-sip`.

Open with omitted input or `{}` to display an unassigned setup screen. No run, review, mode, or result is created by that open. The schema also accepts a complete assignment for a direct open:

```json
{"runId":"rehearsal-demo-001","mode":"rehearsal","orderId":"mona-latte"}
```

Partial inputs such as `{"runId":"example"}` still fail. A direct new rehearsal also requires an explicit `orderId`; only an existing run may omit the order when resuming (live opens derive it from staff configuration). The engine enforces this state-dependent rule after schema validation. An invalid live assignment never falls back to rehearsal.

The setup screen requires an explicit **Create new rehearsal** or **Resume saved rehearsal** decision. It suggests a random run ID for new runs without saving it until selection; the learner/staff chooses the catalog drink. Resume requires an existing rehearsal ID and takes its saved order. It does not create missing runs, list other attendees' data, overwrite existing runs, or resume live runs as rehearsal.

The `select_run` action takes `{"operation":"new","runId":"UNUSED_ID","mode":"rehearsal","orderId":"mona-latte"}` or `{"operation":"resume","runId":"EXISTING_ID","mode":"rehearsal"}`. Both HTTP and SDK actions route through the same per-panel binding. A selected panel cannot switch to another run; retrying the same confirmed selection returns its saved state. Other exercise actions require selection first; `refresh` can inspect setup without creating evidence.

Setup state is `{phase:"setup", mode:null, suggestedRunId, orders:[{id,name}]}`. Existing bound-state projections are unchanged. Setup pages and selection APIs retain the same loopback capability, origin, host, and bounded-request protections as the exercise.

Selection binds the running panel, not the persisted exercise. Iframe reloads and repeated opens keep that binding while the provider lives. On provider/App restart, an empty-input open returns to setup: explicitly resume by the original run ID. A complete assignment rehydrates directly from its saved input. No persistent record is keyed by `instanceId`, and reopening setup never resets exercise data.

`runId` is stable domain identity: 1–80 letters, digits, hyphens, or underscores, starting with a letter or digit. `mode` is explicitly `rehearsal`, `live`, or `live-canvas-pilot`. GitHub-connected `orderId` must match the staff assignment. A panel's caller-selected `instanceId` is a separate lifecycle handle. Reopen the same domain run to resume; use a new panel instance for a different run.

| Action | Input | Meaning |
| --- | --- | --- |
| `select_run` | Explicit new/resume rehearsal selection (above) | Bind an unassigned setup panel without starting review |
| `start` | `{}` | Load assigned issue and review data |
| `view` | `{"surface":"summary"}` (also `changes`, `checks`) | Sequential rehearsal views or reverified pilot canvas observations; never native-live certification |
| `hint` | `{}` | Acceptance-criteria guidance without score penalty |
| `check_order` | `{"price":5.5,"serving":"hot","scope":"one-drink"}` | Factual checkpoint; submit actual learner answers and compare with the assigned order |
| `approve` | `{}` | Explicit review decision, with prerequisites; not merge |
| `serve` | `{}` | Simulate rehearsal menu or verify authorized live merge |
| `complete` | `{}` | Retry scored-mode finalization after serving; pilot always rejects with `pilot_not_ranked` |
| `refresh` | `{}` | Read persisted state; does not create review evidence |
| `sync_review` | `{}` | In live reviewing only, read an injected trusted native-view provider and independently recheck the assigned PR revision |

Hints are accepted only in `order`, `reviewing`, and `approved`, matching the renderer controls. HTTP and SDK callers receive `wrong_phase` after serving or completion, with no change to status, hint count, menu, or result.

Checkpoint enums: `serving` is `hot` or `cold`; `scope` is `one-drink` or `unrelated-edits`. Unexpected input properties are rejected. Serving initiates completion only in scored modes, so a completion-service failure can follow a successful, durable menu update there.

`completionPending` means finalization remains unfinished, not that a worker is currently running. A served run must offer **Retry result** after an error or reload; the renderer disables actions only during its active request, and the server serializes concurrent attempts.

## Explicit unranked canvas-pilot boundary

`live-canvas-pilot` requires both the matching staff configuration mode and an assignment explicitly pinned with `reviewSource: "canvas-pilot"`. Omitted review source retains legacy native `live` semantics; it never opts in to pilot review. Provisioning's `--review-source canvas-pilot` pins that source in its durable journal/config and returns the corresponding direct-open input, but does not switch configuration mode. Staff separately enable the mode in ignored config, reload, and open `{runId, mode:"live-canvas-pilot", orderId}` for the assigned order. Empty-input setup and `select_run` remain rehearsal-only; the renderer cannot create a pilot assignment.

Both GitHub-connected modes use the existing `GithubAdapter` for actual assigned issue/PR data and exact head/base/menu/check validation. Pilot `view` actions open Summary → Changes → Checks sequentially and recheck GitHub before saving a canvas observation bound to the exact assignment/head. They neither emit nor stand in for native-view evidence. `sync_review` remains the native-live path, not a pilot evidence bypass.

The factual checkpoint must contain the learner's actual answers. After inspecting the menu and checks, the learner explicitly approves; the pilot retains designated-reviewer/author guards and the same durably reserved, exact SHA-bound approval-attempt marker. Approval never merges. A separate authorized operator/workflow merges, and `serve` independently verifies pinned head/base/menu/checks and this run's exact effective approval attempt. Pilot serving checks the menu at GitHub's merge SHA, verifies through ancestry comparison that the current assigned base tip contains that merge, and requires the base-tip menu to equal the inspected menu exactly. A second base-ref read rejects movement during verification. These extra pilot checks do not change native-live behavior.

Successful serving persists the menu and merge SHA at **`pilot-served`** with a learning summary. It does not enter `completed` or emit a completed event. No handle, score, rank, QR, judge, event-result submission, or completion comment is created. `complete` fails with `pilot_not_ranked`; the engine makes no `CompletionAuthority` call, and the authority independently rejects pilot assignments. A saved pilot cannot become ranked by enabling an endpoint or changing source/mode.

Mode/source and the full saved assignment/check policy are checked on all operations, including open and read-only refresh. Configuration/source/mode mismatches reject without mutating the ledger, and old state without the required durable binding fails closed. Actual verification errors durably clear current views, checkpoint success, and copied review data, while preserving the exact decision/attempt and lifecycle state. The pilot's private saved decision includes the actual submitted answers, source/assignment binding, and exact approval attempt—not synthetic native timestamps. Once approved, a later `serve` may verify a separately completed merge after pending-merge revocation without re-approving or manufacturing fresh learner evidence. Recovery while still reviewing requires real reinspection and learner answers; a changed head requires a fresh assignment.

This is a constrained real-GitHub pilot path, not production Skills/event completion or a fallback for unavailable native integration. This milestone performs no provisioning, approval, merge, or staff configuration change. Future execution requires explicit authorized staff preparation; permissions, authentic screenshots, brand/privacy approval, and trusted native hosting remain unresolved. Browser fixtures under `tests/fixtures` use the real `GithubAdapter` with mocked transport: no actual GitHub writes occur, and the fixtures are not native App captures.

## Server-side live dependencies

`RunEngine` receives a durable store, order catalog, staff configuration, and trusted adapters. The renderer does not supply or override adapters.

- **GitHub adapter:** reads the assigned issue; inspects the exact pull request, expected head SHA and base branch, designated reviewer, changed files/menu, required checks, approval and merge facts; creates an explicit SHA-bound approval only through the authorized reviewer. Its inspection result includes `headSha`, `baseRef`, `checksPassed`, `approved`, `approvedForAttempt`, `approvedAt`, `merged`, `mergeCommitSha`, `menu`, and presentation data (`summary`, `files`, `checks`). `inspectPullRequest`, `approve`, and `merge` require an explicit `expectedBaseRef`; inspection checks `pr.base.ref` on both the initial and final reads, including already-merged PRs.
- **View-evidence adapter (native `live` only):** provides `read` as specified below. No production implementation is currently supplied; pilot observations do not satisfy it.
- **Completion adapter (native `live` only):** provides `finish(run)` only after serving, using an authenticated server-side endpoint. A configured endpoint or local adapter does not establish that the remote verifier exists or is trustworthy. The pilot never submits to it.

`services/live.mjs` wires the GitHub and completion adapters after `joinSession`. Only when mode is `live` and `completionEndpoint` is configured does the extension request the exact `COMMIT_AND_SIP_COMPLETION_TOKEN` environment variable through the SDK's explicit user-grant mechanism. It does not install blanket permission handlers. A missing or denied grant blocks authenticated completion; never copy the token into configuration or browser state to bypass consent.

Live configuration uses `mode`, `repo`, `requiredChecks`, `leaderboardUrl`, `completionEndpoint`, `qrImageUrl`, `approvedQrOrigins`, and a `runs` map keyed by domain run ID. Each assignment contains `issueNumber`, `prNumber`, exact 40-character `headSha`, explicit `baseRef` (the intended application branch, such as `main`), `reviewer`, and `orderId`, plus explicit `reviewSource: "canvas-pilot"` for pilot opt-in. Completion/leaderboard/QR configuration applies only to native `live`, not pilot serving. `approvedQrOrigins` defaults to `[]`; staff must explicitly allow the public HTTPS origin serving the QR image. Example configuration is not a valid live assignment.

At creation the engine saves an independent copy of the effective global `requiredChecks` array with the assignment (omission retains the original `["menu-validation"]` default; empty/invalid lists are rejected). Every inspection uses that saved list, not mutable global configuration. Reopening rejects any changed branch or effective check list. Legacy live runs with no pinned base/check policy cannot silently inherit current defaults, and fail closed on revalidation. Recover their original verified assignment through staff procedures or use a fresh run; do not weaken checks to resume.

Saved GitHub-connected runs also require their matching configuration mode/source and a configured GitHub adapter before open, refresh/get, or actions return state. Disabling or changing mode does not erase the run, but it cannot reopen as another mode or without its required adapters. Staff configuration must be a non-array JSON object (and `runs`, when present, an object map); invalid JSON shapes such as `null`, arrays, and scalars produce explicit configuration errors instead of an uncaught property-access stack trace.

Before a live approval write, the engine durably reserves a random `approvalAttempt` bound to the run and its exact assignment. The GitHub adapter writes its ID in the review body as `<!-- commit-and-sip-approval:UUID -->` together with the assigned commit SHA. Inspection returns `approvedForAttempt: true` only when the latest effective approval from the designated reviewer is on that head and contains that exact marker. A pre-approved assignment without the run's marker remains rejected.

If the write response or following verification is lost, review evidence is revoked as usual, but the private attempt is preserved. Restore evidence, refresh verified review, and repeat the checkpoint/approval decision in the same run. A matching remote approval is reconciled without another review write; if no approval was recorded, retry uses the same marker. Assignment changes, wrong markers, other reviewers/heads, or superseding unrelated approvals cannot be reconciled. This is durable attribution and retry reconciliation, not a GitHub API guarantee of exactly-once POST delivery. A run that was already merged still requires staff recovery rather than bypassing the pre-approval merge gate. Attempt metadata never enters the public canvas projection.

GitHub credentials stay with authenticated server-side `gh` CLI execution. The PR author and reviewer must be different authorized identities. Authentication alone does not confer review or merge permission, and branch protection is never bypassed.

Required checks must come from the official `github-actions` check publisher by default; a same-named commit status or another app cannot substitute. The adapter also supports explicit publisher-slug overrides and additional app-ID pinning for a separately reviewed server deployment.

## Unresolved: native view evidence for ranked `live`

The engine accepts only a trusted, injected server-side provider:

```js
await viewEvidence.read({ runId, repo, prNumber, headSha });
// Required returned projection:
// { runId, repo, prNumber, headSha, surfaces: ["summary", "changes", "checks"] }
```

All identity fields must exactly match the assigned run and head. The engine requires all three surfaces. A caller-controlled object, renderer click, HTTP action, DOM assertion, or screenshot alone is not an acceptable live source.

The production provider still needs a documented native host integration that:

1. Authenticates the host, session, device, and authorized run binding.
2. Records unique event IDs and timestamps for allowlisted native PR surfaces.
3. Binds every event to repository, PR number, and exact head SHA.
4. Rejects replay, cross-run/session/device substitution, and invented surface names.
5. Invalidates evidence when the PR head changes; staff then create a fresh assigned run.
6. Supplies verifiable signed/authorized facts to the completion service, not merely the engine's projected `surfaces` array.

The explicit `sync_review` action closes the UI dependency between native views and the factual checkpoint. It accepts no evidence payload. An injected trusted provider may return a partial, duplicate-free subset of `summary`, `changes`, and `checks` for the exact identity; synchronization projects that progress after independent GitHub verification. Missing/invalid evidence, failed checks, stale head, or a premature merge clears saved views, checkpoint success, copied review data, and synchronization time before surfacing the error. Losing a required surface also resets checkpoint success.

The same durable revocation boundary now surrounds every live revalidation, not just synchronization: initial inspection, checkpoint, approval before/after the GitHub write, serving, and completion. Failed verification rolls back tentative action changes but commits cleared review fields before returning the original error. A refresh or new engine instance therefore cannot expose a previously unlocked checkpoint. Revocation retains the saved lifecycle phase, events, issue, served menu/revision, and handle/result identity; it never fabricates a rollback of a remote approval or merge. Restore evidence and resynchronize/reanswer while reviewing, or retry the existing serving/finalization phase. Pending merges also revoke the current verification snapshot, but leave the approved phase available for later verification. Non-verification input errors and unavailable completion transport do not clear valid evidence or saved result state. `refresh` and normal polling remain read-only; they do not contact the provider or GitHub.

The public run adds a non-reviewer assignment projection, `reviewTarget: {repo, issueNumber, prNumber, headSha}`, and `verification: {nativeReviewAvailable, syncedAt}`. Provider availability only means a server-injected `read` function exists; it is not native provenance or deployment certification. With no reader, the canvas explains the blocker and disables **Refresh verified review**. Approval and serving still independently reverify all three surfaces and GitHub facts.

The existing extension does not inject a production provider. Inspection of the installed SDK's `canvas.d.ts`, `generated/rpc.d.ts`, and `generated/session-events.d.ts` found canvas lifecycle types and a `CanvasHostContextCapabilities.canvases` rendering flag, but no documented native PR-navigation or view-observation interface. This is a gap in the inspected integration surface, not proof that no future or separate host API exists. A host-owned contract must be supplied before ranked native `live` can run; no guessed RPC, session text, agent tool activity, or canvas-open event is used as a substitute. The separately labeled unranked canvas pilot does not resolve this gap.

The current engine checks the trusted provider's identity projection and surface coverage; that does **not** implement host authentication, event provenance, or replay defenses. Those are requirements on the missing integration. Do not wire a permissive stub into live mode to make the flow appear complete.

Even authentic view events prove a surface was opened, not that a learner understood it. The price/serving/scope checkpoint and exact menu verification remain required.

## Implemented authority; unresolved authenticated deployment

`services/authority.mjs` supplies `CompletionAuthority`, a server-side deployment building block. It is **not a hosted or authenticated HTTP service**. Deployment code must inject its own dedicated durable store, server-owned assignments, catalog, independent GitHub adapter, trusted `viewEvidence` and `checkpointEvidence` readers, and `postComment` writer.

This authority is exclusively for native-live event completion. It explicitly rejects canvas-pilot assignments; their learning summary and served menu are not inputs to ranked completion.

| Method | Supported behavior |
| --- | --- |
| `accept({runId, handle})` | Verify the server-owned assignment, curated handle, independent evidence and GitHub facts; durably reserve one receipt with score 1,000 and a competition-rank snapshot |
| `finalize({runId, handle})` | Accept or reuse the same receipt, call `postComment` if its comment ID is not yet saved, and return the receipt with the verified comment ID |
| `leaderboard()` | Return only finalized entries projected to `handle`, `score`, and recalculated `liveRank`; exclude private run/assignment data |

Clients may submit only `runId` and `handle`, not scores, assignments, or evidence. The authority resolves global handle collisions by retaining the same curated three-word phrase and appending a deterministic eight-hex-character suffix. It reserves that canonical handle durably in the authority store before writing the comment. Retrying with the same original candidate returns the same reservation rather than generating another handle/result. An unknown or different phrase for the same run still fails.

Every authority reservation stores a private assignment snapshot: repository, issue, PR, exact head, target base branch, reviewer, order ID, effective required checks, and the trusted approval-attempt/timing proof described below. Both acceptance retries and finalization compare the registration to that snapshot, including across process restarts. Comments are addressed only to the persisted issue, with the repository-bound verifier checked again before posting. A changed registration cannot redirect an existing receipt; issue/PR reuse is also checked against persisted reservations, not only the current assignment map. Assignment and requested-handle metadata are omitted from returned receipts and comment payloads.

The issue number must be a positive safe integer before any claim, reservation transaction, or remote evidence lookup. Missing, fractional, string, non-positive, or unsafe issue values fail with `invalid_assignment`; fixing that rejected configuration does not conflict with a partial receipt because none was created.

Legacy reservations without an assignment snapshot fail closed (`assignment_conflict`). Do not infer a binding from new configuration or delete the receipt to force a retry; staff must recover the original independently verified assignment under the approved recovery process before restoring a bound reservation.

The authority's store must be a **different, dedicated server store**, never the client rehearsal ledger. The server owns assignments including repository, issue/PR, exact head, reviewer, required checks, and order. The authority rejects reused issue/PR assignments across event runs.

Both trusted evidence readers receive `{runId, repo, prNumber, headSha}` and must return exactly matching identity fields. Native surface evidence must contain exactly the three allowlisted names once each, in any order; duplicate, invented, or missing names fail before a receipt is reserved. In addition to all three native surfaces, `checkpointEvidence.read(identity)` must return `passed: true`, the actual order's `price` and `serving`, and `scope: "one-drink"`. This checkpoint must be server-verifiable from the actual acceptance criteria and trusted learner interaction; view opens, client assertions, and the local engine's saved success flag are insufficient.

The authority's server-owned assignment must also contain `approvalAttempt: { id, reviewedAt, checkpointAt, decidedAt }`: the exact UUID used for this learner's GitHub review and trusted UTC timestamps for completed native review, passed checkpoint, and explicit approval decision. They must be chronological. View and checkpoint readers return `completedAt` matching their respective registered timestamps. The independent GitHub inspection receives the pinned base/check policy and `approvalAttemptId`, and must confirm `approvedForAttempt === true` with the effective review's `approvedAt` no earlier than the decision, accounting for GitHub's whole-second timestamp precision. An arbitrary approval from the configured reviewer is not enough.

This registration and its ordering evidence must come from the authenticated native host/server integration, not the `{runId, handle}` completion request or an assertion copied from local engine state. Retries use the original attempt's observations, not timestamps invented from a later refresh. The shipped extension does not supply that production integration; missing proof blocks completion rather than fabricating it.

### Short transactions and per-run claims

The authority stores durable ownership records in ledger-root `completionClaims[]`: `{runId, assignment, requestedHandle, fence, stage, owner, expiresAt}`. Assignment and candidate bindings survive verification failures and worker restart. Short locked transactions acquire/renew claims and commit results; native readers, GitHub inspection, and comment publication run outside `ledger.lock`, so an unrelated run is not blocked by one slow remote request.

The constructor accepts server-side `claimTtlMs` (default 60,000) and `now` (default `Date.now`, used by deterministic tests). Healthy workers renew ownership every approximately TTL/3. Competing work on the same live claim reports `completion_busy`; expired/replaced ownership reports `completion_claim_lost`, and a stale worker cannot commit under its successor's claim. Heartbeat cleanup is awaited before the call rejects. Retry using the same run/candidate; never remove claims or change an assignment to bypass ownership.

`postComment(issueNumber, receipt, {idempotencyKey})` must atomically deduplicate remote writes using the stable SHA-256 key derived from the run and reserved assignment, including after restart or lease loss. The authority persists the returned positive comment ID. Heartbeats and fencing prevent ordinary overlapping workers and stale ledger commits, but cannot undo a remote call already in flight after a crash/partition. The existing `GithubAdapter.upsertCompletionComment`/`IssueCompletionWriter` read-then-create helpers reconcile markers but do not supply distributed atomic idempotency by themselves. Production deployment must provide that writer guarantee; passing a key does not make arbitrary remote writers exactly-once.

### Client transport and the sole remote comment writer

The live client's authenticated POST body is exactly `{runId, handle}`. The handle is the curated candidate already persisted locally; neither score nor evidence is submitted by the client. The endpoint invokes `CompletionAuthority.finalize`: independently verify eligibility, reserve or reuse the receipt, upsert the issue comment, and persist its verified positive `commentId` before returning:

```js
{
  runId,
  handle,
  score: 1000,
  rank,
  rankAtCompletion,
  recordedAt, // valid UTC timestamp
  commentId, // positive integer; confirmed issue comment persisted by the authority
  judge: null // or { source: "copilot", moderated: true, text }
}
```

The client checks the receipt against its persisted run and candidate phrase, accepting only that same curated phrase or its canonical eight-hex-suffix form from the authenticated receipt. It validates the score, positive ranks, positive integer `commentId`, UTC timestamp, and optional attributed/moderated commentary, then persists the canonical handle in local state. Arbitrary replacement phrases are rejected. `rankAtCompletion` is a receipt snapshot; the public leaderboard's `liveRank` is recalculated. A structurally valid judge object is not permission to fabricate Copilot output.

**`CompletionAuthority.finalize` is the only live completion-comment writer.** Its trusted `postComment` callback uses `GithubAdapter.upsertCompletionComment`. The completion module's `prepareCompletionComment` helper verifies the configured QR/leaderboard and builds the comment body before a final `commentId` exists, avoiding a circular dependency. The callback returns the verified comment ID for authority persistence.

`services/issue-writer.mjs` supplies that callback as `IssueCompletionWriter.write(issueNumber, receipt)`. Construct it with the repository-bound `github` adapter, `leaderboardUrl`, `qrImageUrl`, and `approvedQrOrigins`; inject `postComment: writer.write.bind(writer)` into the authority. It verifies the exact returned comment body and positive ID. The authority also verifies that `github.repo` matches the registered assignment. Neither helper starts an HTTP service or supplies authentication.

`services/live.mjs` never upserts completion comments locally. It submits the request, verifies the finalized receipt, and updates local state only. An `accept` receipt without a confirmed `commentId` is not a successful endpoint response. `leaderboard()` lists only receipts with confirmed comments; retry failed or uncertain finalization through the same remote endpoint and run ID, not a second writer.

The deployed remote service must independently establish:

- Authorized run assignment and signed/authorized native view facts for the same repository, PR, and head.
- Exact order/menu scope, required successful checks, designated reviewer approval, and actual authorized merge from GitHub.
- Successful served state consistent with those facts; local state and local scores are not trusted attestations.
- A server-computed score of 1,000 for a correct completion, and competition rank with equal scores sharing rank.
- Atomic unique-handle reservation across devices, using moderated words. Local handle uniqueness is not global uniqueness.
- Idempotency by `runId` for result creation and issue-comment create/update, including timeout-after-acceptance retries.
- Consistent authoritative handle/result on retry. Reserve collision-resolving canonical suffixes server-side, return the same reservation for the original candidate, and never regenerate the curated phrase or duplicate a result.
- A single final exercise-issue comment and accepted record, with approved HTTPS leaderboard and public QR image references.

`completionEndpoint` must be authenticated and called server-side, not from browsers or QR clients. HTTP/auth integration, signing format, key custody/rotation, request authentication, event attestation envelope, trusted native/checkpoint readers, shared authoritative storage deployment, and operational hosting remain unresolved production work. In-process verification and atomic handle reservation do not supply those integrations. Do not treat a client-provided signature or a local bearer ticket as proof of native review.

Handle candidates are generated only after the menu succeeds and persisted before any network submission. The authority reserves the canonical handle before commenting; the authenticated finalized receipt lets the client persist that canonical value. Recovery retains the run, candidate/reservation identity, served/completed state, and previously accepted result/comment. An unknown remote outcome must be reconciled using the same run ID, not posted under a fresh key.

Public output contains generated handles and approved score/rank information, not attendee names, GitHub usernames, booth account identifiers, credentials, or free-form attendee text. Private operational run/issue mappings need an approved access and retention policy before live collection.

## Staff preflight and app-result projection

### Staff-only provisioning boundary

`services/provision.mjs` exposes `LiveProvisioner({store, catalog, github, configFile}).provision(input, {apply:false})`. Input contains `{runId, prNumber, headSha, baseRef, reviewer, orderId}` and optional `reviewSource`; repository and effective checks come from existing staff config. Explicit `reviewSource: "canvas-pilot"` opts into the unranked pilot; omission retains native-live behavior. `configFile` supplies `read()` and `write(config)`; `StaffConfigFile` implements regular-file reads and private, fsynced atomic replacement. `GithubAdapter` supplies injectable GET/POST transport and paginated reads, while shared `inspectPreparedPullRequest` supplies the same menu-only/head/base/check/unused-review verification as preflight.

Pilot provisioning and preflight additionally require inspectable summary, a nonempty single-file patch, and checks presentation. Missing review material fails with `review_unavailable` before reservation or issue creation; passing menu/check facts alone cannot provide a usable canvas review.

`scripts/provision-live.mjs` exposes `npm run provision:live`. Without `--apply`, no ledger/config/remote writes occur, including no lock-file creation. The preview returns proposed title/body and assignment with a null issue number unless reconciling an existing known issue. Apply returns a `provisioned` report with the run, assignment, corresponding `canvasInput`, and message. Reports expose `mode`, `reviewSource` (default `native`), `liveReady:false`, `eventEligible:false`, and `permissionsCertified:false`. Assignment includes repository, issue/PR numbers, order, reviewer, exact head, intended base, pinned effective `requiredChecks`, and optional `reviewSource`. The CLI omits reviewer from its staff-only output; neither output contains credentials. `canvasInput.mode` follows the source, while config mode and unrelated values are preserved. The optional source is part of exact journal identity; omitted source remains omitted for compatibility, not silently rewritten into a pilot. The provisioned record's pinned checks must match global effective policy on all later live opens; omission uses the existing `menu-validation` default, never an empty list.

The single shared client store coordinates provisioning with engine opens. Root `provisions[]` entries record immutable assignment/order/creator/title/body and `reserved -> creating -> bound -> installed` stages. A run/PR reservation prevents reuse even when issue creation or config installation is unfinished. Engine opens reject rehearsal reuse of reserved IDs, conflicting live bindings, other runs claiming the reserved issue/PR, and not-yet-installed assignments. Provisioning rejects any already-open learner run. It creates no learner progress, receipt, view/checkpoint/approval attempt, score, or completion proof.

Only short filesystem transactions hold `ledger.lock`; authentication, marker listing, PR verification, issue POST, and issue rereads happen outside it. Before POST, a single transaction moves `reserved` to irreversible `creating` and records a random create token. There is no expiry/takeover that authorizes a second POST. Same-store overlapping initializers may report reconciliation-required, then reuse the same issue on retry. Both run and PR markers are scanned across open and closed repository issues. Reconciliation requires one exact original title/body/creator/open issue and its persisted number if bound; collisions and edits fail without modifying existing issues. The original rendered content is retained across code restarts rather than silently rewriting an issue to match a newer template.

A process or host crash during a filesystem transaction can leave an orphaned `ledger.lock`. Journal durability does not imply unattended lock recovery: a restarted initializer fails with `store_busy` until staff verify all writers are stopped, back up the ledger/lock, and remove only the proven-stale lock using the runbook's lock-recovery procedure. The store deliberately does not infer ownership from age or a local PID and never erases the journal to regain access. A subprocess-crash regression covers this blocked state and successful same-run issue reconciliation after controlled lock recovery, with no second issue POST.

This is **not atomic exactly-once remote issue creation**. A timeout/crash after durable create intent, even before sending POST, is unresolved unless the exact issue can be positively identified. An empty listing is not proof of failure; no automatic second POST or reset override exists. The run/PR remains reserved for explicit staff investigation. Independent stores/machines are not distributed coordinators: deploy only one designated initializer and a common durable store/config, pause external config editors/intake, and retain unresolved reservations. Remote marker scans alone cannot prevent independent-store races.

The bound issue is committed before the separate config write, so full-disk/rename/response-loss recovery reuses the same assignment. Rereading config under the shared lock preserves concurrent coordinated changes; atomic rename is not a filesystem CAS against arbitrary external editors. Only an omitted required-check list uses the default: an explicit `null` is rejected, including on later config reads before reservation, binding, or installation. Config conflicts or failed writes retain the binding and require same-run recovery. Staff must not manually edit/reset journal stages to force success.

The issue combines the shared catalog criteria and source-appropriate guide into **one learner step**. The native-live guide remains unchanged; pilot guidance must state its unranked boundary. It identifies a staff-prepared PR without asserting Copilot authorship. Provisioning introduces no coding-agent API, native navigation hook, review automation, remote merge, issue closure, completion writer, placeholder QR, or generated judging evidence. Provisioned means only setup persisted: not reviewed, served, completed, or live-ready. Real execution requires an explicit authorized prepared PR/reviewer/creator context; ranked native live additionally requires all existing production integrations.

`services/pilot.mjs` reuses shared assignment validation and the real `GithubAdapter` to inspect a prepared issue/PR using GET requests only. `scripts/preflight-live.mjs` exposes it as `npm run preflight:live -- --run RUN_ID [--config PATH]`. A verified report contains assignment references and catalog criteria for staff comparison, not reviewer identity or tokens. It exposes `mode`, `reviewSource` (default `native`), and false `liveReady`, `eventEligible`, and `permissionsCertified` flags. The command exits **0** for an assignment-verified, explicitly configured `live-canvas-pilot`/`canvas-pilot` pairing, **2** for a verified native-live assignment whose integrations remain blocked, and **1** on invalid input or failed verification. Exit 0 cannot prove native navigation, learner understanding, issue-copy parity, reviewer authentication, merge permission, or completion hosting. Preflight does not change the ledger or call approve/merge/comment APIs.

Native-live learner instructions are rendered from `.github/markdown-templates/live-review-guide.md`; pilot instructions use `.github/markdown-templates/canvas-pilot-guide.md`, loaded by `content.mjs` with the same single-step parser as rehearsal. The canvas shows the PR/issue references as text; there are no invented App deep links or automatic GitHub.com navigation. Until a documented native navigation API exists, staff must open the actual PR in the App for native-live review. The pilot instead presents reverified GitHub data in its sequential canvas views.

After live serving verifies the actual merge, the engine persists `servedCommitSha` with the menu. The canvas's **Your app result** displays serving independently of event finalization. `phase: served` still has no accepted score/rank or Step 1 completion summary; the menu remains visible with pending-result guidance. `complete` uses the same authority endpoint and identity as before. Existing runs lacking `servedCommitSha` remain readable without inventing a historical revision.

## Unresolved: host navigation, hosting, and judging

- Native issue/PR navigation and native-view capture must be verified against the actual booth App build. The canvas registration is not a navigation API.
- A private repository is intentional, not a public deployment. An approved publicly reachable HTTPS leaderboard and publicly readable, issue-renderable QR asset are required. Loopback and private assets do not work on attendees' phones.
- Generate `.github/images/leaderboard-qr.png` only after URL approval, using `npm run qr -- <configured HTTPS URL>`. Publish it at the approved public asset location without credential-bearing URLs.
- Copilot commentary is unavailable by default. Enable it only through a real attributed, moderated, trusted judge with reviewed configuration; never fabricate model output. Commentary does not change deterministic score/rank.
- Complete branding, authentic screenshots, privacy/retention decisions, and pilot acceptance before claiming production readiness.


## Completion URL rendering

The completion service remains the authority for public-address/DNS validation, HTTPS reachability, and approved QR origins. Its normalized result URLs may use public IPv4 or IPv6 literals as well as DNS names. The browser's `result-links.mjs` presents those URLs only for completed native-live runs; it checks safe HTTPS syntax but does not impose a second hostname/IP policy that could hide accepted results. Private/reserved addresses remain rejected by the existing server validator. Rehearsal, pilot, and pending results never expose event links. The module is served from the loopback asset allowlist and loaded by the module entrypoint.
