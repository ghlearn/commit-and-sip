# Commit & Sip booth runbook

**Current operational mode: rehearsal. Live launch is not approved or production-ready.** Missing native App evidence, remote verification/deployment, public leaderboard/QR, authentic screenshots, and approval decisions are launch blockers, not optional polish.

Attendees stay in the App. Commands below are staff-only and run from the repository root unless stated otherwise.

## Exercise shape

There is one learner step: **Review and serve your order**. The canvas's **Read the step guide** displays the [canonical instructions](../.github/steps/1-review-and-serve.md). Order, review, checkpoint, approval, serving, and result are activities within it. Staff initialization is not another learner step. Actions validate the repository, not learner progress; no real issue, PR, workflow transition, or issue closure is needed for rehearsal.

Keep rehearsal inside the panel. Native PR views elsewhere in the Copilot App are permitted for future live mode, but its missing integrations remain blockers. Do not send attendees to GitHub.com to work around them.

Reload extensions after changing the step or Markdown templates as well as extension code. Existing saved issue bodies are preserved; use a fresh rehearsal run to preview a changed order template.

## Before a session

1. Use Node.js 22+ and a Copilot host supporting project canvas extensions.
2. For development validation and QR tooling, run `npm ci`, `npm test`, and `npm run check`. Rehearsal runtime itself needs no dependency install after its modules are present. The extension SDK is host-resolved; do not install it.
3. Keep the data directory writable by the booth operator and inaccessible to unrelated users. Default: `$COPILOT_HOME/extensions/commit-and-sip/artifacts/`, where `COPILOT_HOME` defaults to `~/.copilot`. To isolate a staff device, set `COMMIT_AND_SIP_DATA_DIR` to an approved absolute directory before launching the host. Do not point it into the repository.
4. Reload extensions in the host. List loaded extensions, then inspect the project `commit-and-sip` entry and its log if it is failed. Reinspect after reload; file existence alone is not evidence the provider is running.
5. Inspect canvas capabilities, open `commit-and-sip` with a fresh rehearsal run, and complete a warm-up. Check visible rehearsal labeling, keyboard access, text status, and hint behavior.

Host tool sequence: `extensions_reload` → `extensions_manage` with `list`/`inspect` → `list_canvas_capabilities` → `open_canvas`. These names are not terminal commands. Use the actual loaded extension ID and log location reported by the host.

For a clickable, unassigned canvas, open with no input or `{}`. The setup screen lets staff/learners explicitly create a rehearsal with a selected drink and never-used run ID, or resume an existing rehearsal by its exact run ID. Write down the assigned ID. Merely opening setup does not create an order; it does not list other attendees' runs or allow live mode.

Use a complete assignment when you want automatic direct recovery after extension restart. Example open input:

```json
{"runId":"rehearsal-demo-001","mode":"rehearsal","orderId":"mona-latte"}
```

Choose a distinct panel `instanceId`. Actions address that instance; persistent data uses `runId`.

If the provider/App restarts after an empty-input launch, the panel returns to setup. Choose **Resume saved rehearsal** with the original ID, not New. Iframe reloads within a running provider keep the selected run. Fully specified inputs resume directly after restart. Missing IDs, reused new IDs, and live-as-rehearsal selections fail without creating or replacing records.

The old error `runId is a required property; mode is a required property` indicates the runtime still has the old declaration. Staff with host tooling must reload extensions and inspect the provider before retrying an empty open. Reload tools are host capabilities, not shell commands; repository changes alone do not restart a loaded provider.

## Live configuration checklist — blocked until integrations exist

Create the staff configuration:

```sh
cp booth/config.example.json booth/local-config.json
```

The destination is ignored. Do not place secrets in it. Configure:

| Field | Staff responsibility |
| --- | --- |
| `mode` | Set `live` only for a reviewed live deployment |
| `repo` | Exact authorized `owner/repository` |
| `requiredChecks` | Exact required check names; never empty them to bypass failures |
| `leaderboardUrl` | Approved publicly reachable HTTPS leaderboard |
| `completionEndpoint` | Authenticated server-only verifier endpoint |
| `qrImageUrl` | Approved publicly readable HTTPS QR image, renderable in an issue |
| `approvedQrOrigins` | Explicit approved HTTPS QR asset origins; the default empty list does not authorize an image host |
| `runs` | Fresh run-ID assignments; each includes `issueNumber`, `prNumber`, exact `headSha`, `reviewer`, and `orderId` |

