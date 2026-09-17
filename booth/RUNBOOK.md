# Commit & Sip booth runbook

**Default operational mode: rehearsal. Production live launch is not approved.** The separately opt-in `live-canvas-pilot` supports an unranked real-GitHub exercise only for future authorized staff-prepared work; it does not remove missing native App evidence, remote completion deployment, public leaderboard/QR, authentic screenshots, or approval requirements.

Attendees stay in the App. Commands below are staff-only and run from the repository root unless stated otherwise.

## Exercise shape

There is one learner step: **Review and serve your order**. The canvas's **Read the step guide** displays the [canonical instructions](../.github/steps/1-review-and-serve.md). Order, review, checkpoint, approval, serving, and result are activities within it. Staff initialization is not another learner step. Actions validate the repository, not learner progress; no real issue, PR, workflow transition, or issue closure is needed for rehearsal.

Keep rehearsal inside the panel. The unranked pilot also stays in the panel, presenting real GitHub data with canvas observations, not native evidence. Native PR views elsewhere in the Copilot App are permitted for future ranked `live`, but its missing integrations remain blockers. Do not send attendees to GitHub.com to work around them.

Reload extensions after changing the step or Markdown templates as well as extension code. Existing saved issue bodies are preserved; use a fresh rehearsal run to preview a changed order template.

## Before a session

1. Use Node.js 22+ (`nvm use` reads the pinned `.nvmrc`) and a Copilot host supporting project canvas extensions. Staff CLIs such as `npm run preflight:live` and `npm run provision:live` refuse to run on an older runtime rather than behaving unpredictably against GitHub.
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

## Native-live configuration checklist — blocked until integrations exist

Create the staff configuration:

```sh
cp booth/config.example.json booth/local-config.json
```

The destination is ignored. Do not place secrets in it. Configure:

| Field | Staff responsibility |
| --- | --- |
| `mode` | Set `live` only for a reviewed native-live deployment; the separate unranked procedure below uses `live-canvas-pilot` |
| `repo` | Exact authorized `owner/repository` |
| `requiredChecks` | Exact required check names; never empty them to bypass failures |
| `leaderboardUrl` | Approved publicly reachable HTTPS leaderboard |
| `completionEndpoint` | Authenticated server-only verifier endpoint |
| `qrImageUrl` | Approved publicly readable HTTPS QR image, renderable in an issue |
| `approvedQrOrigins` | Explicit approved HTTPS QR asset origins; the default empty list does not authorize an image host |
| `runs` | Fresh run-ID assignments; each includes `issueNumber`, `prNumber`, exact `headSha`, intended application `baseRef`, `reviewer`, and `orderId`; pilot requires explicit `reviewSource: "canvas-pilot"` |

Example IDs and the example SHA are not usable assignments. Validate the catalog order against the prepared issue and PR. Reload after staff configuration changes.

For authenticated completion, provision `COMMIT_AND_SIP_COMPLETION_TOKEN` in the staff host environment using approved secret handling, not a repository file or pasted shell history. After `joinSession`, the extension requests access to this exact variable only in live mode with a configured completion endpoint. Review and explicitly grant that SDK request. There are no blanket permission handlers; a denied/missing grant is a blocker, not a reason to put the token in browser state.

Use authenticated `gh` CLI contexts server-side. Staff may inspect authentication with `gh auth status` and the active identity with `gh api user --jq .login`; do not paste authentication diagnostics into attendee views. Prepare work under a separate PR-author identity. Verify the configured reviewer has repository access and permission to approve, is not the author, and is the identity used by the approval adapter. Verify the merge operator separately has permission and satisfies branch protection. Do not switch identities during an active run.

Inspect the assigned head and status without mutating the PR:

```sh
gh pr view <pr-number> --repo <owner/repository> \
  --json number,headRefOid,author,state,reviewDecision,statusCheckRollup
```

Do not approve your own PR, bypass protection, weaken checks, or grant blanket permissions just to unblock a demo. The canvas does not auto-merge. An authorized operator or approved external workflow performs the separate merge; serving verifies it.

