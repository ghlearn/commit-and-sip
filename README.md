# Commit & Sip

**Order Up at the Level Up Lounge:** a five-minute, app-only exercise in reviewing a small pull request. Inspect the proposal, compare it with an order, check the automated results, and make an explicit approval decision before serving the drink.

## Status: rehearsal, not production-ready

Commit & Sip is a project-local Copilot App canvas extension, registered as `commit-and-sip`. Rehearsal is a working local simulation, visibly separate from live GitHub review. It uses no remote services and makes no GitHub writes; it **does persist local progress and results**. It is not a real Copilot review, approval, merge, issue update, or event leaderboard submission.

Live use is blocked pending trusted native App view evidence, an independently verifying completion service, approved public HTTPS hosting and QR assets, authentic App screenshots, and booth/brand/privacy approval. There is **no deployed public leaderboard URL**. Configuration alone does not close these gaps.

The server-side `CompletionAuthority` module implements independent evidence checks, durable 1,000-point receipts, handle reservation, comment finalization, and an anonymous leaderboard projection. It is a deployment building block, not a hosted/authenticated service. Trusted native-view and factual-checkpoint readers, HTTP/auth integration, and a separate dedicated authority store are still required; see the [integration contract](docs/integration-contract.md).

## Open a rehearsal

Staff need Node.js 22 or newer and a Copilot App/CLI build supporting project canvas extensions. Open this repository in that host.

1. Reload extensions after checking out or changing extension files.
2. List extensions and confirm the project `commit-and-sip` extension is loaded. If it fails, inspect its entry and log before continuing.
3. Inspect the registered `commit-and-sip` canvas capabilities.
4. Open it with this input:

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
| [Learner guide](docs/learner-guide.md) | Attendees and facilitators |
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

State persists in `$COPILOT_HOME/extensions/commit-and-sip/artifacts/ledger.json`; `COPILOT_HOME` defaults to `~/.copilot`. Staff may set `COMMIT_AND_SIP_DATA_DIR` to an absolute directory before the host launches. The store uses `ledger.lock` and atomic, fsynced writes. Closing or reloading a panel does not reset an exercise.

This repository is intentionally private. Neither a device's loopback renderer nor private repository assets are public phone destinations. Do not publish an event QR until an approved publicly reachable HTTPS leaderboard and publicly readable, issue-renderable QR asset location exist.