Example IDs and the example SHA are not usable assignments. Validate the catalog order against the prepared issue and PR. Reload after staff configuration changes.

For authenticated completion, provision `COMMIT_AND_SIP_COMPLETION_TOKEN` in the staff host environment using approved secret handling, not a repository file or pasted shell history. After `joinSession`, the extension requests access to this exact variable only in live mode with a configured completion endpoint. Review and explicitly grant that SDK request. There are no blanket permission handlers; a denied/missing grant is a blocker, not a reason to put the token in browser state.

Use authenticated `gh` CLI contexts server-side. Staff may inspect authentication with `gh auth status` and the active identity with `gh api user --jq .login`; do not paste authentication diagnostics into attendee views. Prepare work under a separate PR-author identity. Verify the configured reviewer has repository access and permission to approve, is not the author, and is the identity used by the approval adapter. Verify the merge operator separately has permission and satisfies branch protection. Do not switch identities during an active run.

Inspect the assigned head and status without mutating the PR:

```sh
gh pr view <pr-number> --repo <owner/repository> \
  --json number,headRefOid,author,state,reviewDecision,statusCheckRollup
```

Do not approve your own PR, bypass protection, weaken checks, or grant blanket permissions just to unblock a demo. The canvas does not auto-merge. An authorized operator or approved external workflow performs the separate merge; serving verifies it.

Before admitting live attendees, require all of:

- Trusted native evidence bound to authenticated host/session/device and exact run/repository/PR/head, with event IDs, timestamps, and head invalidation.
- Completion service independently verifying signed/authorized native and GitHub facts, computing score/rank, reserving global handles, and reconciling retries by run ID.
- Trusted server-verifiable acceptance-checkpoint evidence for actual order values and scope; native view opens alone are insufficient.
- Real issue update and leaderboard round trip, including duplicate/retry tests.
- Approved public hosting and QR assets, authentic App screenshots, approved branding, and privacy/retention ownership.

No local button sequence or permissive evidence stub is an acceptable substitute.

`services/authority.mjs` now provides the in-process `CompletionAuthority` building block: durable server-computed receipts, deterministic global handle-collision resolution, idempotent comment finalization with a compatible writer, and anonymous leaderboard projection. It is not an HTTP/authenticated deployment. Operate its authority ledger in a separate dedicated server store, never the client rehearsal data directory. Server-owned assignments and independent GitHub/native-view/checkpoint readers must be configured by deployment staff; clients cannot provide scores or evidence.

The remote `CompletionAuthority.finalize` is the only live completion-comment writer. Configure its trusted `postComment` callback to use `GithubAdapter.upsertCompletionComment`; `prepareCompletionComment` verifies QR/leaderboard configuration and prepares the body before the final comment ID exists. The endpoint must persist and return a positive `commentId` with its receipt. `services/live.mjs` only verifies that receipt and updates local state; never add a local comment writer. Authority leaderboard publication includes confirmed-comment receipts only. Retry failures through the same remote endpoint and run ID, not a manual second comment.

If two devices submit the same curated handle phrase, the authority retains the phrase and adds a deterministic eight-hex suffix to resolve the collision. It reserves the canonical handle before commenting, and the client persists that value only from the verified authenticated receipt. A retry with the original candidate returns the same reservation. Do not manually rename handles; an unknown or different phrase for the same run is still rejected.

Staff may validate a prepared committed menu change before assignment:

```sh
node scripts/grade-order.mjs --base <FULL_BASE_SHA> --head <FULL_HEAD_SHA> --order mona-latte
```

Use full commit SHAs and the assigned order ID. The command checks the exact committed menu-only delta; it does not approve or merge anything and does not replace native evidence or live GitHub verification.

## Staff-only live pilot preflight

The successful rehearsal does not certify real GitHub review. Keep rehearsal available while completing the host-owned integration. Do not toggle live mode just to bypass this checklist.