Before admitting ranked native-live attendees, require all of:

- Trusted native evidence bound to authenticated host/session/device and exact run/repository/PR/head, with event IDs, timestamps, and head invalidation.
- Completion service independently verifying signed/authorized native and GitHub facts, computing score/rank, reserving global handles, and reconciling retries by run ID.
- Trusted server-verifiable acceptance-checkpoint evidence for actual order values and scope; native view opens alone are insufficient.
- Real issue update and leaderboard round trip, including duplicate/retry tests.
- Approved public hosting and QR assets, authentic App screenshots, approved branding, and privacy/retention ownership.

No local button sequence or permissive evidence stub is an acceptable substitute.

`services/authority.mjs` now provides the in-process `CompletionAuthority` building block: durable server-computed receipts, deterministic global handle-collision resolution, idempotent comment finalization with a compatible writer, and anonymous leaderboard projection. It is not an HTTP/authenticated deployment. Operate its authority ledger in a separate dedicated server store, never the client rehearsal data directory. Server-owned assignments and independent GitHub/native-view/checkpoint readers must be configured by deployment staff; clients cannot provide scores or evidence.

The remote `CompletionAuthority.finalize` is the only live completion-comment writer. Its trusted `postComment` callback must provide atomic remote deduplication using the supplied idempotency key; `GithubAdapter.upsertCompletionComment` and `IssueCompletionWriter` can supply marker/body reconciliation within that service, but read-then-create alone is not an atomic exactly-once writer. `prepareCompletionComment` verifies QR/leaderboard configuration and prepares the body before the final comment ID exists. The endpoint must persist and return a positive `commentId` with its receipt. `services/live.mjs` only verifies that receipt and updates local state; never add a local comment writer. Authority leaderboard publication includes confirmed-comment receipts only. Retry failures through the same remote endpoint and run ID, not a manual second comment.

If two devices submit the same curated handle phrase, the authority retains the phrase and adds a deterministic eight-hex suffix to resolve the collision. It reserves the canonical handle before commenting, and the client persists that value only from the verified authenticated receipt. A retry with the original candidate returns the same reservation. Do not manually rename handles; an unknown or different phrase for the same run is still rejected.

Staff may validate a prepared committed menu change before assignment:

```sh
node scripts/grade-order.mjs --base <FULL_BASE_SHA> --head <FULL_HEAD_SHA> --order mona-latte
```

Use full commit SHAs and the assigned order ID. The command checks the exact committed menu-only delta; it does not approve or merge anything and does not replace native evidence or live GitHub verification.

## Staff-only live pilot preflight

This is the native-live preflight and future native-host procedure, not the unranked canvas-pilot flow below. The successful rehearsal does not certify real GitHub review. Keep rehearsal available while completing the host-owned integration. Do not toggle live mode just to bypass this checklist.

1. Prepare one real menu-only PR under a different author from the designated reviewer, then use the staff-only provisioning procedure below to create its exercise issue and assignment. Use a fresh run ID, exact head SHA, and intended application `baseRef`; keep branch protection and required checks intact. The effective check list is pinned during provisioning and cannot be changed on resume. The initializer claims an existing PR; it does not create one or claim Copilot authored it.
2. Run `npm run preflight:live -- --run RUN_ID` (optionally `--config PATH`). It is read-only. Compare its catalog criteria with the issue copy and separately confirm reviewer authentication and merge permissions. Exit 1 indicates failure; exit 2 means the assignment verified but live readiness is still blocked. No run, approval, merge, comment, or result is created.
3. Obtain a documented native App navigation/view-evidence integration from the host owner. The inspected SDK advertises canvas rendering and lifecycle, not authenticated native PR-view events. Inject the trusted reader server-side; never offer an HTTP or canvas action that accepts caller-authored view evidence. There is no production reader supplied in this repository.
4. In the native-live canvas, use the assigned issue/PR references and live step guide. Staff open native PR views inside the App until a supported navigation API is wired. After inspecting those views, choose **Refresh verified review**. Partial observations show progress; only all three verified views allow the factual checkpoint. **Refresh progress** does not verify views. Verification failures revoke saved progress and relock the checkpoint.
5. Have the learner answer the checkpoint and explicitly approve. Let the separate authorized operator merge, then choose **Verify merged menu**. Confirm **Your app result** and **House menu** show the verified drink and merge revision. If event services are missing, **Served — event result pending** is the expected boundary, not completed Skills or leaderboard success.
6. Restore finalization and retry the same native-live run to obtain an accepted receipt before claiming a final issue update, score, or rank. No live result can enter rehearsal rankings. Capture authentic App screenshots and record native integration/permission evidence before admitting live attendees.

