# Commit & Sip

**Order Up at the Level Up Lounge:** a five-minute, app-only naming competition. Invent one coffee that carries `mona`, `ducky`, or `copilot`, get it scored out of 5,000 by a local rubric, and put it on the house menu for the rest of the event.

## One step, entirely in the App

**Audience:** beginners and GitHub-curious booth attendees. **Goal:** invent a drink name nobody has served here yet. **Duration:** about five minutes, with no speed or hint penalties.

You need only the booth's preconfigured Copilot App. No coding, cloning, account setup, GitHub sign-in, terminal, or external editor is required, and the attendee never opens a pull request. Staff supply the device and handle setup and recovery.

**Open:** click **Commit & Sip** with no input. The booth canvas is the default canvas and takes no open input; the counter opens idle and ready.

**Start:** choose **Start my order**. The station mints a barista handle, then follow **Step 1: Name a drink for the house menu**: pick a mascot and where it sits, type your name, and choose **Add it to the menu**. The [canonical learner step](.github/steps/1-name-a-drink.md) matches what the screen tells you.

**Finish:** read the score breakdown, take your place on the leaderboard, then choose **I'm done - hand over to the next barista**. That clears the counter for the next attendee; your drink stays on the menu and your entry stays on the leaderboard. See the [reset procedure](booth/RUNBOOK.md#reset-between-attendees).

Mona Latte, Copilot Cortado, and Ducky Cold Brew are worked examples. They are never scored and never appear on the leaderboard. The menu is first come, first served, so a name already taken is reported back and you try another.

This is a canvas-led adaptation of a GitHub Skills exercise: one learner step with several activities, not a five-step course. Staff setup is outside the learner step. Actions validate the repository; they do not drive learner transitions, create exercise issues, or gate play on workflow queue time. There is no Step 2 or automatic issue closure.

## Staff-only pull-request modes

The original pull-request review flow is retained behind the explicit `rehearsal`, `live`, and `live-canvas-pilot` modes, which open a different canvas with its own [learner content](.github/steps/1-review-and-serve.md). It is not the booth experience and its retirement is undecided.

In those modes, fresh direct rehearsal opens require the drink's `orderId`; only resuming a saved run may omit it. Live staff assignments must pin the intended `baseRef` and effective required checks, and disabled live configuration blocks saved live sessions without resetting their data.

## Status: rehearsal and an unranked canvas pilot, not production-ready

Commit & Sip is a project-local Copilot App canvas extension, registered as `commit-and-sip`. Rehearsal is a working local simulation, visibly separate from live GitHub review. It uses no remote services and makes no GitHub writes; it **does persist local progress and results**. It is not a real Copilot review, approval, merge, issue update, or event leaderboard submission.

Ranked native `live` use is blocked pending trusted native App view evidence, an independently verifying completion service, approved public HTTPS hosting and QR assets, authentic App screenshots, and booth/brand/privacy approval. There is **no deployed public leaderboard URL**. Configuration alone does not close these gaps.

The server-side `CompletionAuthority` module implements independent evidence checks, durable 1,000-point receipts, handle reservation, comment finalization, and an anonymous leaderboard projection. It is a deployment building block, not a hosted/authenticated service. Trusted native-view and factual-checkpoint readers, HTTP/auth integration, and a separate dedicated authority store are still required; see the [integration contract](docs/integration-contract.md).

### Real GitHub-connected canvas pilot — explicitly unranked

`live-canvas-pilot` is a separate staff-opt-in mode for a future authorized, prepared real PR. It uses the existing server-side `GithubAdapter` to load and recheck the actual issue, Summary → Changes → Checks, pinned head/base, menu, and required checks. Its sequential canvas observations are bound to the exact assignment/head; **they are not native App view events**. The learner must supply the factual checkpoint answers and explicitly approve after inspecting the menu and checks. Reviewer/author guards and the durable exact approval-attempt marker still apply.

Approval does not merge. A separately authorized operator merges; serving independently verifies that merge, menu, checks, and the exact approval attempt. The pilot ends at **`pilot-served`**, showing the menu, merge SHA, and learning summary—not Skills/event completion. It creates no handle, score, rank, QR, judge output, result submission, or completion comment; `complete` is blocked with `pilot_not_ranked`, and `CompletionAuthority` rejects pilot assignments.