1. Prepare a separate real learner issue and one menu-only PR under a different author from the designated reviewer. Use a fresh run ID and exact head SHA in ignored staff configuration; keep branch protection and required checks intact. This release does not automatically provision issues or PRs.
2. Run `npm run preflight:live -- --run RUN_ID` (optionally `--config PATH`). It is read-only. Compare its catalog criteria with the issue copy and separately confirm reviewer authentication and merge permissions. Exit 1 indicates failure; exit 2 means the assignment verified but live readiness is still blocked. No run, approval, merge, comment, or result is created.
3. Obtain a documented native App navigation/view-evidence integration from the host owner. The inspected SDK advertises canvas rendering and lifecycle, not authenticated native PR-view events. Inject the trusted reader server-side; never offer an HTTP or canvas action that accepts caller-authored view evidence. There is no production reader supplied in this repository.
4. In the pilot canvas, use the assigned issue/PR references and live step guide. Staff open native PR views inside the App until a supported navigation API is wired. After inspecting those views, choose **Refresh verified review**. Partial observations show progress; only all three verified views allow the factual checkpoint. **Refresh progress** does not verify views. Verification failures revoke saved progress and relock the checkpoint.
5. Have the learner answer the checkpoint and explicitly approve. Let the separate authorized operator merge, then choose **Verify merged menu**. Confirm **Your app result** and **House menu** show the verified drink and merge revision. If event services are missing, **Served — event result pending** is the expected boundary, not completed Skills or leaderboard success.
6. Restore finalization and retry the same run to obtain an accepted receipt before claiming a final issue update, score, or rank. No pilot result can enter rehearsal rankings. Capture authentic App screenshots and record native integration/permission evidence before admitting live attendees.

## Facilitate a run

1. Confirm the assigned run and mode before opening the order.
2. Let the attendee inspect summary, changes, and checks, using hints freely.
3. Ask them to compare the full order and answer the factual checkpoint.
4. Let them explicitly choose approval. If live, wait for the separate authorized merge.
5. Serve only after merge/menu verification. A generated handle should not exist before serving succeeds.
6. Confirm **Step 1 complete**, the learning summary, and one local result in rehearsal. In live mode, require one independently confirmed final issue update. Completion retries retain the saved handle and run; there is no next learner step.

Every correct completion earns 1,000 points. Tied scores share rank. Do not introduce speed, hint, retry, or accessibility penalties. Optional Copilot judging remains unavailable unless a real attributed and moderated trusted service is configured; never read fictional model feedback as authentic.

## Reset between attendees

For a fresh **rehearsal**:

```sh
npm run reset -- --new-run rehearsal-device1-002 --order mona-latte
```

Choose a never-used run ID; valid order IDs include `mona-latte`, `copilot-cortado`, and `ducky-cold-brew`. The command creates a fresh rehearsal run and preserves completed results. It does not destroy the ledger, reset live GitHub state, close panels, or perform remote writes.

Creation uses atomic `requireNew` enforcement: an existing ID fails instead of reopening or overwriting a run. Choose another fresh ID; do not delete the conflicting saved record.

After the command succeeds, close the old panel and open a new panel with the new domain run ID, explicit `mode: "rehearsal"`, and matching order. Reload/refresh of the old run resumes old state; it is not a reset.

For a fresh **live** attendee, staff must provision a new clean issue/PR and unique run assignment through the approved provisioning procedure. Never reuse a prior attendee's issue/PR, never force-reset remote branches, and never use the rehearsal script to recycle live work. Head changes require a fresh assigned run; do not update the stored SHA under an active run to salvage old view evidence.

## Offline, slow, and failed operations

| Symptom | Staff response |
| --- | --- |
| No network | Stop live intake. Offer a clearly labeled fresh rehearsal if the local host works; disclose that it produces no real review or event result. Never silently relabel an existing live run. |
| Slow issue/PR/check loading | Wait for the in-flight request; avoid repeated clicks. Inspect host logs and GitHub/service status. Preserve the run and rotate the device if needed. |
| Required checks pending or failing | Wait or repair the prepared exercise through staff procedure. Do not mark checks successful locally. |
| Native evidence unavailable/incomplete | Verify native App surfaces and trusted integration. If absent, live is blocked; canvas clicks cannot repair it. |
| Assigned head changed | Stop that run. Record staff diagnostics, preserve it, and provision a fresh issue/PR/run. |
| Approval unauthorized or own PR | Check author/reviewer identity and permissions. Do not retry under a more privileged account without a fresh reviewed assignment. |
| Approval verified, merge pending | Wait for a separately authorized merge, then retry `serve`. Approval alone is not successful serving. |
| Menu served, completion fails | Preserve the run. Restore the service, then invoke `complete` on the same panel/run. Do not reset, regenerate the handle, or manually post another result. |
| Timeout after remote acceptance | Query/reconcile the completion service by the same `runId`. Retry idempotently; confirm the existing result/comment is reused. |
| Handle phrase conflict or invalid receipt | Preserve the run/candidate and inspect the server reservation. Legitimate global collisions use the authority's deterministic suffix automatically; an unknown/different phrase must not be accepted. Retry the same candidate/run after diagnosis, without manually renaming or duplicating results. |
| Panel connection lost | Reopen the same run with a new panel instance if needed, then `refresh`. Do not share loopback URLs or tickets. |
| Unexpected provider error | Inspect the extension's host-reported log. Keep stack traces and identities out of attendee screens and public reports. |

