---
name: order-up
description: Guide an attendee through the Commit & Sip canvas order, pull-request review, factual checkpoint, explicit approval, and separately verified serving. Use for Order Up or Commit & Sip booth sessions; preserve rehearsal/live boundaries.
---

# Order Up facilitation

Keep the attendee in the Copilot App. Do not ask them to use a terminal, GitHub.com, or an external editor. Staff handle configuration, permissions, provisioning, and recovery using [the runbook](../../../booth/RUNBOOK.md).

## One learner step

Guide **Step 1: Review and serve your order** using the [canonical learner content](../../steps/1-review-and-serve.md), also available through **Read the step guide** inside the rehearsal canvas. Read, inspect, check, approve, and serve are activities within this step, not separate lessons. There is no Step 2. Staff initialization is not a learner task.

The canvas owns progression; Actions only validate the repository. Do not wait for Actions to advance rehearsal, create real issues for rehearsal, or close issues automatically. Rehearsal stays in the canvas. The explicitly unranked `live-canvas-pilot` uses real GitHub data in canvas views, not native events. Future native `live` may use authentic PR panels elsewhere inside the App, subject to unchanged trusted-evidence gates.

## Open the assigned run

1. Discover the loaded canvas capabilities for `commit-and-sip`; do not invent host APIs or provider IDs.
2. Use the supplied staff assignment. If there is no authorized GitHub-connected assignment, offer only explicitly labeled rehearsal. A pilot requires staff-configured `mode: "live-canvas-pilot"` and durably pinned `reviewSource: "canvas-pilot"`; omitted source remains native `live`. Do not change config or convert a run to bypass unavailable native evidence.
3. If no run is assigned, open with omitted input or `{}` to show setup. Let the user explicitly choose **Create new rehearsal** or **Resume saved rehearsal**. Do not auto-submit a new run as a recovery shortcut. For a direct assigned open, pass `runId`, explicit `mode`, and the assigned `orderId`. Example rehearsal:

   ```json
   {"runId":"rehearsal-demo-001","mode":"rehearsal","orderId":"mona-latte"}
   ```

4. Choose a panel `instanceId` and reuse it for actions. It is not the persistent `runId`. Reopen the same run to recover; do not silently create another attendee/result.
5. Setup can also be driven with `select_run({operation:"new",runId,mode:"rehearsal",orderId})` or `select_run({operation:"resume",runId,mode:"rehearsal"})` after the user's explicit selection. Resume does not accept an order override or create a missing run. `refresh` can inspect an unassigned setup panel; review actions remain blocked until selection.
6. After provider/App restart, an empty-input panel returns to setup; resume using the original run ID. Complete assignment inputs rehydrate directly. Never derive persistent identity from a panel ID, guess which saved attendee run to use, or change a live run into rehearsal.

For an authorized pilot, staff separately provision with `--review-source canvas-pilot`, enable the matching mode in ignored config, and reload; provisioning itself never switches mode. Then directly open `{"runId":"ASSIGNED_RUN_ID","mode":"live-canvas-pilot","orderId":"mona-latte"}` using the actual assigned order. Setup/`select_run` stay rehearsal-only; there is no pilot-creation control in the renderer. These are instructions for future authorized staff work, not permission to provision, approve, merge, or change configuration as part of this implementation milestone.

Rehearsal uses local fixtures and persistent local results. It performs no real GitHub review, approval, merge, issue update, network submission, or live leaderboard entry. State this plainly; never claim the simulation is Copilot-generated feedback.

## Guide, do not complete the review for the learner

- `start({})`: show the assigned issue/order.
- Ask the learner to inspect the summary, changed files, and checks. Rehearsal and the pilot use `view({"surface":"summary"})`, then `changes`, then `checks`. Pilot actions recheck the real GitHub assignment/head/base/menu/checks before recording exact-assignment/head canvas observations; never call them native events.
- Native `live` must use authentic App surfaces and trusted server-side view evidence. After those views are opened, use `sync_review({})` / **Refresh verified review** to read the trusted provider and current GitHub checks; never send a surfaces/evidence payload. Normal `refresh({})` only reads saved state. Partial progress does not unlock approval; failed verification clears progress. Canvas clicks cannot certify native views. If the integration is unavailable, explain the blocker and hand off to staff; do not fabricate evidence or convert to pilot.
- Point to authentic captures only after they exist. See [the image checklist](../../images/README.md). Do not describe planned images as already supplied. Browser fixtures use mocked transport, not actual GitHub execution or native App screenshots.
- Ask the learner to compare name, price, serving style, artwork, description, and one-drink scope with the actual diff.
- Offer `hint({})` freely. Hints, speed, retries, and accessibility assistance never lower the score.
- Submit `check_order` using the learner's answers, not automatically filled “correct” answers. Mona Latte expects `{"price":5.5,"serving":"hot","scope":"one-drink"}`; other drinks use their own order values.
- For a mismatch, use the returned field-specific feedback and **Return to Changes to compare your answer** link. Give one correction at a time. Do not approve incorrect or unverified work.

