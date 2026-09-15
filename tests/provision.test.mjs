import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { loadCatalog, validRunId } from "../.github/extensions/commit-and-sip/domain.mjs";
import { RunStore } from "../.github/extensions/commit-and-sip/store.mjs";
import { RunEngine } from "../.github/extensions/commit-and-sip/engine.mjs";
import { GithubAdapter } from "../.github/extensions/commit-and-sip/services/github.mjs";
import { LiveProvisioner } from "../.github/extensions/commit-and-sip/services/provision.mjs";
import { StaffConfigFile } from "../.github/extensions/commit-and-sip/services/staff-config.mjs";
import { inspectLivePilot } from "../.github/extensions/commit-and-sip/services/pilot.mjs";

const catalog = await loadCatalog();
const order = catalog.orders[0];
const repo = "cafe/menu";
const root = `/repos/${repo}`;
const headSha = "a".repeat(40);
const baseSha = "b".repeat(40);
const input = { runId: "pilot-001", prNumber: 2, headSha, baseRef: "main", reviewer: "reviewer", orderId: order.id };
const encode = menu => ({ type: "file", encoding: "base64", content: Buffer.from(JSON.stringify(menu)).toString("base64") });

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "sip-provision-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "staff.json");
  const config = { mode: "rehearsal", repo, requiredChecks: ["menu-validation"], completionEndpoint: null,
    approvedQrOrigins: [], staffNote: "preserve", runs: { untouched: { prNumber: 20, issueNumber: 21 } } };
  await writeFile(path, JSON.stringify(config));
  const store = new RunStore(join(directory, "data"));
  const configFile = new StaffConfigFile(path);
  const calls = [];
  const issues = [];
  const pr = { number: 2, title: "Prepared menu", body: "Staff fixture", user: { login: "author" },
    head: { sha: headSha, repo: { full_name: repo } }, base: { sha: baseSha, ref: "main", repo: { full_name: repo } },
    state: "open", draft: false, merged: false, mergeable: true, mergeable_state: "clean", merge_commit_sha: null };
  const facts = { actor: "staff", post: null, get: null, reviews: [], checks: [
    { id: 1, name: "menu-validation", app: { slug: "github-actions", id: 15368 }, head_sha: headSha, status: "completed", conclusion: "success" }
  ], menu: [order], files: [{ filename: "src/data/specials.json", status: "modified" }] };
  const github = new GithubAdapter({ repo, request: async (method, path, body) => {
    calls.push({ method, path, body });
    if (method !== "GET") {
      assert.equal(method, "POST");
      assert.equal(path, `${root}/issues`);
      if (facts.post) return facts.post(body);
      const issue = { number: 10, state: "open", user: { login: facts.actor }, title: body.title, body: body.body };
      issues.push(issue);
      return structuredClone(issue);
    }
    if (facts.get) await facts.get(path);
    if (path === "/user") return { login: facts.actor };
    if (path.startsWith(`${root}/issues?`)) return structuredClone(issues);
    if (path.startsWith(`${root}/issues/`)) return structuredClone(issues.find(issue => path === `${root}/issues/${issue.number}`));
    if (path === `${root}/pulls/2`) return structuredClone(pr);
    if (path.includes("/files?")) return facts.files;
    if (path.includes("/reviews?")) return facts.reviews;
    if (path.includes("/check-runs?")) return { check_runs: facts.checks };
    if (path.includes("/statuses?")) return [];
    if (path.endsWith(`?ref=${baseSha}`)) return encode([]);
    if (path.endsWith(`?ref=${headSha}`)) return encode(facts.menu);
    throw new Error(`Unexpected fixture read: ${path}`);
  } });
  const make = () => new LiveProvisioner({ store: new RunStore(store.directory), catalog, github, configFile: new StaffConfigFile(path) });
  return { directory, path, config, configFile, store, github, calls, issues, pr, facts, make,
    provision: (options = { apply: true }, value = input) => make().provision(value, options) };
}