`refresh` reads saved progress; it does not recheck GitHub or manufacture review events. Use the appropriate gated action after the underlying problem is resolved. Avoid concurrent recovery operations from multiple panels.

## Lock and storage recovery

The store uses `ledger.json` and `ledger.lock`, with atomic fsynced ledger writes. Slow I/O or a long live operation can legitimately hold the lock.

1. Stop intake and note the affected run IDs. Inspect the exact provider log and lock metadata. Determine the actual data directory from the host environment; do not guess.
2. Verify the recorded lock-owner PID with `ps -p <pid> -o pid,ppid,lstart,command`. Compare the process identity/start time, not just PID existence; PIDs can be reused.
3. If the owner/provider is active, **do not remove the lock**. Allow the operation to finish or shut down the specific extension/provider through the host. Check for other active providers sharing the directory.
4. Only after confirming no active provider/writer owns or uses this store, make a backup of the ledger and lock in an approved staff-only recovery location. Keep backups out of Git and public attachments.
5. If the lock is proven stale, remove only that exact `ledger.lock`. Do not use wildcard deletion, erase the ledger, or kill processes by name.
6. Restart/reload one provider, inspect its health, reopen the same run, and verify the ledger and completed results. Reconcile any uncertain remote completion before retrying.

If ownership is uncertain, leave the lock in place and escalate. If JSON is corrupt or storage is full/unwritable, preserve evidence and restore only through a reviewed backup/reconciliation procedure. Do not replace it with an empty ledger to make the error disappear.

## Leaderboard and QR readiness

There is no approved deployment/public URL yet. This private repository and a local `127.0.0.1` renderer cannot host an attendee phone experience. Never use credential-bearing GitHub URLs to make private images appear public.

After the public destination is approved and configured:

```sh
npm run qr -- <configured-HTTPS-leaderboard-URL>
```

Review the generated `.github/images/leaderboard-qr.png`, publish it at the approved publicly readable asset location, set `qrImageUrl`, and verify issue rendering. Scan from a personal phone on attendee Wi-Fi or cellular without staff credentials. Confirm the exact destination, high contrast, quiet zone, descriptive alt text, and a readable fallback link. No placeholder image may be labeled a scannable production QR.

The generator verifies public URL reachability before producing the PNG and `.github/images/leaderboard-qr.png.json` manifest, which records the encoded URL and PNG SHA-256 digest. Retain/review both together. Set the asset origin in `approvedQrOrigins`; the live client also verifies image reachability. Automated tests independently decode generated QR images with `jsqr`, but this does not replace a phone scan of the published issue-rendered asset.

## Daily operations and pilot evidence

Before opening: validate host/extension health, accounts and assignments, genuine native evidence, service health, public QR reachability, and a complete pilot run. After an incident, repeat the affected gate before resuming live intake.

Keep staff-only daily observations of completion time, intervention, actual changed-files/checks views, final-result latency, reset success, and retry/duplicate outcomes. The preserved outline's targets are:

- At least 85% complete without staff intervention.
- Median completion within five minutes.
- At least 90% open changed files and checks before approval.
- At least 95% of completed runs get the issue update and leaderboard result within five seconds.
- Consistent reset between attendees.

These are proposed acceptance targets, not results already achieved. Pilot measurements and daily capture tooling are unresolved. Do not invent evidence.

End of day: reconcile pending completions, preserve approved backups, close panels, and stop intake. Event-data retention period, deletion schedule, responsible owner, and access policy still need approval; do not invent a duration or delete records while retries remain unresolved. Publish only approved anonymous outputs.
