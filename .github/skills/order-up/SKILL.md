---
name: order-up
description: Guide an attendee through the Commit & Sip canvas order, pull-request review, factual checkpoint, explicit approval, and separately verified serving. Use for Order Up or Commit & Sip booth sessions; preserve rehearsal/live boundaries.
---

# Order Up facilitation

Keep the attendee in the Copilot App. Do not ask them to use a terminal, GitHub.com, or an external editor. Staff handle configuration, permissions, provisioning, and recovery using [the runbook](../../../booth/RUNBOOK.md).

## One learner step

Guide **Step 1: Review and serve your order** using the [canonical learner content](../../steps/1-review-and-serve.md), also available through **Read the step guide** inside the rehearsal canvas. Read, inspect, check, approve, and serve are activities within this step, not separate lessons. There is no Step 2. Staff initialization is not a learner task.

The canvas owns progression; Actions only validate the repository. Do not wait for Actions to advance rehearsal, create real issues for rehearsal, or close issues automatically. Rehearsal stays in the canvas. Future live mode may use authentic native PR panels elsewhere inside the App, subject to the existing trusted-evidence gates.

## Open the assigned run

1. Discover the loaded canvas capabilities for `commit-and-sip`; do not invent host APIs or provider IDs.
2. Use the supplied staff assignment. If there is no live assignment, offer only explicitly labeled rehearsal.
3. If no run is assigned, open with omitted input or `{}` to show setup. Let the user explicitly choose **Create new rehearsal** or **Resume saved rehearsal**. Do not auto-submit a new run as a recovery shortcut. For a direct assigned open, pass `runId`, explicit `mode`, and the assigned `orderId`. Example rehearsal:

   ```json
   {"runId":"rehearsal-demo-001","mode":"rehearsal","orderId":"mona-latte"}
   ```

4. Choose a panel `instanceId` and reuse it for actions. It is not the persistent `runId`. Reopen the same run to recover; do not silently create another attendee/result.
5. Setup can also be driven with `select_run({operation:"new",runId,mode:"rehearsal",orderId})` or `select_run({operation:"resume",runId,mode:"rehearsal"})` after the user's explicit selection. Resume does not accept an order override or create a missing run. `refresh` can inspect an unassigned setup panel; review actions remain blocked until selection.
6. After provider/App restart, an empty-input panel returns to setup; resume using the original run ID. Complete assignment inputs rehydrate directly. Never derive persistent identity from a panel ID, guess which saved attendee run to use, or change a live run into rehearsal.

Rehearsal uses local fixtures and persistent local results. It performs no real GitHub review, approval, merge, issue update, network submission, or live leaderboard entry. State this plainly; never claim the simulation is Copilot-generated feedback.

## Guide, do not complete the review for the learner

- `start({})`: show the assigned issue/order.
- Ask the learner to inspect the summary, changed files, and checks. Rehearsal uses `view({"surface":"summary"})`, then `changes`, then `checks`.
- Live mode must use authentic native App surfaces and trusted server-side view evidence. Canvas clicks cannot certify live views. If the integration is unavailable, explain the blocker and hand off to staff; do not fabricate evidence.
- Point to authentic captures only after they exist. See [the image checklist](../../images/README.md). Do not describe planned images as already supplied.
- Ask the learner to compare name, price, serving style, artwork, description, and one-drink scope with the actual diff.
- Offer `hint({})` freely. Hints, speed, retries, and accessibility assistance never lower the score.
- Submit `check_order` using the learner's answers, not automatically filled “correct” answers. Mona Latte expects `{"price":5.5,"serving":"hot","scope":"one-drink"}`; other drinks use their own order values.
- For a mismatch, use the returned field-specific feedback and **Return to Changes to compare your answer** link. Give one correction at a time. Do not approve incorrect or unverified work.

## Approval and serving are separate

Ask for an explicit human approval decision after the review and factual checkpoint. Only then invoke `approve({})`.

Approval is not merge. Never automatically merge live work or infer successful serving from approval. A separate authorized operator/workflow merges the assigned PR; `serve({})` verifies the actual merge and resulting menu. In rehearsal it applies only a simulated menu.

Do not bypass wrong-reviewer, own-PR, stale-head, failed-check, unavailable-view-evidence, or pending-merge errors. A changed head requires a fresh staff assignment.

## Completion and recovery

Serving initiates completion. The handle is generated only after the menu succeeds and is saved before a remote submission. Correct completions score **1,000**, and equal scores share rank. Live scores/ranks are authoritative only when independently accepted by the trusted service.

If finalization fails, preserve the same run and handle candidate/reservation; ask staff to restore service and invoke `complete({})`. The authority may resolve a global collision by adding a deterministic eight-hex suffix to the same curated phrase; the client persists that canonical handle only from a verified authenticated receipt. This is not permission to invent or manually change a handle. Use `refresh({})` to read saved state, not to invent new evidence. Do not duplicate results/comments, regenerate phrases, or reset a served run to conceal a failure.

In live mode, return to the assigned exercise issue only when the final update is confirmed. It should contain the accepted handle, score/rank, approved leaderboard link, and real issue-renderable QR. No public destination is currently deployed; do not invent a URL or display a placeholder as a production QR.

Copilot commentary is unavailable unless a real attributed, moderated, trusted judge is configured. Never impersonate a judge or invent model output.

After serving and finalization succeed, point to the **Step 1 complete** learning summary in the canvas. Close with: **“Inspect, check, approve: you compared the proposed change with the order before making a human review decision.”** There is no next learner step to unlock.

## Boundaries

- Do not reveal credentials, staff account identifiers, raw logs, or private attendee/run mappings.
- Do not reset live GitHub state. A new rehearsal uses the staff reset command and a new domain run ID; a new live attendee needs a new issue/PR/run.
- The historical [approved outline](../../../docs/exercise-outline.md) is preserved verbatim. Follow the current [integration contract](../../../docs/integration-contract.md) where that outline's proposals need implementation clarification.
