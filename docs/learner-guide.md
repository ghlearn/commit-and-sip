# Order Up: learner guide

You are the guest barista at the Level Up Lounge. Your job is to review a proposed menu addition, not write code. You stay in the Copilot App; setup, terminal commands, account management, and recovery belong to booth staff.

Allow about five minutes. Take longer or use **Show me / Hint** whenever helpful: neither time nor hints affects your score.

## 1. Read the order

Open the assigned exercise issue and read its drink name, price, serving style, artwork, description, and scope. Follow its prepared pull-request reference in the App.

For the Mona Latte rehearsal:

| Criterion | Expected |
| --- | --- |
| Name | Mona Latte |
| Price | $5.50 |
| Serving | Hot |
| Artwork identifier | `original-latte-cup` |
| Description | An octo-cat classic with espresso and steamed milk. |
| Scope | One new drink; no unrelated edits |

Other orders have different prices and serving styles. Always use the assigned issue, not memorized answers.

## 2. Inspect the proposal

Use the **Summary**, **Changes**, and **Checks** surfaces in that order.

- **Summary:** What does this pull request claim to do?
- **Changes:** Does the actual added item match every criterion? Are existing items unchanged?
- **Checks:** Did the required validation finish successfully for this change?

In rehearsal these are clearly labeled simulated surfaces. In live play they must be authentic native App pull-request views. Clicking a local canvas button is not proof that a live review happened. Authentic screenshot guidance is awaiting capture; staff must not substitute fabricated App screenshots.

## 3. Check the order

Answer the price, serving-style, and change-scope checkpoint from the diff. This is an additional factual check, not a substitute for inspecting the entire item.

If a value is wrong, return to the changes and try again. A green check alone is not a reason to approve. If the pull request itself is incorrect or the view cannot be loaded, ask staff for help rather than approving it.

## 4. Approve, then serve

Choose **Approve** only when you are satisfied that the proposal matches the order.

**Approval records a review decision. It is not a merge.** In live play an authorized operator or separately approved workflow must merge the correct pull request. **Serve** verifies that merge and the resulting menu; it cannot bypass a pending or failed merge.

In rehearsal, serving applies only the simulated local menu.

## 5. Read the result

After the menu update succeeds, a generated barista handle is saved. Correct completion earns **1,000 points**; equal scores share the same rank. Rehearsal results stay local and are not part of the live competition.

A live completion should return you to the exercise issue for one final update containing your handle, accepted score/rank, and approved leaderboard link and QR. Those live services are not yet production-ready. Optional Copilot commentary is unavailable unless a real, attributed, moderated judge has been configured; ordinary application status text is not Copilot feedback.

If the result is delayed, keep the same run open and ask staff to retry completion. Do not start a new run to recover a result. Your saved handle and served state should be preserved.

**What you learned: Inspect → Check → Approve.** Human review remains necessary even when Copilot prepared the change and automated checks pass.