## Staff-only unranked canvas pilot

**Future authorized execution only. This milestone performs no real provisioning, approval, merge, or staff configuration change.** Permission verification, authentic App screenshots, branding/privacy decisions, and trusted native hosting remain unresolved. The pilot is not production Skills/event completion and cannot be promoted into a ranked run.

1. Obtain explicit staff authorization for one prepared real, menu-only PR and its fresh issue/run assignment. Verify the separate author, designated reviewer, issue creator, and merge operator permissions; preserve branch protection and trusted required checks. Use the same durable store/config as the canvas. Never repurpose a native-live or rehearsal run.
2. Preview provisioning with the normal required assignment flags plus **`--review-source canvas-pilot`**:

   ```sh
   npm run provision:live -- --run UNIQUE_RUN_ID --pr PREPARED_PR_NUMBER \
     --head FULL_VERIFIED_HEAD_SHA --base main --reviewer ASSIGNED_REVIEWER \
     --order mona-latte --review-source canvas-pilot
   ```

   Only after authorized staff approve the exact preview, repeat with `--apply`. This creates the real issue and pins `reviewSource: "canvas-pilot"` in the durable journal/config. It **does not change config mode**. Preserve this flag on retries; omitted source is native-live, not pilot.
3. Separately, authorized staff enable `mode: "live-canvas-pilot"` in the host's ignored `booth/local-config.json`, preserving the installed assignment and all other settings. Reload extensions, inspect provider health/capabilities, and directly open the supplied assignment, for example:

   ```json
   {"runId":"ASSIGNED_RUN_ID","mode":"live-canvas-pilot","orderId":"mona-latte"}
   ```

   Before opening, run `npm run preflight:live -- --run ASSIGNED_RUN_ID` against that config (use `--config` if needed). For an explicit pilot pairing, exit **0** means only assignment-verified; exit **1** is failure. The report still has `liveReady: false`, `eventEligible: false`, and `permissionsCertified: false`. Independently verify staff permissions; this is not native-host or event certification. Substitute the actual assigned order/run in the open input. Setup and `select_run` remain rehearsal-only; no renderer control provisions or creates pilots. After restart, reopen the same direct assignment.
4. Start the order. Have the learner inspect **Summary → Changes → Checks** sequentially. Each pilot view rechecks actual GitHub data before saving an observation for this exact assignment/head. Disclose that these are **canvas observations, not native App view events**. Have the learner compare the actual menu with the order and submit their own checkpoint answers; do not prefill correct answers for them.
5. After inspecting checks/menu and passing the checkpoint, obtain an explicit human approval decision. The real approval is bound to the exact head and durable attempt marker, with reviewer/author guards. Never merge automatically, substitute another reviewer, or copy a marker into a manual review.
6. A separately authorized operator/workflow merges. Then invoke `serve` to independently verify the pinned head/base/menu/checks and exact effective approval attempt. Pilot verification also requires the current assigned base tip to contain the merge and have the exact inspected menu; a second base-ref read rejects movement during verification. Successful serving shows the menu, merge SHA, and learning summary at **`pilot-served`**. There is no `completed` phase/event, handle, score, rank, QR, judge, event submission, or completion comment. `complete` is deliberately blocked with `pilot_not_ranked`; the authority is never called and independently rejects pilot assignments.

