import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { DomainError, exactInput, preparedAssignment, requireValue, validRunId, validateStaffConfig } from "../domain.mjs";
import { renderLiveOrder } from "../content.mjs";
import { inspectPreparedPullRequest } from "./pilot.mjs";

const same = isDeepStrictEqual;
const own = (object, key) => Object.hasOwn(object ?? {}, key) ? object[key] : undefined;
const conflict = message => requireValue(false, "provision_conflict", message);
const uncertain = () => new DomainError("provision_reconciliation_required",
  "Issue creation may have reached GitHub. Retry this exact run to reconcile its marker; no second create will be attempted. If no issue is found, staff must investigate the original request and journal. Do not delete the reservation or use a new run for this PR.");

export function provisionRecords(data) {
  requireValue(data.provisions === undefined || Array.isArray(data.provisions),
    "store_invalid", "Provisioning storage is invalid. Preserve it for staff recovery.");
  return data.provisions ?? [];
}

function checkConflicts(data, config, runId, assignment, issueNumber) {
  const records = provisionRecords(data);
  const record = records.find(item => item.runId === runId);
  if (record && !same(record.assignment, assignment)) conflict("This run already reserves a different assignment.");
  for (const item of records) {
    if (item.runId !== runId && item.assignment.repo.toLowerCase() === assignment.repo.toLowerCase() &&
      (item.assignment.prNumber === assignment.prNumber || (issueNumber && item.issueNumber === issueNumber))) {
      conflict("This issue or prepared PR is reserved for another run.");
    }
  }
  for (const [id, run] of Object.entries(data.runs)) {
    if (id === runId) conflict("This run has already been opened. Provision only before learner intake.");
    if (run.mode === "live" && run.assignment?.repo.toLowerCase() === assignment.repo.toLowerCase() &&
      (run.assignment.prNumber === assignment.prNumber || (issueNumber && run.assignment.issueNumber === issueNumber))) {
      conflict("This issue or PR belongs to an existing learner run.");
    }
  }
  for (const [id, configured] of Object.entries(config.runs ?? {})) {
    if (id === runId) {
      if (!record?.issueNumber || !same(configured, { ...assignment, issueNumber: record.issueNumber })) {
        conflict("An existing staff assignment cannot be overwritten or adopted without its journal.");
      }
    } else if (configured?.prNumber === assignment.prNumber || (issueNumber && configured?.issueNumber === issueNumber)) {
      conflict("This issue or prepared PR is already assigned in staff configuration.");
    }
  }
  return record;
}

// One shared durable store is the coordinator. A create-intent is never leased or
// retried: a crash before/after POST deliberately sacrifices availability for safety.
export class LiveProvisioner {
  constructor({ store, catalog, github, configFile }) {
    Object.assign(this, { store, catalog, github, configFile });
  }