## Approval and serving are separate

Ask for an explicit human approval decision after inspecting the actual menu/checks and passing the factual checkpoint with the learner's answers. Only then invoke `approve({})`. Both GitHub-connected modes retain the designated-reviewer/author guards and the durably saved exact SHA-bound approval-attempt marker.

Approval is not merge. Never automatically merge live work or infer successful serving from approval. A separate authorized operator/workflow merges the assigned PR; `serve({})` verifies the actual merge and resulting menu. In rehearsal it applies only a simulated menu.

Do not bypass wrong-reviewer, own-PR, stale-head, failed-check, unavailable-view-evidence, or pending-merge errors. A changed head requires a fresh staff assignment.

## Unranked pilot serving and recovery

Pilot `serve({})` independently verifies the pinned head/base/menu/checks, merge SHA, and exact effective approval attempt after a separate authorized merge. The current assigned base tip must contain that merge and the exact inspected menu; movement during verification is rejected. It ends at **`pilot-served`** with the menu, merge revision, and learning summary. It never enters `completed` or emits a completed event. It has no handle, score, rank, QR, judge, event submission, or completion comment. `complete({})` returns `pilot_not_ranked`; no `CompletionAuthority` call occurs, and the authority rejects pilot assignments.

Actual verification errors durably clear current views/checkpoint/copied review data, not the saved exact decision/attempt or lifecycle. The private pilot decision retains actual submitted answers and source/assignment binding, not synthetic native timestamps. While reviewing, restore access and ask the learner to reinspect/reanswer. If already approved, preserve that decision and verify a later separate merge with `serve` without re-approving. Mode/source/assignment changes block all operations, including refresh; configuration/source/mode mismatches leave the ledger unchanged, and old unbound state fails closed. Preserve the same run and ask staff for recovery, not conversion or invented evidence.

Call the outcome **pilot served**, not Skills/event completion. Close with the learning summary below without promising a result, comment, or next step. Permissions, authentic screenshots, branding/privacy decisions, and trusted native hosting remain unresolved; this pilot is not a production release.

## Scored-mode completion and recovery

Serving initiates completion only in rehearsal and native `live`. The handle is generated only after the menu succeeds and is saved before a remote submission. Correct rehearsal and accepted native-live completions score **1,000**, and equal scores share rank. Native-live scores/ranks are authoritative only when independently accepted by the trusted service; the pilot is excluded.

If finalization fails, preserve the same run and handle candidate/reservation; ask staff to restore service and invoke `complete({})`. The authority may resolve a global collision by adding a deterministic eight-hex suffix to the same curated phrase; the client persists that canonical handle only from a verified authenticated receipt. This is not permission to invent or manually change a handle. Use `refresh({})` to read saved state, not to invent new evidence. Do not duplicate results/comments, regenerate phrases, or reset a served run to conceal a failure.

In native `live`, point to **Your app result** and **House menu** after verified serving. **Served — event result pending** means the app menu is saved but no score, final issue update, or Skills completion is confirmed. Use the live step guide in the canvas; do not label this pending state complete. Return to the assigned exercise issue only when the final update is confirmed. It should contain the accepted handle, score/rank, approved leaderboard link, and real issue-renderable QR. No public destination is currently deployed; do not invent a URL or display a placeholder as a production QR.

Copilot commentary is unavailable unless a real attributed, moderated, trusted judge is configured. Never impersonate a judge or invent model output.

After scored-mode serving and finalization succeed, point to the **Step 1 complete** learning summary in the canvas; after pilot serving, point only to its unranked learning summary. Close with: **“Inspect, check, approve: you compared the proposed change with the order before making a human review decision.”** There is no next learner step to unlock.

## Boundaries

- Do not reveal credentials, staff account identifiers, raw logs, or private attendee/run mappings.
- Do not reset live GitHub state. A new rehearsal uses the staff reset command and a new domain run ID; a new live attendee needs a new issue/PR/run.
- The historical [approved outline](../../../docs/exercise-outline.md) is preserved verbatim. Follow the current [integration contract](../../../docs/integration-contract.md) where that outline's proposals need implementation clarification.
