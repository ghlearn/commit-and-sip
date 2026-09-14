# Order Up! Review and Serve a GitHub Cafe Special

## 1. Exercise summary

### Proposal

Create a five-minute, app-only mini game for the **Level Up Lounge** that teaches attendees how to inspect and approve a pull request prepared by GitHub Copilot. Approving the pull request adds a GitHub-themed drink to the cafe menu and submits the player's result to an anonymous leaderboard.

After the player approves the pull request, the completion automation generates a memorable, Codespaces-style barista handle, such as **sneaky-flying-pancake**, calculates the player's leaderboard rank, and updates the exercise issue with the handle, rank, and a QR code to the leaderboard. No attendee name or GitHub username is shown.

The cafe-themed game loop is:

1. **Open the order** in the exercise issue and receive a GitHub-themed drink to review.
2. **Follow the review guide** and screenshots to find the relevant pull-request details.
3. **Check the order** by reviewing the changed menu item and validation results.
4. **Serve it** by approving the pull request, which adds the drink to the menu.
5. **Read the final issue update** containing the generated barista handle, leaderboard rank, and leaderboard QR code.

Working title: **Order Up! Review and Serve a GitHub Cafe Special**

Target duration: **5 minutes**, including instruction and completion feedback.

### Recommended GitHub capability

Feature **pull-request review and approval of Copilot-generated work**. This creates an observable before-and-after artifact, fits the requested guided flow, and teaches three durable habits:

- inspect what changed before approving,
- compare the implementation with acceptance criteria,
- use automated checks as evidence without treating them as a substitute for review.

Each prepared pull request adds one drink to a structured menu file in a cafe application. The review is intentionally small and visually guided so beginners can complete it while still making a real approval decision.

### Experience principles

- **App only:** Attendees do not navigate to GitHub.com, a terminal, or an external editor during the game.
- **One visible outcome:** Approval adds a GitHub-themed drink to the Level Up Lounge menu.
- **Low typing:** The app provides screenshots and short instructions; the attendee navigates, inspects, and approves.
- **Real review behavior:** Success requires opening the pull-request changes and checks before approval.
- **Anonymous competition:** The final exercise-issue update and leaderboard display only generated handles and scores.
- **Fair scoring:** Deterministic events calculate rank; Copilot adds a playful judging summary or special award.
- **Repeatable:** Each booth account can be reset quickly and safely between attendees.

