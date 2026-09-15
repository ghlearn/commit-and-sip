# Commit & Sip

**Order Up at the Level Up Lounge:** a five-minute, app-only exercise in reviewing a small pull request. Inspect the proposal, compare it with an order, check the automated results, and make an explicit approval decision before serving the drink.

## One step, entirely in the App

**Audience:** beginners and GitHub-curious booth attendees. **Goal:** compare a proposed menu change with its acceptance criteria before making a human approval decision. **Duration:** about five minutes, with no speed or hint penalties.

You need only the booth's preconfigured Copilot App and an assigned rehearsal canvas. No coding, cloning, account setup, terminal, or external editor is required. Staff supply the device and handle setup and recovery.

**Open:** click **Commit & Sip** with no input to reach **Choose your order**. Explicitly choose **New rehearsal**, a drink, and a never-used run ID, then select **Create new rehearsal**. To recover existing work, choose **Resume saved rehearsal** and enter its exact run ID instead. Nothing is created merely by opening the canvas.

**Start:** in the assigned canvas, choose **Start rehearsal order**. Follow **Step 1: Review and serve your order**: read the order, inspect Summary / Changes / Checks, answer the checkpoint, explicitly approve, then choose **Apply rehearsal menu**. The built-in **Read the step guide** control contains the [canonical learner step](.github/steps/1-review-and-serve.md); you do not need to leave the canvas to read it.

