# Order Up: learner guide

You are the guest barista at the Level Up Lounge. Invent one drink name in about five minutes; you do not need to write code, sign in to GitHub, or leave the Copilot App.

## Start the one-step exercise

The booth canvas opens idle at the counter. Choose **Start my order**. The station mints your barista handle, which is how your entry is identified on the house menu and the leaderboard. Complete instructions are in [Step 1: Name a drink for the house menu](../.github/steps/1-name-a-drink.md).

Every drink must carry **mona**, **ducky**, or **copilot**, anywhere in the name; the mascot does not have to come first. The mascot and placement pickers are optional, and placement earns no points, so put the mascot where you like. A bare mascot on its own is rejected, so add something of your own.

Type your name and choose **Add it to the menu**. The menu is first come, first served, so if a name is already taken the station says so and you try another. Mona Latte, Copilot Cortado, and Ducky Cold Brew are worked examples; they are never scored and never reach the leaderboard.

A deterministic local rubric scores the name out of 5,000 and shows the breakdown. The same name always earns the same score, and no model writes your feedback. Most invented names land well short of the maximum, so a mid-range score is a normal result.

Your drink then joins the house menu and the leaderboard, and equal scores share a rank. When a leaderboard destination is configured the canvas shows a scannable code and link; no public destination is currently deployed, and nothing is invented to fill that space. Finally, choose **I'm done - hand over to the next barista** to clear the counter. Your drink and your entry stay.

## Resume and recovery

If the screen loses its connection, choose **Refresh connection**. The station reads its saved state rather than inventing a new one, so reconnecting does not cost you your handle, your drink, or your score.

Staff handle setup, connection problems, and fresh runs between attendees using the [booth runbook](../booth/RUNBOOK.md). You never need a terminal, GitHub.com, or an external editor.

## Staff-only pull-request modes

The sections below describe the original pull-request review flow, retained behind explicit staff modes. It is not the booth experience and uses [its own step guide](../.github/steps/1-review-and-serve.md). Booth attendees can stop reading here.

### An assigned unranked canvas pilot

Only staff can prepare and directly open a **`live-canvas-pilot`** assignment. You cannot create or select it from rehearsal setup. Unlike rehearsal, this mode reads a real GitHub issue and PR and can record a real approval; unlike native live mode, it records canvas observations, not native App review events.

Read the assigned order and inspect **Summary → Changes → Checks** in the canvas. Compare the actual menu change with all order criteria and answer the checkpoint yourself. Inspect the checks and menu before explicitly choosing approval; approval is a real human decision, not a merge.

Wait for a separately authorized operator to merge, then verify serving in the canvas. Successful verification shows the menu, merge revision, and learning summary at **`pilot-served`**. This is not Skills/event completion: there is no handle, score, rank, QR, judge, event submission, or completion comment. Do not choose a new rehearsal or ask for event finalization to convert it.

If verification fails, saved view/checkpoint/review progress is cleared. Stay on the same assignment and ask staff for recovery. An already-approved run can verify a later authorized merge without another approval.

### Native live remains gated

Ranked native `live` use is not ready. Its canvas has a live step guide, assigned issue/PR references, **Refresh verified review**, and **Your app result**. The last panel distinguishes approval, actual serving, and event-result recording, so a served menu can remain visible while finalization is pending. Future native live review may open authentic PR views elsewhere inside the App, but canvas observations cannot replace trusted native evidence. Approval is not a merge; serving requires a separately authorized, verified merge. The unranked pilot does not remove the missing native integration or event-service requirements.
