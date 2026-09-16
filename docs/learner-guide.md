# Order Up: learner guide

You are the guest barista at the Level Up Lounge. Review one proposed menu addition in about five minutes; you do not need to write code or leave the Copilot App.

## Start the one-step exercise

If the canvas opens to **Choose your order**, select **New rehearsal**, choose a drink, and create a run with a never-used ID. To continue saved work, choose **Resume saved rehearsal** and enter its original run ID. Keep the ID shown with your order; staff can help with assignments.

In your assigned rehearsal canvas, choose **Start rehearsal order**. Open **Read the step guide** for the complete instructions, rendered from [Step 1: Review and serve your order](../.github/steps/1-review-and-serve.md).

Read the order, inspect **Summary / Changes / Checks**, answer the factual checkpoint, explicitly approve, and then choose **Apply rehearsal menu**. These are activities in one learner step, not separate Skills lessons. Use your assigned drink's values; hints and retries are free.

Rehearsal is a local simulation, not a real GitHub review or event submission. Your local handle, score, and rank appear in the canvas after serving succeeds. There is no production leaderboard or QR code to open.

## Resume and recovery

**Refresh progress** reads your saved state. Reopen the same run to resume. In rehearsal or native live mode, if the menu was served but finalization failed, choose **Retry result**; do not start a new run to recover your result. The unranked pilot has no event result to retry.

Staff handle setup, connection problems, and fresh runs between attendees using the [booth runbook](../booth/RUNBOOK.md). You never need a terminal, GitHub.com, or an external editor.

## An assigned unranked canvas pilot

Only staff can prepare and directly open a **`live-canvas-pilot`** assignment. You cannot create or select it from rehearsal setup. Unlike rehearsal, this mode reads a real GitHub issue and PR and can record a real approval; unlike native live mode, it records canvas observations, not native App review events.

Read the assigned order and inspect **Summary → Changes → Checks** in the canvas. Compare the actual menu change with all order criteria and answer the checkpoint yourself. Inspect the checks and menu before explicitly choosing approval; approval is a real human decision, not a merge.

Wait for a separately authorized operator to merge, then verify serving in the canvas. Successful verification shows the menu, merge revision, and learning summary at **`pilot-served`**. This is not Skills/event completion: there is no handle, score, rank, QR, judge, event submission, or completion comment. Do not choose a new rehearsal or ask for event finalization to convert it.

If verification fails, saved view/checkpoint/review progress is cleared. Stay on the same assignment and ask staff for recovery. An already-approved run can verify a later authorized merge without another approval.

## Native live remains gated

Ranked native `live` use is not ready. Its canvas has a live step guide, assigned issue/PR references, **Refresh verified review**, and **Your app result**. The last panel distinguishes approval, actual serving, and event-result recording, so a served menu can remain visible while finalization is pending. Future native live review may open authentic PR views elsewhere inside the App, but canvas observations cannot replace trusted native evidence. Approval is not a merge; serving requires a separately authorized, verified merge. The unranked pilot does not remove the missing native integration or event-service requirements.