  async provision(input, { apply = false } = {}) {
    requireValue(typeof apply === "boolean", "invalid_input", "Provisioning requires an explicit boolean apply decision.", 400);
    exactInput(input, ["runId", "prNumber", "headSha", "baseRef", "reviewer", "orderId"]);
    const { runId, ...requested } = input;
    requireValue(validRunId(runId), "invalid_run", "Supply a fresh stable run ID.", 400);
    const initialConfig = validateStaffConfig(await this.configFile.read());
    const assignment = preparedAssignment(initialConfig, this.catalog, requested);
    const order = this.catalog.orders.find(item => item.id === assignment.orderId);
    const checkConfig = config => {
      validateStaffConfig(config);
      requireValue(config.repo === assignment.repo &&
        same(config.requiredChecks === undefined ? ["menu-validation"] : config.requiredChecks, assignment.requiredChecks),
      "provision_conflict", "Repository or required-check policy changed. Restore the original staff configuration.");
    };
    checkConfig(initialConfig);
    requireValue(this.github.repo === assignment.repo, "repository_mismatch", "Use the assigned GitHub repository.");
    let record = checkConflicts(await this.store.read(), initialConfig, runId, assignment);
    let title = record?.title ?? `Order Up! Review ${order.name}`;
    let body = record?.body ?? renderLiveOrder(order, { ...assignment, runId });
    const marker = `<!-- commit-and-sip-order:${runId} -->`;
    const prMarker = `<!-- commit-and-sip-pr:${assignment.prNumber} -->`;
    const actor = await this.github.request("GET", "/user");
    requireValue(typeof actor?.login === "string" && /^[a-z0-9][a-z0-9-]{0,38}$/i.test(actor.login),
      "invalid_staff_identity", "Authenticate the authorized staff issue creator.");
    if (record && record.creator !== actor.login.toLowerCase()) conflict("Use the original staff issue-creator identity for recovery.");
    await inspectPreparedPullRequest({ assignment, order, github: this.github });

    if (apply) {
      record = await this.store.transaction(async data => {
        const config = await this.configFile.read();
        checkConfig(config);
        const saved = checkConflicts(data, config, runId, assignment);
        if (saved) {
          requireValue(saved.creator === actor.login.toLowerCase(), "provision_conflict", "The staff creator changed.");
          return structuredClone(saved);
        }
        const created = { runId, assignment, order, creator: actor.login.toLowerCase(), title, body, stage: "reserved", issueNumber: null };
        data.provisions = [...provisionRecords(data), created];
        return structuredClone(created);
      });
    }
    if (record) {
      requireValue(same(record.order, order) && ["reserved", "creating", "bound", "installed"].includes(record.stage) &&
        typeof record.title === "string" && typeof record.body === "string",
      "provision_conflict", "The saved order or provisioning journal changed. Restore its original verified content.");
      ({ title, body } = record);
    }

    const issues = await this.github.pages(`${this.github.root}/issues?state=all`);
    const matches = issues.filter(issue => typeof issue.body === "string" && issue.body.includes(marker));
    requireValue(matches.length <= 1, "provision_conflict", "Multiple exercise issues have this run marker. Staff reconciliation is required.");
    requireValue(!issues.some(issue => typeof issue.body === "string" && issue.body.includes(prMarker) && !issue.body.includes(marker)),
      "provision_conflict", "This PR is claimed by another exercise issue.");
    let issue = matches[0];
    const verifyIssue = candidate => {
      requireValue(candidate && Number.isSafeInteger(candidate.number) && candidate.number > 0 &&
        !candidate.pull_request && candidate.state === "open" && candidate.title === title &&
        candidate.body === body && candidate.user?.login?.toLowerCase() === actor.login.toLowerCase(),
      "provision_issue_conflict", "The marked issue was edited, closed, or is not owned by this staff creator. No existing issue will be changed.");
      if (record?.issueNumber && record.issueNumber !== candidate.number) conflict("The persisted issue number and remote marker disagree.");
    };
    if (issue) {
      requireValue(record && record.stage !== "reserved", "provision_conflict", "An unowned issue marker exists. Do not adopt or edit it automatically.");
      issue = await this.github.readIssue(issue.number);
      verifyIssue(issue);
    } else if (record && record.stage !== "reserved") {
      throw uncertain();
    }

    if (!apply) {
      return { status: "preview", liveReady: false, runId, assignment: { ...assignment, issueNumber: issue?.number ?? null },
        issue: { title, body }, writes: false };
    }

    if (!issue) {
      const token = randomUUID();
      await this.store.transaction(data => {
        const saved = provisionRecords(data).find(item => item.runId === runId);
        requireValue(saved?.stage === "reserved" && same(saved.assignment, assignment),
          "provision_reconciliation_required", "Another initializer reserved the issue create. Retry the same run to reconcile; do not create another issue.");
        saved.stage = "creating";
        saved.createToken = token;
      });
      try {
        issue = await this.github.request("POST", `${this.github.root}/issues`, { title, body });
        verifyIssue(issue);
      } catch {
        throw uncertain();
      }
    }

    // Re-read remote state, including the PR, before publishing any assignment.
    issue = await this.github.readIssue(issue.number);
    verifyIssue(issue);
    await inspectPreparedPullRequest({ assignment, order, github: this.github });
    const complete = { ...assignment, issueNumber: issue.number };
    await this.store.transaction(async data => {
      const config = await this.configFile.read();
      checkConfig(config);
      const saved = checkConflicts(data, config, runId, assignment, issue.number);
      requireValue(saved && (!saved.issueNumber || saved.issueNumber === issue.number),
        "provision_conflict", "The issue assignment changed during provisioning.");
      saved.issueNumber = issue.number;
      saved.stage = "bound";
    });
    // Bound identity is durable before the separate config write. A failure can
    // only leave the same recoverable assignment, never authorize another POST.
    await this.store.transaction(async data => {
      const config = await this.configFile.read();
      checkConfig(config);
      const saved = checkConflicts(data, config, runId, assignment, issue.number);
      if (!same(own(config.runs, runId), complete)) {
        await this.configFile.write({ ...config, runs: { ...config.runs, [runId]: complete } });
      }
      saved.stage = "installed";
    });
    return { status: "provisioned", liveReady: false, runId, assignment: complete,
      canvasInput: { runId, mode: "live", orderId: assignment.orderId },
      message: "Provisioned, not reviewed, served, or completed. Live integrations and staff permission checks remain required. Configuration mode was not changed." };
  }
}
