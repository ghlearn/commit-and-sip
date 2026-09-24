---
name: order-up
description: Guide a booth attendee through the Commit & Sip canvas naming competition, where they invent one coffee name, a local rubric scores it, and it joins the house menu. Use for Order Up or Commit & Sip booth sessions; never present rubric output as model commentary.
---

# Order Up facilitation

Keep the attendee on the booth canvas. Do not ask them to use a terminal, GitHub.com, an external editor, or a GitHub account. Staff handle configuration and recovery using [the runbook](../../../booth/RUNBOOK.md).

The booth canvas is the only canvas an attendee touches. It runs the naming competition end to end with no pull request and no GitHub platform interaction at all. The older pull-request review flow was removed from this repository, so there is no other mode to switch into; if someone asks for one, say it no longer exists rather than improvising.

There is a separate staff canvas, `commit-and-sip-admin`, for exporting results, closing a station, taking a drink down, and ending an event. It is not part of facilitation and must not be opened in front of a queue: it shows removal reasons and staff names and can erase the event. Leave it to staff and the [runbook](../../../booth/RUNBOOK.md#staff-dashboard).

## One learner step

Guide **Step 1: Name a drink for the house menu** using the [canonical learner content](../../steps/1-name-a-drink.md). Starting, naming, scoring, and handing over are activities within this step, not separate lessons. There is no Step 2. Staff setup is not a learner task.

The canvas owns progression. Actions only validate the repository; never wait on Actions to advance an attendee.

## Open the station

1. Discover the loaded canvas capabilities for `commit-and-sip`; do not invent host APIs or provider IDs.
2. Open with omitted input or `{}`. The booth canvas takes no open input: it has no run ID, order ID, or mode to pass, and supplying one is an error rather than a shortcut.
3. Choose a panel `instanceId` and reuse it for actions. One panel is one physical station, reused by attendee after attendee. It is not an attendee identity.
4. A reopened panel reads saved state. After a provider or App restart the station returns to idle; the previous attendee's drink and leaderboard entry survive, because durable facts live in the run store rather than the panel.

## Run one attendee

- `begin({})`: mints the barista handle and starts the order. One station holds one order at a time, so this is refused while an order is open. Finish or hand over first.
- Let the attendee read **How it works** themselves. The three house drinks are worked examples; say plainly that they are not scored and never reach the leaderboard.
- `submit_name({name})`: adds and scores the drink. `mascot` and `placement` are optional. Send them only when the attendee actually chose them, because they are checked as a claim against the typed name and a disagreement is reported back rather than corrected.
- Let the attendee type their own name. Do not invent one for them, do not autocorrect their spelling into something that scores better, and do not retry a rejected name on their behalf without telling them what was wrong.
- `complete({})`: clears the station for the next attendee. `refresh({})` reads saved state; it is not a way to manufacture a new result.

## Explain the rules honestly

Every drink must carry `mona`, `ducky`, or `copilot`, anywhere in the name. A bare mascot alone is rejected, because otherwise the first attendee would permanently claim a name nobody invented. Placement is the attendee's free choice and earns no points, so never imply one position scores better.

The menu is first come, first served after normalizing case, spacing, and punctuation. A duplicate is reported as already on the menu; treat that as a normal outcome, not an attendee error.

The 1-to-5,000 score comes from a deterministic local rubric. The same name always earns the same score. No model writes the feedback and no model assigns the score. Never present the rubric breakdown as Copilot commentary, and never impersonate a judge. Copilot commentary is unavailable unless a real attributed, moderated, trusted judge is configured.

Most invented names land well short of 5,000. Say so before the score appears, so a mid-range result reads as normal rather than as failure.

## Finish and hand over

The drink joins the house menu and the leaderboard for the rest of the event, and equal scores share a rank. Completion releases only the station; the entry stays.

No public leaderboard destination is currently deployed. When one is configured, the canvas renders a real scannable code from that verified destination. When it is not, no code is shown. Do not invent a URL, describe a placeholder as a production code, or tell an attendee to scan something that resolves to nothing.

Confirm the counter is clear and showing the thank-you message before inviting the next attendee.

## Boundaries

- Do not reveal credentials, staff account identifiers, raw logs, or private attendee mappings.
- Do not edit the house menu, the leaderboard, or a recorded score by hand to flatter or rescue an attendee.
- The historical [approved outline](../../../docs/exercise-outline.md) is preserved verbatim. Follow the current [integration contract](../../../docs/integration-contract.md) where that outline needs implementation clarification.
