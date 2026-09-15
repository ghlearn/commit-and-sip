# Integration contract

This document separates supported extension behavior from unresolved production integrations. It is not evidence that a live booth deployment has been approved.

## Confirmed Skills adaptation

The current delivery is a rehearsal-first, single-step exercise. The canvas owns initialization, review activities, checkpoint feedback, approval, serving, and the local result. Staff initialization is outside the learner step. Actions remain repository validation only: no issue-driven Step 0/Step 1 transition workflows, automatic issue closure, or Step 2 are added.

`.github/steps/1-review-and-serve.md` is the canonical rehearsal guide. `content.mjs` loads it and the repository-owned Markdown templates at module initialization; no dependency install or remote content fetch occurs during play. The public run projection includes `exercise: { title, sections: [{ heading, paragraphs }], completion }`. Completion text is `null` until `phase` is `completed`, and is presentation only, not completion evidence. Existing saved runs obtain current guide content without changing their persisted phases, events, results, or issue body.

The renderer uses text nodes for the guide and templates, not HTML evaluation or a general Markdown renderer. The guide permits one Step 1 heading, level-two activity headings, and plain paragraphs. Missing content, unsupported structure, or unresolved placeholders fails explicitly. Reload the extension after changing content. Rehearsal order text is rendered from `booth/orders.json`; live assigned issues and the remote completion-comment writer retain their existing ownership.

Rehearsal stays entirely in the panel. Future live review may open authentic native PR views elsewhere inside the Copilot App. This scope decision does not implement native navigation or evidence capture; all existing live gates remain mandatory. No learner GitHub.com navigation, production deployment, or simulated live certification is introduced.

## Supported canvas boundary

The project extension entrypoint is `.github/extensions/commit-and-sip/extension.mjs`. The installed host's extension SDK documentation is the authority for `joinSession`, `createCanvas`, lifecycle callbacks, action schemas, and error handling. Consult that installed documentation or the host extension authoring guide; do not infer undocumented navigation or telemetry APIs from the existence of a canvas.

The SDK is host-resolved. No standalone SDK installation is required.

Registered canvas ID: `commit-and-sip`.

Open with omitted input or `{}` to display an unassigned setup screen. No run, review, mode, or result is created by that open. The schema also accepts a complete assignment for a direct open:

```json
{"runId":"rehearsal-demo-001","mode":"rehearsal","orderId":"mona-latte"}
```

Partial inputs such as `{"runId":"example"}` still fail. An invalid live assignment never falls back to rehearsal.

The setup screen requires an explicit **Create new rehearsal** or **Resume saved rehearsal** decision. It suggests a random run ID for new runs without saving it until selection; the learner/staff chooses the catalog drink. Resume requires an existing rehearsal ID and takes its saved order. It does not create missing runs, list other attendees' data, overwrite existing runs, or resume live runs as rehearsal.

The `select_run` action takes `{"operation":"new","runId":"UNUSED_ID","mode":"rehearsal","orderId":"mona-latte"}` or `{"operation":"resume","runId":"EXISTING_ID","mode":"rehearsal"}`. Both HTTP and SDK actions route through the same per-panel binding. A selected panel cannot switch to another run; retrying the same confirmed selection returns its saved state. Other exercise actions require selection first; `refresh` can inspect setup without creating evidence.

Setup state is `{phase:"setup", mode:null, suggestedRunId, orders:[{id,name}]}`. Existing bound-state projections are unchanged. Setup pages and selection APIs retain the same loopback capability, origin, host, and bounded-request protections as the exercise.

Selection binds the running panel, not the persisted exercise. Iframe reloads and repeated opens keep that binding while the provider lives. On provider/App restart, an empty-input open returns to setup: explicitly resume by the original run ID. A complete assignment rehydrates directly from its saved input. No persistent record is keyed by `instanceId`, and reopening setup never resets exercise data.

`runId` is stable domain identity: 1–80 letters, digits, hyphens, or underscores, starting with a letter or digit. `mode` is explicitly `rehearsal` or `live`. Live `orderId` must match the staff assignment. A panel's caller-selected `instanceId` is a separate lifecycle handle. Reopen the same domain run to resume; use a new panel instance for a different run.

| Action | Input | Meaning |
| --- | --- | --- |
| `select_run` | Explicit new/resume rehearsal selection (above) | Bind an unassigned setup panel without starting review |
| `start` | `{}` | Load assigned issue and review data |
| `view` | `{"surface":"summary"}` (also `changes`, `checks`) | Rehearsal-only sequential view progression; never live certification |
| `hint` | `{}` | Acceptance-criteria guidance without score penalty |
| `check_order` | `{"price":5.5,"serving":"hot","scope":"one-drink"}` | Factual checkpoint; use assigned order values |
| `approve` | `{}` | Explicit review decision, with prerequisites; not merge |
| `serve` | `{}` | Simulate rehearsal menu or verify authorized live merge |
| `complete` | `{}` | Retry finalization after serving; retain identity/result |
| `refresh` | `{}` | Read persisted state; does not create review evidence |

Checkpoint enums: `serving` is `hot` or `cold`; `scope` is `one-drink` or `unrelated-edits`. Unexpected input properties are rejected. Serving initiates completion, so a completion-service failure can follow a successful, durable menu update.

`completionPending` means finalization remains unfinished, not that a worker is currently running. A served run must offer **Retry result** after an error or reload; the renderer disables actions only during its active request, and the server serializes concurrent attempts.