Staff provision with `--review-source canvas-pilot`, which pins `reviewSource: "canvas-pilot"` in the durable journal and assignment without changing configuration mode. Staff separately enable `live-canvas-pilot` in ignored config, reload, and directly open `{"runId":"ASSIGNED_RUN_ID","mode":"live-canvas-pilot","orderId":"mona-latte"}` with the actual assigned drink. Setup remains rehearsal-only. Omitted review source retains native `live` behavior; there is no conversion or fallback between modes. See the [authorized staff procedure](booth/RUNBOOK.md#staff-only-unranked-canvas-pilot).

This milestone performs **no real provisioning, approval, merge, or staff configuration change**. Permissions, authentic screenshots, branding/privacy approval, and trusted native hosting remain unresolved. Browser fixtures use mocked transport; they are not actual GitHub execution or native App screenshots.

## What the ranked native live Skills experience will look like

The canvas remains the learner's home for **Step 1: Review and serve your order**. It displays the assigned GitHub issue, order criteria, PR number and revision, and the step guide. The learner inspects the real PR's Summary, Changes, and Checks in native Copilot App views, then returns to the canvas to refresh verified review, answer the factual checkpoint, and explicitly approve.

The **Your app result** panel distinguishes **Not served**, **Approved — waiting for an authorized merge**, **Served — event result pending**, and **Served — event result recorded**. Once the separate authorized merge is verified, the actual menu appears in the canvas even if finalization is unavailable. Only an accepted completion receipt unlocks the handle, score/rank, final learning summary, and confirmed issue update. It is one learner step, not a new series of issue workflows.

**Implemented foundation, not a runnable live booth yet:** the engine supports explicit trusted-evidence synchronization and the canvas has live guidance, assignment context, and app-result states. No production native evidence reader or navigation API is wired. The installed SDK's documented canvas host capability describes rendering support, not native PR-view observation; we did not invent a hook or turn canvas clicks into evidence.

Staff can inspect a prepared assignment without approving, merging, commenting, creating a run, or submitting a score:

```sh
npm run preflight:live -- --run ASSIGNED_RUN_ID
```

The command uses ignored `booth/local-config.json` (or `--config STAFF_CONFIG_PATH`) and server-side `gh`. It checks an open issue, exact menu-only PR delta, trusted passing checks, and unused approval/merge state. Exit **1** means invalid configuration or failed verification; exit **2** means a native-live assignment verified but its integration remains blocked. An explicitly configured canvas-pilot assignment exits **0** after verification, meaning assignment-verified only—not production readiness, permission certification, or event eligibility. Reports expose the mode and review source with `liveReady: false`, `eventEligible: false`, and `permissionsCertified: false`. See the [native checklist](booth/RUNBOOK.md#staff-only-live-pilot-preflight) and [unranked pilot procedure](booth/RUNBOOK.md#staff-only-unranked-canvas-pilot).

### Staff-only exercise provisioning

Staff can now claim **one existing prepared menu-only PR** and create its real exercise issue. Preview first:

```sh
npm run provision:live -- --run UNIQUE_RUN_ID --pr PREPARED_PR_NUMBER \
  --head FULL_VERIFIED_HEAD_SHA --base main --reviewer ASSIGNED_REVIEWER \
  --order mona-latte
```

This default preview uses GitHub GET requests only; it does not write the issue, config, or journal. Omitted `--review-source` preserves native `live` assignment behavior; explicitly add `--review-source canvas-pilot` for the unranked pilot. Add **`--apply`** to the same command only after staff approve the preview and exact assignment. The initializer embeds the mode-appropriate Step 1 guide and catalog criteria, then persists the issue/PR binding, review source, and pinned branch/check policy in the existing ignored staff config. It preserves other assignments, settings, and the configured mode. It does not create a PR, assert Copilot authorship, enable either GitHub-connected mode, or create learner progress.

**Provisioned is not reviewed, served, completed, or live-ready.** No real learner exercise has been provisioned by this implementation milestone: staff must supply the actual prepared PR, reviewer, and authenticated issue-creator context. Use one designated initializer and the same durable store as the canvas; never run independent provisioning stores against the same pool. Stable markers and a durable create-intent support restart/reconciliation, not atomic exactly-once GitHub issue creation. An uncertain POST is never blindly retried. See [provisioning and recovery](booth/RUNBOOK.md#staff-only-live-exercise-provisioning) before using `--apply`.

## Staff: open a rehearsal

Staff need Node.js 22 or newer and a Copilot App/CLI build supporting project canvas extensions. The pinned version lives in `.nvmrc`; run `nvm use` before npm scripts. Open this repository in that host.

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
nvm use
npm ci
npm test
npm run check
```

`npm ci` installs development dependencies, including the QR generator; it is not an attendee step.

`npm test` and `npm run check` refuse to start on Node older than the `engines` floor, and `npm ci` fails the same way because `engine-strict` is enabled. That guard is deliberate: on Node 18 the loopback `fetch` suites leave experimental undici handles open, so the run hangs forever instead of reporting failures. The suite also runs with a per-test timeout and forced exit, so a leaked handle cannot stall it.

## What learners practice

- Read acceptance criteria before reviewing generated work.
- Inspect the pull-request summary, changed files, and checks.
- Verify the exact item and scope, not merely a green check.
- Distinguish **approval** from **merge**. Live serving verifies an actual authorized merge; the canvas never automatically merges live work.

Every correctly completed rehearsal or accepted native-live event run earns **1,000 points**; the canvas pilot has no points or rank. Competition ties share a rank: `1 + number of accepted results with a strictly higher score`. Speed, retries, hints, and accessibility assistance do not reduce the score. For scored modes, handles are generated only after successful serving and saved before any remote submission.

For live global collisions, the authority reserves the same curated three-word phrase with a deterministic eight-hex suffix before commenting. The client persists the canonical handle from the authenticated receipt; retries with the original candidate retain the same reservation.

## Documentation

| Document | Audience |
| --- | --- |
| [Step 1: Name a drink for the house menu](.github/steps/1-name-a-drink.md) | Canonical learner instructions for the booth naming competition |
| [Step 1: Review and serve your order](.github/steps/1-review-and-serve.md) | Learner instructions for the staff-only pull-request modes |
| [Learner entry guide](docs/learner-guide.md) | Attendees and facilitators |
| [Booth runbook](booth/RUNBOOK.md) | Setup, rehearsal, retries, reset, and event staff |
| [Integration contract](docs/integration-contract.md) | Native host and service implementers |
| [Architecture and validation](docs/architecture.md) | Maintainers |
| [Asset capture checklist](.github/images/README.md) | Authentic screenshots, accessible QR, branding |
| [Order Up skill](.github/skills/order-up/SKILL.md) | In-app guided facilitation |
| [Approved exercise outline](docs/exercise-outline.md) | Preserved design source |

The approved outline is preserved verbatim, including its original proposals and open questions. Current implementation decisions above and in the integration contract deliberately clarify those proposals: approval is not merge, scored completions earn 1,000, the canvas pilot is unranked, no simulated native-view evidence certifies native-live review, and optional Copilot commentary is unavailable without a real trusted judge.

## Staff configuration and data

Copy `booth/config.example.json` to ignored `booth/local-config.json` and replace the example values before attempting live setup. Never put credentials in that file, the renderer, the repository, or a QR URL. See the runbook for the assignment and permission requirements.

Live completion requests only `COMMIT_AND_SIP_COMPLETION_TOKEN` through an explicit SDK user grant after session connection, and only for live mode with a configured endpoint. GitHub authentication remains server-side through `gh`. Configure `approvedQrOrigins` explicitly; its default empty list permits no QR asset origin.

An empty-input panel remembers its selected run while its provider is running. After an extension/App restart, it returns to setup: choose **Resume saved rehearsal** with the same run ID. The exercise data remains saved; do not create a new run as a recovery shortcut. Fully specified open inputs rehydrate directly.

State persists in `$COPILOT_HOME/extensions/commit-and-sip/artifacts/ledger.json`; `COPILOT_HOME` defaults to `~/.copilot`. Staff may set `COMMIT_AND_SIP_DATA_DIR` to an absolute directory before the host launches. The store uses `ledger.lock` and atomic, fsynced writes. Closing or reloading a panel does not reset an exercise.

This repository is intentionally private. Neither a device's loopback renderer nor private repository assets are public phone destinations. Do not publish an event QR until an approved publicly reachable HTTPS leaderboard and publicly readable, issue-renderable QR asset location exist.