test("preview verifies real adapter fixtures and renders exact canonical guidance with zero writes", async t => {
  const f = await fixture(t);
  const original = await readFile(f.path, "utf8");
  const preview = await f.provision({ apply: false });
  assert.equal(preview.status, "preview");
  assert.equal(preview.liveReady, false);
  assert.equal(preview.assignment.issueNumber, null);
  assert.equal(preview.assignment.reviewer, input.reviewer);
  const step = await readFile(new URL("../.github/markdown-templates/live-review-guide.md", import.meta.url), "utf8");
  assert.ok(preview.issue.body.endsWith(step.trim()));
  assert.match(preview.issue.body, /Mona Latte, \$5.50, hot/);
  assert.match(preview.issue.body, /Artwork: original-latte-cup/);
  assert.match(preview.issue.body, /preserve existing items and their ordering/);
  assert.match(preview.issue.body, /not reviewed, served, or completed/);
  assert.equal((preview.issue.body.match(/# Step /g) ?? []).length, 1);
  assert.ok(f.calls.every(call => call.method === "GET"));
  assert.equal(await readFile(f.path, "utf8"), original);
  assert.deepEqual(await readdir(f.directory), ["staff.json"]);
});

test("truthy non-boolean apply values cannot authorize writes", async t => {
  const f = await fixture(t);
  for (const apply of ["false", "true", 1, {}, null]) {
    await assert.rejects(f.provision({ apply }), { code: "invalid_input" });
  }
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await readdir(f.directory), ["staff.json"]);
});

test("prototype-mutating run IDs are rejected before provisioning or canvas persistence", async t => {
  const f = await fixture(t);
  assert.equal(validRunId("__proto__"), false);
  for (const apply of [false, true]) {
    await assert.rejects(f.provision({ apply }, { ...input, runId: "__proto__" }), { code: "invalid_run" });
  }
  const engine = new RunEngine({ store: f.store, catalog, config: f.config, github: f.github });
  for (const mode of ["rehearsal", "live"]) {
    await assert.rejects(engine.open({ runId: "__proto__", mode, orderId: order.id }), { code: "invalid_run" });
  }
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await readdir(f.directory), ["staff.json"]);
  assert.deepEqual(await f.configFile.read(), f.config);
});

test("valid inherited-property names persist as own run keys across restart", async t => {
  for (const runId of ["constructor", "toString", "hasOwnProperty"]) {
    const f = await fixture(t);
    const result = await f.provision({ apply: true }, { ...input, runId });
    const config = { ...(await f.configFile.read()), mode: "live" };
    assert.equal(Object.hasOwn(config.runs, runId), true);
    const engine = new RunEngine({ store: f.store, catalog, config, github: f.github });
    await engine.open(result.canvasInput);
    const restoredStore = new RunStore(f.store.directory);
    assert.equal(Object.hasOwn((await restoredStore.read()).runs, runId), true);
    const restored = new RunEngine({ store: restoredStore, catalog, config, github: f.github });
    assert.equal((await restored.dispatch(runId, "refresh")).runId, runId);
    assert.equal((await restored.open(result.canvasInput)).phase, "order");
  }
});

test("successful provision persists full assignment, preserves config, resumes idempotently and opens gated canvas", async t => {
  const f = await fixture(t);
  const result = await f.provision();
  assert.equal(result.status, "provisioned");
  assert.equal(result.liveReady, false);
  assert.deepEqual(result.assignment, {
    prNumber: 2, headSha, baseRef: "main", reviewer: "reviewer", orderId: order.id,
    repo, issueNumber: 10, requiredChecks: ["menu-validation"]
  });
  const config = await f.configFile.read();
  assert.deepEqual(config, { ...f.config, runs: { ...f.config.runs, [input.runId]: result.assignment } });
  const persisted = await f.store.read();
  assert.equal(persisted.provisions[0].stage, "installed");
  assert.deepEqual(persisted.runs, {});
  assert.deepEqual(persisted.results, []);
  assert.deepEqual((await f.provision()).assignment, result.assignment);
  assert.equal(f.calls.filter(call => call.method === "POST").length, 1);
  const live = { ...config, mode: "live" };
  assert.equal((await inspectLivePilot({ config: live, catalog, runId: input.runId, github: f.github })).liveReady, false);
  const engine = new RunEngine({ store: f.store, catalog, config: live, github: f.github });
  const opened = await engine.open(result.canvasInput);
  assert.equal(opened.phase, "order");
  assert.equal(opened.verification.nativeReviewAvailable, false);
  assert.deepEqual(opened.views, []);
  assert.equal(opened.result, null);
  const started = await engine.dispatch(input.runId, "start");
  assert.equal(started.issue.body, f.issues[0].body);
  await assert.rejects(engine.dispatch(input.runId, "sync_review"), { code: "native_views_unavailable" });
  await assert.rejects(f.provision(), { code: "provision_conflict" });
});

test("timeout after issue creation and process restart reconcile without a second POST", async t => {
  const f = await fixture(t);
  f.facts.post = body => {
    f.issues.push({ ...body, number: 10, state: "open", user: { login: "staff" } });
    throw new Error("Response lost");
  };
  await assert.rejects(f.provision(), { code: "provision_reconciliation_required" });
  assert.equal((await f.store.read()).provisions[0].stage, "creating");
  assert.equal((await f.provision()).assignment.issueNumber, 10);
  assert.equal(f.calls.filter(call => call.method === "POST").length, 1);
});

test("unknown create outcome with no visible issue never retries POST or frees the PR", async t => {
  const f = await fixture(t);
  f.facts.post = () => { throw new Error("Unknown remote outcome"); };
  await assert.rejects(f.provision(), { code: "provision_reconciliation_required" });
  await assert.rejects(f.provision(), { code: "provision_reconciliation_required" });
  await assert.rejects(f.provision({ apply: false }), { code: "provision_reconciliation_required" });
  await assert.rejects(f.provision({ apply: true }, { ...input, runId: "replacement" }), { code: "provision_conflict" });
  assert.equal(f.calls.filter(call => call.method === "POST").length, 1);
  assert.deepEqual((await f.configFile.read()).runs, f.config.runs);
});

test("config write failure and post-rename failure retain bound identity for restart", async t => {
  for (const after of [false, true]) {
    const f = await fixture(t);
    const writer = new StaffConfigFile(f.path);
    const realWrite = writer.write.bind(writer);
    writer.write = async config => {
      if (after) await realWrite(config);
      throw new Error("Disk failure");
    };
    const service = new LiveProvisioner({ store: f.store, catalog, github: f.github, configFile: writer });
    await assert.rejects(service.provision(input, { apply: true }), /Disk failure/);
    const saved = (await f.store.read()).provisions[0];
    assert.equal(saved.stage, "bound");
    assert.equal(saved.issueNumber, 10);
    assert.equal((await f.provision()).assignment.issueNumber, 10);
    assert.equal(f.calls.filter(call => call.method === "POST").length, 1);
  }
});

test("same-run concurrent workers never overlap creates or lock the ledger over network", async t => {
  const f = await fixture(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  f.facts.post = async body => {
    started();
    await gate;
    const issue = { ...body, number: 10, state: "open", user: { login: "staff" } };
    f.issues.push(issue);
    return issue;
  };
  const first = f.provision();
  await ready;
  try {
    await f.store.transaction(data => { data.unrelated = true; });
    await assert.rejects(f.provision(), { code: "provision_reconciliation_required" });
  } finally { release(); }
  await first;
  assert.equal(f.calls.filter(call => call.method === "POST").length, 1);
  assert.equal((await f.store.read()).unrelated, true);
});

test("run, PR, config, check-policy, creator and catalog conflicts fail without new writes", async t => {
  const f = await fixture(t);
  await f.provision();
  for (const change of [
    { prNumber: 9 }, { headSha: "c".repeat(40) }, { baseRef: "release" },
    { reviewer: "different" }, { orderId: catalog.orders[1].id }
  ]) await assert.rejects(f.provision({ apply: true }, { ...input, ...change }), { code: "provision_conflict" });
  await assert.rejects(f.provision({ apply: true }, { ...input, runId: "second" }), { code: "provision_conflict" });
  f.facts.actor = "different";
  await assert.rejects(f.provision(), { code: "provision_conflict" });
  f.facts.actor = "staff";
  const config = await f.configFile.read();
  await writeFile(f.path, JSON.stringify({ ...config, requiredChecks: ["different"] }));
  await assert.rejects(f.provision(), { code: "provision_conflict" });
  await writeFile(f.path, JSON.stringify(config));
  const changedCatalog = { ...catalog, orders: catalog.orders.map(item => ({ ...item, price: item.price + 1 })) };
  const service = new LiveProvisioner({ store: f.store, catalog: changedCatalog, github: f.github, configFile: f.configFile });
  await assert.rejects(service.provision(input, { apply: true }));
  assert.equal(f.calls.filter(call => call.method === "POST").length, 1);
});

test("existing assignments and learner runs cannot be overwritten, including reserved rehearsal IDs", async t => {
  const f = await fixture(t);
  await writeFile(f.path, JSON.stringify({ ...f.config, runs: { [input.runId]: { prNumber: 2, issueNumber: 10 } } }));
  await assert.rejects(f.provision(), { code: "provision_conflict" });
  await writeFile(f.path, JSON.stringify(f.config));
  const engine = new RunEngine({ store: f.store, catalog });
  await engine.open({ runId: input.runId, mode: "rehearsal", orderId: order.id });
  await assert.rejects(f.provision(), { code: "provision_conflict" });
  assert.equal(f.calls.length, 0);
  const g = await fixture(t);
  g.facts.post = () => { throw new Error("Timeout"); };
  await assert.rejects(g.provision());
  const reserved = new RunEngine({ store: g.store, catalog });
  await assert.rejects(reserved.open({ runId: input.runId, mode: "rehearsal", orderId: order.id }), { code: "provision_conflict" });
});

test("edited, closed, duplicate, foreign and missing marked issues are protected on retry", async t => {
  for (const mutate of [
    issues => { issues[0].body += "\nStaff edit"; },
    issues => { issues[0].title += " edited"; },
    issues => { issues[0].state = "closed"; },
    issues => { issues[0].user.login = "other"; },
    issues => { issues[0].pull_request = {}; },
    issues => { issues.push({ ...issues[0], number: 11 }); },
    issues => { issues.length = 0; }
  ]) {
    const f = await fixture(t);
    await f.provision();
    mutate(f.issues);
    const before = JSON.stringify(f.issues);
    await assert.rejects(f.provision());
    assert.equal(JSON.stringify(f.issues), before);
    assert.equal(f.calls.filter(call => call.method !== "GET").length, 1);
  }
});

test("foreign remote run/PR markers cannot be adopted or overwritten", async t => {
  for (const body of ["<!-- commit-and-sip-order:pilot-001 -->", "<!-- commit-and-sip-pr:2 -->"]) {
    const f = await fixture(t);
    f.issues.push({ number: 10, title: "Existing", body, state: "open", user: { login: "staff" } });
    await assert.rejects(f.provision(), { code: "provision_conflict" });
    assert.ok(f.calls.every(call => call.method === "GET"));
  }
});

test("head/base, scope, publisher/check, own-author, approved and merged failures prevent issue writes", async t => {
  for (const mutate of [
    f => { f.pr.head.sha = "c".repeat(40); },
    f => { f.pr.base.ref = "release"; },
    f => { f.facts.files.push({ filename: "README.md", status: "modified" }); },
    f => { f.facts.menu = [{ ...order, price: 1 }]; },
    f => { f.facts.checks[0].app.slug = "imposter"; },
    f => { f.facts.checks[0].conclusion = "failure"; },
    f => { f.pr.user.login = "reviewer"; },
    f => { f.facts.reviews = [{ id: 1, state: "APPROVED", user: { login: "reviewer" }, commit_id: headSha }]; },
    f => { f.pr.merged = true; f.pr.merge_commit_sha = "c".repeat(40); }
  ]) {
    const f = await fixture(t);
    mutate(f);
    await assert.rejects(f.provision());
    assert.ok(f.calls.every(call => call.method === "GET"));
    assert.deepEqual((await f.store.read()).runs, {});
    assert.equal((await f.store.read()).provisions, undefined);
  }
});

test("head mutation after issue creation blocks config installation without losing recovery", async t => {
  const f = await fixture(t);
  f.facts.post = body => {
    const issue = { ...body, number: 10, state: "open", user: { login: "staff" } };
    f.issues.push(issue);
    f.pr.head.sha = "c".repeat(40);
    return issue;
  };
  await assert.rejects(f.provision(), { code: "head_changed" });
  assert.equal((await f.store.read()).provisions[0].stage, "creating");
  assert.deepEqual((await f.configFile.read()).runs, f.config.runs);
  await assert.rejects(f.provision({ apply: true }, { ...input, headSha: "c".repeat(40) }), { code: "provision_conflict" });
  assert.equal(f.calls.filter(call => call.method === "POST").length, 1);
});

test("file config rejects concurrent external edits and keeps unrelated values", async t => {
  const f = await fixture(t);
  const config = await f.configFile.read();
  await writeFile(f.path, JSON.stringify({ ...config, note: "newer edit" }));
  await assert.rejects(f.configFile.write(config), { code: "config_changed" });
  assert.equal((await f.configFile.read()).note, "newer edit");
});

test("CLI invalid arguments stop before credentials, store or network access", () => {
  for (const args of [[], ["--apply"], ["--run", "x", "--run", "y"], ["--unknown"]]) {
    const result = spawnSync(process.execPath, ["scripts/provision-live.mjs", ...args], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage:/);
    assert.equal(result.stdout, "");
  }
});

test("reserved-stage restart is safe after a read outage before create intent", async t => {
  const f = await fixture(t);
  f.facts.get = path => {
    if (path.includes("/issues?")) throw new Error("Listing unavailable");
  };
  await assert.rejects(f.provision(), { code: "github_request_failed" });
  assert.equal((await f.store.read()).provisions[0].stage, "reserved");
  assert.equal(f.calls.filter(call => call.method === "POST").length, 0);
  f.facts.get = null;
  await f.provision();
  assert.equal(f.calls.filter(call => call.method === "POST").length, 1);
});

test("default checks are pinned and consumable by preflight; invalid policies write nothing", async t => {
  const f = await fixture(t);
  const { requiredChecks, ...config } = f.config;
  await writeFile(f.path, JSON.stringify(config));
  const result = await f.provision();
  assert.deepEqual(result.assignment.requiredChecks, ["menu-validation"]);
  const installed = await f.configFile.read();
  assert.equal(installed.requiredChecks, undefined, "preserve original global config");
  assert.equal((await inspectLivePilot({
    config: { ...installed, mode: "live" }, catalog, runId: input.runId, github: f.github
  })).liveReady, false);
  const engine = new RunEngine({ store: f.store, catalog,
    config: { ...installed, mode: "live", requiredChecks: ["weakened"] }, github: f.github });
  await assert.rejects(engine.open(result.canvasInput), { code: "assignment_changed" });
  for (const invalid of [[], null, ["menu-validation", "menu-validation"], [""], "menu-validation"]) {
    const g = await fixture(t);
    await writeFile(g.path, JSON.stringify({ ...g.config, requiredChecks: invalid }));
    await assert.rejects(g.provision(), { code: "invalid_checks" });
    assert.equal(g.calls.length, 0);
  }
});

test("coordinated config updates during network I/O preserve unrelated assignments and settings", async t => {
  const f = await fixture(t);
  let changed = false;
  f.facts.get = async path => {
    if (!changed && path.includes("/issues?")) {
      changed = true;
      await f.store.transaction(async () => {
        const current = await f.configFile.read();
        await f.configFile.write({ ...current, note: "newer",
          runs: { ...current.runs, another: { issueNumber: 40, prNumber: 41 } } });
      });
    }
  };
  await f.provision();
  const installed = await f.configFile.read();
  assert.equal(installed.note, "newer");
  assert.deepEqual(installed.runs.another, { issueNumber: 40, prNumber: 41 });
  assert.equal(installed.runs[input.runId].issueNumber, 10);
});

test("explicit null checks on any config re-read block writes and preserve same-run recovery", async t => {
  for (const changedRead of [2, 3, 4]) {
    const f = await fixture(t);
    const configFile = new StaffConfigFile(f.path);
    const read = configFile.read.bind(configFile);
    let reads = 0;
    configFile.read = async () => {
      if (++reads === changedRead) {
        await writeFile(f.path, JSON.stringify({ ...f.config, requiredChecks: null }));
      }
      return read();
    };
    const service = new LiveProvisioner({ store: f.store, catalog, github: f.github, configFile });
    await assert.rejects(service.provision(input, { apply: true }), { code: "provision_conflict" });
    const saved = await f.store.read();
    assert.equal(saved.provisions?.[0]?.stage, { 2: undefined, 3: "creating", 4: "bound" }[changedRead]);
    assert.equal((await f.configFile.read()).runs[input.runId], undefined);
    assert.equal(f.calls.filter(call => call.method === "POST").length, changedRead === 2 ? 0 : 1);
    await writeFile(f.path, JSON.stringify(f.config));
    assert.equal((await f.provision()).assignment.issueNumber, 10);
    assert.equal(f.calls.filter(call => call.method === "POST").length, 1);
  }
});

test("issue reuse introduced in config before binding blocks installation and keeps the issue", async t => {
  const f = await fixture(t);
  f.facts.post = async body => {
    const issue = { ...body, number: 10, state: "open", user: { login: "staff" } };
    f.issues.push(issue);
    await writeFile(f.path, JSON.stringify({ ...f.config,
      runs: { ...f.config.runs, conflict: { issueNumber: 10, prNumber: 77 } } }));
    return issue;
  };
  await assert.rejects(f.provision(), { code: "provision_conflict" });
  assert.equal(f.issues.length, 1);
  assert.equal((await f.configFile.read()).runs[input.runId], undefined);
  assert.equal((await f.store.read()).provisions[0].stage, "creating");
});

test("engine rejects another run claiming a reserved PR or issue", async t => {
  const f = await fixture(t);
  const result = await f.provision();
  for (const overrides of [{}, { prNumber: 99 }]) {
    const config = { ...(await f.configFile.read()), mode: "live",
      runs: { other: { ...result.assignment, ...overrides } } };
    const engine = new RunEngine({ store: f.store, catalog, config, github: f.github });
    await assert.rejects(engine.open({ runId: "other", mode: "live" }), { code: "assignment_reused" });
  }
});