**Resume or retry:** choose **Refresh progress**, or reopen the same assigned run. If serving succeeded but the result is delayed, choose **Retry result**. Staff assign a fresh run for the next attendee; reloading is not a reset. See the [reset procedure](booth/RUNBOOK.md#reset-between-attendees).

This is a canvas-led adaptation of a GitHub Skills exercise: one learner step with several activities, not a five-step course. Staff initialization is outside the learner step. Actions validate the repository; they do not drive learner transitions, create exercise issues, or gate rehearsal on workflow queue time. There is no Step 2 or automatic issue closure.

## Status: rehearsal, not production-ready

Commit & Sip is a project-local Copilot App canvas extension, registered as `commit-and-sip`. Rehearsal is a working local simulation, visibly separate from live GitHub review. It uses no remote services and makes no GitHub writes; it **does persist local progress and results**. It is not a real Copilot review, approval, merge, issue update, or event leaderboard submission.

Live use is blocked pending trusted native App view evidence, an independently verifying completion service, approved public HTTPS hosting and QR assets, authentic App screenshots, and booth/brand/privacy approval. There is **no deployed public leaderboard URL**. Configuration alone does not close these gaps.

The server-side `CompletionAuthority` module implements independent evidence checks, durable 1,000-point receipts, handle reservation, comment finalization, and an anonymous leaderboard projection. It is a deployment building block, not a hosted/authenticated service. Trusted native-view and factual-checkpoint readers, HTTP/auth integration, and a separate dedicated authority store are still required; see the [integration contract](docs/integration-contract.md).

## What the live Skills experience will look like

The canvas remains the learner's home for **Step 1: Review and serve your order**. It displays the assigned GitHub issue, order criteria, PR number and revision, and the step guide. The learner inspects the real PR's Summary, Changes, and Checks in native Copilot App views, then returns to the canvas to refresh verified review, answer the factual checkpoint, and explicitly approve.

The **Your app result** panel distinguishes **Not served**, **Approved — waiting for an authorized merge**, **Served — event result pending**, and **Served — event result recorded**. Once the separate authorized merge is verified, the actual menu appears in the canvas even if finalization is unavailable. Only an accepted completion receipt unlocks the handle, score/rank, final learning summary, and confirmed issue update. It is one learner step, not a new series of issue workflows.

**Implemented foundation, not a runnable live booth yet:** the engine supports explicit trusted-evidence synchronization and the canvas has live guidance, assignment context, and app-result states. No production native evidence reader or navigation API is wired. The installed SDK's documented canvas host capability describes rendering support, not native PR-view observation; we did not invent a hook or turn canvas clicks into evidence.

Staff can inspect a prepared assignment without approving, merging, commenting, creating a run, or submitting a score:

```sh
npm run preflight:live -- --run ASSIGNED_RUN_ID
```

The command uses ignored `booth/local-config.json` (or `--config STAFF_CONFIG_PATH`) and server-side `gh`. It checks an open issue, exact menu-only PR delta, trusted passing checks, and unused approval/merge state. Exit **1** means invalid configuration or failed verification; exit **2** means the GitHub assignment verified but the live integration remains blocked. It never returns a production-ready success status. See the [pilot checklist](booth/RUNBOOK.md#staff-only-live-pilot-preflight).

## Staff: open a rehearsal

Staff need Node.js 22 or newer and a Copilot App/CLI build supporting project canvas extensions. Open this repository in that host.

1. Reload extensions after checking out or changing extension files.
2. List extensions and confirm the project `commit-and-sip` extension is loaded. If it fails, inspect its entry and log before continuing.
3. Inspect the registered `commit-and-sip` canvas capabilities.
4. Open it without input (or with `{}`) to show the setup screen. For a preassigned run that should open directly and automatically rehydrate after extension reload, use this input:

   ```json
   {"runId":"rehearsal-demo-001","mode":"rehearsal","orderId":"mona-latte"}
   ```

5. Start the order, inspect **Summary → Changes → Checks**, and compare the menu item with the issue. For Mona Latte, the factual checkpoint is **5.50**, **hot**, **one drink**.
6. Explicitly approve, then serve. Rehearsal applies a simulated menu and creates a local result; it does not change a real repository.

An agent driving the host uses `extensions_reload`, `extensions_manage` (`list`/`inspect`), `list_canvas_capabilities`, `open_canvas`, and `invoke_canvas_action`. These are host tools, not shell commands. Discover the loaded extension/provider identifiers instead of inventing them. Choose a panel `instanceId` when opening, then reuse that panel handle for actions. **`runId` is the durable exercise identity, not the panel identifier.**

The host resolves `@github/copilot-sdk/extension` automatically. Do not install an SDK package to run the extension. Local rehearsal requires no dependency installation once the modules are present. Maintainers use:

```sh
npm ci
npm test
npm run check
```

`npm ci` installs development dependencies, including the QR generator; it is not an attendee step.

## What learners practice

- Read acceptance criteria before reviewing generated work.
- Inspect the pull-request summary, changed files, and checks.
- Verify the exact item and scope, not merely a green check.
- Distinguish **approval** from **merge**. Live serving verifies an actual authorized merge; the canvas never automatically merges live work.

Every correctly completed run earns **1,000 points**. Competition ties share a rank: `1 + number of accepted results with a strictly higher score`. Speed, retries, hints, and accessibility assistance do not reduce the score. Handles are generated only after successful serving and saved before any remote submission.

For live global collisions, the authority reserves the same curated three-word phrase with a deterministic eight-hex suffix before commenting. The client persists the canonical handle from the authenticated receipt; retries with the original candidate retain the same reservation.

## Documentation

| Document | Audience |
| --- | --- |
| [Step 1: Review and serve your order](.github/steps/1-review-and-serve.md) | Canonical learner instructions, also shown inside the canvas |
| [Learner entry guide](docs/learner-guide.md) | Attendees and facilitators |
| [Booth runbook](booth/RUNBOOK.md) | Setup, rehearsal, retries, reset, and event staff |
| [Integration contract](docs/integration-contract.md) | Native host and service implementers |
| [Architecture and validation](docs/architecture.md) | Maintainers |
| [Asset capture checklist](.github/images/README.md) | Authentic screenshots, accessible QR, branding |
| [Order Up skill](.github/skills/order-up/SKILL.md) | In-app guided facilitation |
| [Approved exercise outline](docs/exercise-outline.md) | Preserved design source |

The approved outline is preserved verbatim, including its original proposals and open questions. Current implementation decisions above and in the integration contract deliberately clarify those proposals: approval is not merge, all correct completions score 1,000, no simulated native-view evidence certifies live review, and optional Copilot commentary is unavailable without a real trusted judge.

## Staff configuration and data

Copy `booth/config.example.json` to ignored `booth/local-config.json` and replace the example values before attempting live setup. Never put credentials in that file, the renderer, the repository, or a QR URL. See the runbook for the assignment and permission requirements.

Live completion requests only `COMMIT_AND_SIP_COMPLETION_TOKEN` through an explicit SDK user grant after session connection, and only for live mode with a configured endpoint. GitHub authentication remains server-side through `gh`. Configure `approvedQrOrigins` explicitly; its default empty list permits no QR asset origin.

An empty-input panel remembers its selected run while its provider is running. After an extension/App restart, it returns to setup: choose **Resume saved rehearsal** with the same run ID. The exercise data remains saved; do not create a new run as a recovery shortcut. Fully specified open inputs rehydrate directly.

State persists in `$COPILOT_HOME/extensions/commit-and-sip/artifacts/ledger.json`; `COPILOT_HOME` defaults to `~/.copilot`. Staff may set `COMMIT_AND_SIP_DATA_DIR` to an absolute directory before the host launches. The store uses `ledger.lock` and atomic, fsynced writes. Closing or reloading a panel does not reset an exercise.

This repository is intentionally private. Neither a device's loopback renderer nor private repository assets are public phone destinations. Do not publish an event QR until an approved publicly reachable HTTPS leaderboard and publicly readable, issue-renderable QR asset location exist.