Official references: [About pull request reviews](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/about-pull-request-reviews) and [About GitHub Copilot coding agent](https://docs.github.com/en/copilot/concepts/coding-agent/coding-agent).

## 2. Target learner and prerequisites

### Target learner

- GitHub Universe attendee with beginner-to-intermediate GitHub familiarity.
- Curious about agentic development but not expected to know the repository, JSON, tests, or command-line tools.
- Comfortable reading a short prompt and a small visual diff.

### Prerequisites supplied by the booth

- A device with the GitHub Copilot App open.
- A pre-authenticated booth account with required Copilot and repository access.
- A preconfigured exercise repository and clean starting session.
- Coding-agent access enabled for the booth account and repository.
- Reliable network connectivity.

### Learner prerequisites

No setup, cloning, terminal use, or prior coding-agent experience.

## 3. Learning objectives

By the end of the exercise, the attendee can:

1. Navigate a pull request using visual guidance and identify what Copilot changed.
2. Compare the changed menu item with the order's acceptance criteria and inspect its checks.
3. Approve a correct pull request and observe the resulting menu update.

Out of scope: prompt-engineering theory, repository setup, writing tests, Git internals, resolving complex review feedback, and authoring a pull request.

## 4. Narrative or scenario

The attendee is the guest barista at the **Level Up Lounge**. Copilot has prepared a pull request for a new GitHub-themed drink, but a human must check the order before it can be served. The player follows visual review clues from the exercise issue, inspects the pull request, checks validation, and approves the drink. The approved item appears on the cafe menu. Automation then updates the exercise issue with the player's newly generated barista handle, leaderboard rank, and QR code to the live leaderboard.

Suggested order card:

> Review the pull request for **Mona Latte**. Confirm that it costs **$5.50**, is **hot**, uses the Mona artwork, and has the description "An octo-cat classic with espresso and steamed milk." Make sure the menu checks pass before approving it.

Example drinks should use approved GitHub characters and product references, such as **Mona Latte**, **Copilot Cortado**, and **Ducky Cold Brew**. Additional options might include **Merge Mocha** or **Actions Affogato**. Final names, artwork, and copy require brand and trademark review before production.

## 5. Step-by-step learner journey

| Step | Learner action | Why it matters | Expected artifact | Validation signal | Feedback |
| --- | --- | --- | --- | --- | --- |
| 1. Open the order | Read the assigned mascot drink order in the exercise issue. | Establishes a concrete review goal without setup. | Run ID, issue number, order ID, and start time. | Exercise detects a valid clean run and assigned pull request. | "Mona Latte is waiting for review." |
| 2. Follow the review guide | Use in-app screenshots to locate the pull-request summary, changed files, and checks. | Builds confidence navigating a pull request. | Required PR surfaces opened in sequence. | App records that each required surface was viewed. | Progress markers show **Order**, **Changes**, and **Checks**. |
| 3. Check the order | Compare the menu change with the order card and inspect validation. | Reinforces that generated work must be reviewed. | Review decision with no personal data. | Required fields match and checks pass; hints used are recorded. | Specific mismatch guidance is available when needed. |
| 4. Serve the special | Approve the pull request. | Makes the human approval decision explicit. | Approval and merged or applied menu change. | Approval occurs only after required review events and passing checks. | The new mascot drink animates onto the cafe menu. |
| 5. Receive the final issue update | Return to the exercise issue to see the generated barista handle, rank, Copilot judge card, and leaderboard QR code. | Rewards completion in the same guided surface. | Final issue comment and anonymous leaderboard record linked to the run ID. | One signed result is accepted and one completion comment is posted per run. | The issue shows the handle, score, rank, award, QR code, and accessible leaderboard link. |

### Step 1: Open the order

**Theory**

A focused pull-request review starts with clear acceptance criteria. The exercise issue provides the drink order and visual guidance in one place.

**Activity**

1. Open the exercise issue in the Copilot App.
2. Read the assigned mascot drink order and acceptance criteria.
3. Follow the issue link to the prepared pull request.

**Transition**

- **Actions Trigger:** Opening the prepared pull request records the run ID, exercise issue number, assigned order, and start event.
- **Grading-Check:** Confirm a valid clean run, valid order ID, expected pull request, and no prior completion for that issue run.

Recovery: If the session is not clean, replace it with a known clean exercise session while preserving the exercise issue and assigned order.

### Step 2: Follow the review guide

**Theory**

A pull request explains a proposed change. The summary, changed files, and checks provide different evidence a reviewer should inspect before approving.

**Activity**

1. Follow the first screenshot to find the pull-request summary.
2. Follow the second screenshot to open the changed menu file.
3. Follow the third screenshot to inspect the check result.

**Transition**

- **Actions Trigger:** Opening each required pull-request surface advances the in-app guide.
- **Grading-Check:** Confirm that the player opened the summary, changed files, and checks for the assigned pull request; do not grade from elapsed time alone.

Recovery: Keep a persistent **Show me** control that reopens the relevant screenshot and highlights the target without penalizing accessibility-related use.

### Step 3: Check the order

**Theory**

Generated work is a proposal. The human remains responsible for checking intent, scope, and evidence that the change works.

**Activity**

1. Compare the drink name, price, serving style, mascot asset, and description with the order card.
2. Confirm that only the intended menu item changed.
3. Decide whether the pull request is ready to approve.

**Transition**

- **Actions Trigger:** Completing the review checklist enables the approval decision.
- **Grading-Check:** Parse the menu data and verify exact order values, valid schema, unique ID, preserved ordering, no unrelated menu edits, allowlisted file changes, and passing tests.

Recovery: Return one actionable message, such as "The price should be 5.50, but the menu shows 5.00," paired with a route back to the relevant diff.

### Step 4: Serve the special

**Theory**

Copilot can prepare work and automated checks can provide evidence, but a human reviewer makes the approval decision.

**Activity**

1. Select **Approve pull request** after the diff and checks are correct.
2. Watch the approved drink appear on the Level Up Lounge menu.

**Transition**

- **Actions Trigger:** Approval merges or applies the prepared change and refreshes the menu preview.
- **Grading-Check:** Require the correct pull request, passing deterministic checks, required review events, and a successful menu update before recording completion.

Recovery: Disable approval until required review surfaces are visited. If merge or apply fails, preserve the completed review and allow a staff-assisted retry.

### Step 5: Receive the final exercise-issue update

**Theory**

GitHub Skills exercises can use issue comments to confirm completion and provide next steps. Keeping the game result in the exercise issue gives the player one reliable place to find it.

**Activity**

1. Return to the exercise issue after approval.
2. Read the generated barista handle, score, current leaderboard rank, and Copilot judge card.
3. Scan the QR code on a personal device, or use the descriptive link, to view the live leaderboard.

**Transition**

- **Actions Trigger:** A successful menu update invokes the completion workflow. It generates a unique curated handle, submits a signed score, retrieves the current rank, renders the leaderboard QR code, and posts or updates one final issue comment.
- **Grading-Check:** Verify one result and one completion comment per run ID, recompute the deterministic score server-side, confirm the displayed rank matches the accepted result, and confirm the QR code and fallback link use the approved HTTPS leaderboard URL.

The final issue comment should contain:

- **Barista handle:** `sneaky-flying-pancake`
- **Score and current rank:** for example, `920 points - #7 on the leaderboard`
- **Copilot judge card:** short moderated feedback or a named award
- **Leaderboard QR code:** an image with descriptive alt text
- **Accessible fallback:** a descriptive link and short URL

Recovery: If issue updating or leaderboard submission fails, retry idempotently without duplicating comments or results. Preserve exercise completion and provide a staff recovery action.

## 6. Validation and feedback plan

Use a fast deterministic checker as the primary grading mechanism. GitHub Actions may mirror it for maintainers, but attendee success must not depend on workflow queue time.

The checker should verify:

- selected drink name, price, serving style, mascot asset, and description match the order payload,
- required fields and types conform to the menu schema,
- the item ID is unique,
- existing menu items and ordering are preserved,
- only allowlisted files changed,
- the targeted menu test passes.

### Leaderboard scoring

Rank players using deterministic, server-verifiable signals such as review correctness, required review surfaces visited, successful first approval decision, and optional hints used. If completion speed is included, cap its contribution so accessibility needs and network latency do not dominate ranking.

Copilot may judge each submission to produce a short cafe-themed review and award, such as **Sharpest Reviewer** or **Mona's Menu Detective**. Copilot output should not determine primary rank unless a tested rubric, model/version pinning, moderation, tie handling, and reset policy are approved. Store rubric output and model metadata for event diagnostics, not attendee identity.

Leaderboard records should contain only the run ID, exercise issue number, generated handle, score, placement inputs, selected award, and timestamp. Do not publish GitHub usernames, booth account identifiers, prompts, or free-form attendee text.

### Feedback guidelines

- Keep progress messages playful but status labels literal: **Reviewing**, **Check passed**, **Needs attention**.
- Report one specific mismatch at a time and provide a direct route back to the relevant pull-request surface.
- Do not expose raw stack traces to attendees; retain diagnostic details for booth staff.
- The completion screen should name the learned behavior: **Inspect - Check - Approve**.
- Post a large QR code in the final exercise-issue comment linking to the read-only live leaderboard, plus a descriptive link and short URL as accessible fallbacks.

### Success metrics

- At least 85% of attendees complete without staff intervention.
- Median completion remains within five minutes.
- At least 90% open both the changed files and checks before approval.
- At least 95% of completed runs receive the final issue update and appear on the leaderboard within five seconds.
- Reset succeeds consistently between runs.

## 7. Repository structure

```text
.
|-- README.md
|-- src/data/specials.json
|-- scripts/grade-order.mjs
|-- scripts/reset-exercise.mjs
|-- scripts/generate-handle.mjs
|-- tests/specials.test.*
|-- tests/scoring.test.*
|-- .github/skills/order-up/SKILL.md
|-- .github/images/level-up-lounge-order.webp
|-- .github/images/review-summary.webp
|-- .github/images/review-changes.webp
|-- .github/images/review-checks.webp
|-- .github/images/order-up-success.webp
|-- .github/workflows/exercise-validation.yml
|-- .github/workflows/post-completion.yml
`-- booth/
    |-- orders.json
    |-- handle-words.json
    |-- scoring-rubric.json
    |-- leaderboard-config.json
    `-- RUNBOOK.md
```

Implementation notes:

- Use a tiny static application or data fixture with no dependency installation during the attendee flow.
- Preinstall dependencies and warm each device before booth opening.
- Keep order definitions machine-readable so the order card, grader, and success message share one source of truth.
- Generate the barista handle only after successful approval, using moderation-reviewed word lists; enforce event uniqueness and never derive it from attendee identity.
- Host the leaderboard as a read-only, mobile-friendly HTTPS page; sign submissions and recompute scores server-side.
- Use accessible contrast, non-color status indicators, large touch targets, alt text, and keyboard-operable controls.
- Store exercise images in `.github/images` and reference them relatively.

## 8. Delivery plan and todos

1. **Confirm app integration contract:** Identify how the booth build launches the game, opens a prepared pull request, detects required PR surfaces, records approval, and displays the menu result.
2. **Prototype the cafe repository:** Build mascot-themed menu fixtures, prepared pull requests, order payloads, tests, and deterministic grading.
3. **Build completion and leaderboard services:** After successful approval, generate a curated barista handle, calculate rank server-side, submit the signed result, create the QR code, and update the exercise issue with an idempotent completion comment.
4. **Author the app skill:** Implement the issue-led order, screenshot-guided PR navigation, review checklist, approval flow, menu reveal, and return to the final exercise-issue update.
5. **Add Copilot judging:** Define and test a narrow rubric for playful feedback or awards while keeping primary rank deterministic.
6. **Build reset and operations:** Add clean-session reset, PR replenishment, device warm-up, leaderboard health checks, telemetry boundaries, and a staff runbook.
7. **Pilot and harden:** Run repeated five-minute trials, test QR scanning and handle readability, measure completion and intervention rates, and simplify delays.

## 9. Risks, edge cases, and open questions

| Risk | Mitigation |
| --- | --- |
| Pull-request or app latency exceeds the time box | Pre-create pull requests, prewarm devices, use a tiny repository, and provide a staff reset path. |
| Booth state leaks between attendees | Use isolated runs with deterministic reset and unique ephemeral session identifiers. |
| Shared menu branch creates merge conflicts | Apply approved items through an event service or replenish isolated pull requests rather than merging every run into one branch. |
| Attendee approves without reviewing | Require the changed-files and checks views before approval. |
| Generated handle is inappropriate or duplicated | Use curated words, test combinations, reserve handles atomically, and add a short suffix on collision. |
| Copilot scoring is inconsistent | Keep primary rank deterministic; use Copilot for commentary or named awards unless a calibrated rubric is approved. |
| QR code in the issue is difficult to scan | Use a high-contrast, sufficiently large image with quiet zone, descriptive alt text, a direct link, and a visible short URL fallback. |
| Leaderboard or issue update is abused or exposes identity | Accept signed run results only, make completion comments idempotent, rate-limit writes, publish generated handles only, and expire event data on schedule. |
| Network or service disruption | Show an unavailable state, support device rotation, and clearly label any staff demo mode. |
| Theme obscures the learning | Pair cafe copy with literal GitHub terms such as pull request, changed files, checks, and approval. |

Open questions before implementation:

1. What API will the booth build expose for opening prepared pull requests, detecting PR views, recording approval, and refreshing the menu?
2. Does approval automatically merge the pull request, or does an event service apply the approved menu item to avoid shared-branch conflicts?
3. Should every pull request be correct, or should some contain a safe, obvious mismatch that the player must reject or correct?
4. Should Copilot judging affect rank, award a separate category, or provide commentary only? The recommendation is a separate award or commentary.
5. Where will the public leaderboard be hosted, and what is the approved retention period for anonymous event results?
6. Are Mona, Copilot, Ducky, and their artwork approved for this booth experience, and which official brand assets should be used?
7. Is the target input model mouse/keyboard, touch, or both?

Follow-up exercises, intentionally excluded from this five-minute experience:

- **Customize the Recipe:** Use repository custom instructions so Copilot follows cafe conventions.
- **Rush-Hour Fix:** Find a defect in a Copilot-created pull request and request changes.
- **Two Orders at Once:** Demonstrate parallel agents after learners understand a single review loop.