Actual verification errors durably clear current views, checkpoint, and copied review data. Preserve the same run and exact decision/attempt, which retains the actual submitted answers and source/assignment binding. While reviewing, restore GitHub access and reinspect/reanswer; once approved, retry `serve` after the separate merge without re-approving, even after a pending-merge failure. Do not create synthetic native timestamps. Mode/source or assignment/check-policy changes block every operation, including refresh; configuration/source/mode mismatches do not mutate the ledger. Old unbound state fails closed; do not edit it to invent an original binding. A changed head needs a fresh reviewed assignment. No fallback, conversion, endpoint setting, or manual result submission can make a pilot ranked.

The in-canvas pilot guide comes from `.github/markdown-templates/canvas-pilot-guide.md`. Browser test fixtures under `tests/fixtures` use the real `GithubAdapter` with mocked transport and no actual GitHub writes—not actual GitHub execution or native App screenshots. Do not use them as proof that staff performed this procedure. See [repeatable browser validation](../docs/architecture.md#repeatable-mocked-transport-browser-validation) for the isolated fixture and Playwright MCP scripts; clearly label any resulting screenshots as mocked-transport renderer evidence only.

## Staff-only live exercise provisioning

This is setup, not another learner step. It creates a real issue only with explicit `--apply`; it never starts a learner run, approves, merges, closes an issue, writes completion comments, submits scores, generates QR placeholders, or manufactures native/checkpoint/approval proofs. **Provisioned != reviewed != served != completed.** Ranked native-live admission remains blocked by the existing integration checklist; the unranked pilot has the separate authorization procedure above.

Use one designated staff initializer for the repository/pool. Every initializer process and the canvas must use the same durable `COMMIT_AND_SIP_DATA_DIR` (the normal canvas data directory by default). The journal is `provisions[]` in that store's `ledger.json`, alongside but separate from learner runs/results. Do not use a disposable directory, copy the ledger to independent writers, or run multiple device-local coordinators against the same pool: GitHub's issue-create API has no atomic idempotency-key guarantee. Repository-wide marker scans help detect prior claims but do not serialize independent stores.

Before provisioning: stop learner intake and config editors; configure the exact authorized `repo` and required checks in ignored `booth/local-config.json`, preserving existing assignments. Use an empty `runs` map on a genuinely fresh staff configuration rather than the example placeholder assignment. Never erase actual assignments to make a conflict pass. Staff must authenticate the issue-creator `gh` context, confirm its issue-write permissions, identify the separate authorized reviewer (not the PR author), and verify reviewer and merge-operator permissions. No credentials belong in the config or arguments.

```sh
npm run provision:live -- --run UNIQUE_RUN_ID --pr PREPARED_PR_NUMBER \
  --head FULL_VERIFIED_HEAD_SHA --base main --reviewer ASSIGNED_REVIEWER \
  --order mona-latte
```

All six assignment flags are required. Optional `--config STAFF_CONFIG_PATH` selects an existing regular JSON file. Optional `--review-source canvas-pilot` explicitly opts into the unranked path; omission retains native-live behavior. Default **preview** reads GitHub and local state only, verifies the exact same-repository, open, non-draft, mergeable, menu-only PR and trusted passing checks, rejects a designated-reviewer approval/merge, and displays the proposed issue and assignment without exposing the reviewer in CLI output. It does not prove the configured reviewer is currently authenticated or has approval permission. A preview is a point-in-time report, not a reservation.

Pilot provisioning/preflight also require an inspectable summary, a nonempty single-file patch, and checks presentation. `review_unavailable` blocks reservation/issue creation if that material is missing; do not replace it with fabricated review text or waive the gate because checks passed.

After reviewing the preview, repeat the identical command with `--apply`. The initializer:

1. Reserves the run/PR in a short local transaction, recording the exact catalog order, repository, head SHA, base ref, reviewer, review source, effective check list, creator, and rendered issue body.
2. Scans all open/closed repository issues for stable run/PR markers. Before the only issue POST, it durably marks the record `creating`. No global ledger lock is held during any network request.
3. Reconciles the exact owned issue, rechecks the prepared PR, durably binds its issue number, and atomically writes the assignment into the current staff config. Other settings and runs are preserved; `mode` is never changed. The command returns the matching canvas open input, not readiness approval.

The issue includes all drink criteria and the source-appropriate **Step 1: Review and serve your order** guide. Its learning activities stay in one step, including feedback, separate approval/serving, and native event-result or unranked pilot guidance as appropriate. No attendee cloning, terminal, external editor, or GitHub.com action is introduced. The canvas styling and bundled Mona Sans are unchanged.

Successful preview/provision commands exit **0**, meaning only that operation succeeded; errors exit **1**. Reports expose `mode`, `reviewSource` (default `native`), and false `liveReady`, `eventEligible`, and `permissionsCertified` flags. For native-live assignments, run `npm run preflight:live -- --run UNIQUE_RUN_ID` afterward (with the same config path if non-default); it requires matching configuration and exits **2** for a verified-but-blocked assignment. Explicit canvas-pilot assignments instead exit **0** after preflight verification under matching pilot configuration, still without permission certification or event readiness. Follow the separate opt-in procedure above. For canvas use, put the installed assignment in the host's normal ignored config and reload the extension; a custom CLI config path does not change the host's config path.

### Provisioning recovery

Always retry the **exact original command, review source, run, staff creator, PR/head/base/order/reviewer, config path, and store**. Do not create a replacement issue manually, change the saved SHA/source, repurpose the PR, or delete a reservation.

**A process/host crash during a filesystem transaction can leave `ledger.lock` behind.** Restarting the initializer alone does not reclaim it: retries return `store_busy` even when the issue journal is intact. Complete [Lock and storage recovery](#lock-and-storage-recovery) first, then retry the original command. An old timestamp or missing local PID alone cannot establish that every writer is stopped, especially for a shared directory or after a host restart. Never remove a lock automatically, swap to a new store, or reset journal stages to unblock intake.

| Condition | Safe response |
| --- | --- |
| `store_busy` persists after process/host restart | Stop intake and all writers using this store; inspect ownership and back up the ledger/lock. Remove only the exact proven-stale lock through the procedure below, then retry the same run. Leave the assignment, create intent, and issue untouched. |
| Failure while `reserved`, before create intent | Restore the read/config service and retry the same run. No create intent was issued yet. |
| Timeout/crash while `creating` | Retry to scan and verify the exact original creator/title/body/marker. If the issue exists, it is reused without POST. If none is visible, the command fails with `provision_reconciliation_required`; even a crash before the actual POST stays blocked. |
| No issue found for an unresolved create | Stop this PR's intake. Inspect staff-only journal, original request/audit evidence, and all repository issues with the stable run marker; wait for any in-flight request. There is intentionally no automatic reset/recreate override. If ownership/outcome remains unknown, preserve the reservation and escalate; do not infer that an empty listing proves no remote write. |
| Issue exists but body/title/owner/state/marker changed, or duplicate markers exist | No PATCH, deletion, closure, or automatic adoption occurs. Preserve the issue and journal; an authorized staff owner must reconcile the discrepancy. Retry only once the exact original owned issue is established. |
| Config write failed or response lost after rename | The journal retains the bound issue; restore writable storage and retry. An already matching assignment is reused, not overwritten or duplicated. |
| Config changed during provisioning | Other settings/runs are reread under the shared lock and preserved. A changed target assignment/repository/check policy fails closed. Pause external config editors before retrying: filesystem rename is atomic but is not a compare-and-swap against arbitrary editors. |
| PR head/base/checks changed or it was approved/merged | Stop the run and preserve its reservation/issue. Do not repin it to salvage old evidence. Staff must prepare a distinct clean PR/issue/run for a new exercise. |
| Run was already opened in the canvas | Provisioning stops. Continue existing learner recovery instead; initialization cannot modify active or completed progress. |

Keep journal/config/backups private and out of Git. The issue body excludes reviewer identity; CLI output excludes reviewer but still contains private operational run/issue mappings and belongs only in staff tools. Permissions, retention, hosted authority, authentic screenshots, approved artwork/mascots, public leaderboard/QR, and genuine Copilot judging remain future pilot requirements.

## Facilitate a run

1. Confirm the assigned run and mode before opening the order.
2. Let the attendee inspect summary, changes, and checks, using hints freely.
3. Ask them to compare the full order and answer the factual checkpoint.
4. Let them explicitly choose approval. If live, wait for the separate authorized merge.
5. Serve only after merge/menu verification (simulated in rehearsal). A generated handle should not exist before serving in scored modes, or at all in the pilot.
6. Confirm **Step 1 complete**, the learning summary, and one local result in rehearsal. In native `live`, require one independently confirmed final issue update. In the pilot, confirm only **`pilot-served`**, menu/merge SHA, and its learning summary—not Skills/event completion. Scored-mode completion retries retain the saved handle and run; there is no next learner step.

Every correct rehearsal or accepted native-live completion earns 1,000 points. Tied scores share rank. The pilot has no points, rank, or judging. Do not introduce speed, hint, retry, or accessibility penalties. Optional native-live Copilot judging remains unavailable unless a real attributed and moderated trusted service is configured; never read fictional model feedback as authentic.

## Approval and reservation retry recovery

If a native-live approval write may have succeeded but verification failed while still reviewing, keep the original run. Its private attempt marker was saved before the write. Restore native/GitHub evidence, choose **Refresh verified review**, repeat the factual checkpoint, and explicitly retry approval. Only the exact effective reviewer/head/attempt match is reconciled; an unrelated pre-existing approval still requires a fresh assignment. Do not erase or replace the attempt to recover, and do not manually copy its marker into another review. For the pilot, use sequential reverified canvas views instead of native synchronization. If already in `approved`, preserve that exact decision and retry serving after the separate merge without another approval.

Authority reservations are bound to the original repository, issue/PR, head, target branch, reviewer, order, required checks, and trusted approval attempt/timing proof. Restore that registration before retrying finalization. Changing the registration cannot move the receipt to a new issue. A legacy reservation with no saved assignment or proof is blocked; staff must recover its original independently verified binding, not infer it from current configuration or reset the run to conceal an uncertain result.

The production host/server integration must register the attempt UUID and chronological `reviewedAt`, `checkpointAt`, and `decidedAt` times. Independent view/checkpoint readers must confirm the corresponding `completedAt` values, and GitHub must confirm this attempt's marked review and submission time. Do not hand-fill these values from a rehearsal or current clock to make a pilot pass; that would not establish authentic learner ordering.

Authority work uses per-run ownership claims with a default 60-second lifetime and periodic renewal, not a global lock around remote calls. `completion_busy` means this run is still owned by another worker; retry the same run later. `completion_claim_lost` means an expired/replaced worker cannot commit; reconcile through the same finalization service rather than manually posting another comment. Claims and persisted candidate/assignment bindings must not be deleted to force completion. Atomic remote comment deduplication remains a production requirement even though normal overlapping work is excluded.

Turning off live mode or omitting the GitHub adapter blocks saved live runs as well as new ones; restore the original configuration to resume. A valid JSON file containing `null`, an array, or a scalar is not valid staff configuration and should be corrected using the explicit `invalid_config` diagnostic, not treated as a network error.

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
| Native evidence unavailable/incomplete | Verify native App surfaces and trusted integration. If absent, native `live` is blocked; canvas clicks cannot repair it. Do not convert the run to a pilot. |
| Assigned head changed | Stop that run. Record staff diagnostics, preserve it, and provision a fresh issue/PR/run. |
| Approval unauthorized or own PR | Check author/reviewer identity and permissions. Do not retry under a more privileged account without a fresh reviewed assignment. |
| Approval verified, merge pending | Wait for a separately authorized merge, then retry `serve`. Approval alone is not successful serving. |
| Menu served, completion fails in native `live` | Preserve the run. Restore the service, then invoke `complete` on the same panel/run. Do not reset, regenerate the handle, or manually post another result. |
| Pilot `complete` reports `pilot_not_ranked` | Expected boundary, not a service outage. Keep `pilot-served` and its menu/summary; do not submit it to the authority or relabel it as completed. |
| Timeout after remote acceptance | Query/reconcile the completion service by the same `runId`. Retry idempotently; confirm the existing result/comment is reused. |
| Handle phrase conflict or invalid receipt | Preserve the run/candidate and inspect the server reservation. Legitimate global collisions use the authority's deterministic suffix automatically; an unknown/different phrase must not be accepted. Retry the same candidate/run after diagnosis, without manually renaming or duplicating results. |
| Panel connection lost | Reopen the same run with a new panel instance if needed, then `refresh`. Do not share loopback URLs or tickets. |
| Unexpected provider error | Inspect the extension's host-reported log. Keep stack traces and identities out of attendee screens and public reports. |

`refresh` reads saved progress; it does not recheck GitHub or manufacture review events. Use the appropriate gated action after the underlying problem is resolved. Avoid concurrent recovery operations from multiple panels.

## Lock and storage recovery

The store uses `ledger.json` and `ledger.lock`, with atomic fsynced ledger writes. Slow I/O or a client engine live operation can legitimately hold the lock. The completion authority releases the global lock before remote calls and uses separate per-run ownership claims with heartbeats; do not erase those claims to bypass an active worker or change a reserved assignment.

1. Stop intake and note the affected run IDs. Inspect the exact provider log and lock metadata. Determine the actual data directory from the host environment; do not guess.
2. Verify the recorded lock-owner PID with `ps -p <pid> -o pid,ppid,lstart,command`. Compare the process identity/start time, not just PID existence; PIDs can be reused.
3. If the owner/provider is active, **do not remove the lock**. Allow the operation to finish or shut down the specific extension/provider through the host. Check for other active providers sharing the directory.
4. Only after confirming no active provider/writer owns or uses this store, make a backup of the ledger and lock in an approved staff-only recovery location. Keep backups out of Git and public attachments.
5. If the lock is proven stale, remove only that exact `ledger.lock`. Do not use wildcard deletion, erase the ledger, or kill processes by name.
6. Restart/reload one provider, inspect its health, reopen the same run, and verify the ledger and completed results. For provisioning, rerun the exact original initializer command so it reconciles the existing issue/create intent; do not create a replacement assignment. Reconcile any uncertain remote completion before retrying.

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

Before ranked native-live opening: validate host/extension health, accounts and assignments, genuine native evidence, service health, public QR reachability, and a complete authorized native-live trial. The unranked canvas pilot follows its separate staff procedure and makes no event-readiness claim. After an incident, repeat the affected gate before resuming intake.

Keep staff-only daily observations of completion time, intervention, actual changed-files/checks views, final-result latency, reset success, and retry/duplicate outcomes. The preserved outline's targets are:

- At least 85% complete without staff intervention.
- Median completion within five minutes.
- At least 90% open changed files and checks before approval.
- At least 95% of completed runs get the issue update and leaderboard result within five seconds.
- Consistent reset between attendees.

These are historical proposed event acceptance targets, not results already achieved. The unranked canvas pilot has no event issue update or leaderboard result and must not be counted as meeting those completion targets. Pilot measurements and daily capture tooling are unresolved. Do not invent evidence.

End of day: reconcile pending completions, preserve approved backups, close panels, and stop intake. Event-data retention period, deletion schedule, responsible owner, and access policy still need approval; do not invent a duration or delete records while retries remain unresolved. Publish only approved anonymous outputs.