## Server-side live dependencies

`RunEngine` receives a durable store, order catalog, staff configuration, and trusted adapters. The renderer does not supply or override adapters.

- **GitHub adapter:** reads the assigned issue; inspects the exact pull request, expected head SHA, designated reviewer, changed files/menu, required checks, approval and merge facts; creates an explicit SHA-bound approval only through the authorized reviewer. Its inspection result includes `headSha`, `checksPassed`, `approved`, `merged`, `mergeCommitSha`, `menu`, and presentation data (`summary`, `files`, `checks`).
- **View-evidence adapter:** provides `read` as specified below. No production implementation is currently supplied.
- **Completion adapter:** provides `finish(run)` only after serving, using an authenticated server-side endpoint. A configured endpoint or local adapter does not establish that the remote verifier exists or is trustworthy.

`services/live.mjs` wires the GitHub and completion adapters after `joinSession`. Only when mode is `live` and `completionEndpoint` is configured does the extension request the exact `COMMIT_AND_SIP_COMPLETION_TOKEN` environment variable through the SDK's explicit user-grant mechanism. It does not install blanket permission handlers. A missing or denied grant blocks authenticated completion; never copy the token into configuration or browser state to bypass consent.

Live configuration uses `mode`, `repo`, `requiredChecks`, `leaderboardUrl`, `completionEndpoint`, `qrImageUrl`, `approvedQrOrigins`, and a `runs` map keyed by domain run ID. Each assignment contains `issueNumber`, `prNumber`, exact 40-character `headSha`, `reviewer`, and `orderId`. `approvedQrOrigins` defaults to `[]`; staff must explicitly allow the public HTTPS origin serving the QR image. Example configuration is not a valid live assignment.

GitHub credentials stay with authenticated server-side `gh` CLI execution. The PR author and reviewer must be different authorized identities. Authentication alone does not confer review or merge permission, and branch protection is never bypassed.

Required checks must come from the official `github-actions` check publisher by default; a same-named commit status or another app cannot substitute. The adapter also supports explicit publisher-slug overrides and additional app-ID pinning for a separately reviewed server deployment.

## Unresolved: native view evidence

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

The current engine checks the trusted provider's identity projection and surface coverage; that does **not** implement host authentication, event provenance, or replay defenses. Those are requirements on the missing integration. Do not wire a permissive stub into live mode to make the flow appear complete.

Even authentic view events prove a surface was opened, not that a learner understood it. The price/serving/scope checkpoint and exact menu verification remain required.

## Implemented authority; unresolved authenticated deployment

`services/authority.mjs` supplies `CompletionAuthority`, a server-side deployment building block. It is **not a hosted or authenticated HTTP service**. Deployment code must inject its own dedicated durable store, server-owned assignments, catalog, independent GitHub adapter, trusted `viewEvidence` and `checkpointEvidence` readers, and `postComment` writer.

| Method | Supported behavior |
| --- | --- |
| `accept({runId, handle})` | Verify the server-owned assignment, curated handle, independent evidence and GitHub facts; durably reserve one receipt with score 1,000 and a competition-rank snapshot |
| `finalize({runId, handle})` | Accept or reuse the same receipt, call `postComment` if its comment ID is not yet saved, and return the receipt with the verified comment ID |
| `leaderboard()` | Return only finalized entries projected to `handle`, `score`, and recalculated `liveRank`; exclude private run/assignment data |

Clients may submit only `runId` and `handle`, not scores, assignments, or evidence. The authority resolves global handle collisions by retaining the same curated three-word phrase and appending a deterministic eight-hex-character suffix. It reserves that canonical handle durably in the authority store before writing the comment. Retrying with the same original candidate returns the same reservation rather than generating another handle/result. An unknown or different phrase for the same run still fails.

The authority's store must be a **different, dedicated server store**, never the client rehearsal ledger. The server owns assignments including repository, issue/PR, exact head, reviewer, required checks, and order. The authority rejects reused issue/PR assignments across event runs.

Both trusted evidence readers receive `{runId, repo, prNumber, headSha}` and must return exactly matching identity fields. In addition to all three native surfaces, `checkpointEvidence.read(identity)` must return `passed: true`, the actual order's `price` and `serving`, and `scope: "one-drink"`. This checkpoint must be server-verifiable from the actual acceptance criteria and trusted learner interaction; view opens, client assertions, and the local engine's saved success flag are insufficient.

`postComment` must itself be idempotent by the receipt's run ID and reconcile a prior successful write whose response was lost. The authority persists the returned positive comment ID; a crash between the remote write and server-store persistence can otherwise repeat the callback. Durable finalization does not make arbitrary remote comment writers exactly-once.

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

## Unresolved: host navigation, hosting, and judging

- Native issue/PR navigation and native-view capture must be verified against the actual booth App build. The canvas registration is not a navigation API.
- A private repository is intentional, not a public deployment. An approved publicly reachable HTTPS leaderboard and publicly readable, issue-renderable QR asset are required. Loopback and private assets do not work on attendees' phones.
- Generate `.github/images/leaderboard-qr.png` only after URL approval, using `npm run qr -- <configured HTTPS URL>`. Publish it at the approved public asset location without credential-bearing URLs.
- Copilot commentary is unavailable by default. Enable it only through a real attributed, moderated, trusted judge with reviewed configuration; never fabricate model output. Commentary does not change deterministic score/rank.
- Complete branding, authentic screenshots, privacy/retention decisions, and pilot acceptance before claiming production readiness.
