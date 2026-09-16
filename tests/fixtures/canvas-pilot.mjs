import { loadCatalog } from "../../.github/extensions/commit-and-sip/domain.mjs";
import { RunEngine } from "../../.github/extensions/commit-and-sip/engine.mjs";
import { RunStore } from "../../.github/extensions/commit-and-sip/store.mjs";
import { GithubAdapter } from "../../.github/extensions/commit-and-sip/services/github.mjs";
import { serviceCall } from "../../.github/extensions/commit-and-sip/services/live.mjs";

// Isolated mocked GitHub transport. No request can reach gh or a public network.
export async function pilotFixture(directory) {
  const catalog = await loadCatalog();
  const order = catalog.orders[0];
  const head = "a".repeat(40);
  const base = "b".repeat(40);
  const merge = "c".repeat(40);
  const repo = "fixture/menu";
  const root = `/repos/${repo}`;
  const assignment = { issueNumber: 1, prNumber: 2, headSha: head, baseRef: "main",
    reviewer: "fixture-reviewer", orderId: order.id, reviewSource: "canvas-pilot" };
  const config = { mode: "live-canvas-pilot", repo, runs: { "mocked-pilot": assignment } };
  const remote = {
    head, baseRef: "main", merged: false, checksPassed: true, reviews: [], calls: [],
    author: "fixture-author", actor: "fixture-reviewer", menu: [order], mergeMenu: [order],
    patch: `@@ -1 +1,10 @@\n-[]\n+${JSON.stringify([order], null, 2).replaceAll("\n", "\n+")}`,
    loseApprovalResponse: false, unavailable: false, baseTip: merge, baseContainsMerge: true, baseMenu: [order]
  };
  const encoded = menu => ({ type: "file", encoding: "base64", content: Buffer.from(JSON.stringify(menu)).toString("base64") });
  const adapter = new GithubAdapter({ repo, request: async (method, path, body) => {
    remote.calls.push({ method, path, body });
    if (remote.unavailable) throw new Error("Mocked transport unavailable");
    if (method === "POST" && path === `${root}/pulls/2/reviews`) {
      const review = { id: remote.reviews.length + 1, state: "APPROVED", user: { login: remote.actor },
        commit_id: body.commit_id, body: body.body, submitted_at: "2026-09-16T03:00:00Z" };
      remote.reviews.push(review);
      if (remote.loseApprovalResponse) throw new Error("Mocked lost approval response after write");
      return structuredClone(review);
    }
    if (method !== "GET") throw new Error(`Forbidden mocked write: ${method} ${path}`);
    if (path === "/user") return { login: remote.actor };
    if (path === `${root}/issues/1`) return { number: 1, state: "open", title: "MOCKED TRANSPORT FIXTURE — review Mona Latte",
      body: "Isolated browser/test fixture, not a real GitHub issue. Inspect the proposed Mona Latte: $5.50, hot, original-latte-cup; one drink only.",
      user: { login: remote.author } };
    if (path === `${root}/pulls/2`) return { number: 2, title: "MOCKED TRANSPORT FIXTURE — add Mona Latte",
      body: "Isolated transport exercises the real GithubAdapter. No public GitHub requests or writes.",
      user: { login: remote.author }, head: { sha: remote.head, repo: { full_name: repo } },
      base: { sha: base, ref: remote.baseRef, repo: { full_name: repo } }, state: remote.merged ? "closed" : "open",
      draft: false, mergeable: true, mergeable_state: "clean", merged: remote.merged, merge_commit_sha: remote.merged ? merge : null };
    if (path.startsWith(`${root}/pulls/2/files?`)) return [{ filename: "src/data/specials.json", status: "modified", patch: remote.patch }];
    if (path.startsWith(`${root}/pulls/2/reviews?`)) return structuredClone(remote.reviews);
    if (path.includes("/check-runs?")) return { check_runs: [{ id: 1, head_sha: remote.head, name: "menu-validation",
      app: { id: 15368, slug: "github-actions" }, status: "completed", conclusion: remote.checksPassed ? "success" : "failure" }] };
    if (path.includes("/statuses?")) return [];
    if (path === `${root}/contents/src/data/specials.json?ref=${base}`) return encoded([]);
    if (path === `${root}/contents/src/data/specials.json?ref=${head}`) return encoded(remote.menu);
    if (path === `${root}/contents/src/data/specials.json?ref=${merge}`) return encoded(remote.mergeMenu);
    if (path === `${root}/git/ref/heads/main`) return { ref: "refs/heads/main", object: { type: "commit", sha: remote.baseTip } };
    if (path === `${root}/compare/${merge}...${remote.baseTip}`) return {
      status: remote.baseContainsMerge ? "ahead" : "diverged", base_commit: { sha: merge },
      merge_base_commit: { sha: remote.baseContainsMerge ? merge : base }
    };
    if (path === `${root}/contents/src/data/specials.json?ref=${remote.baseTip}`) return encoded(remote.baseMenu);
    throw new Error(`Unexpected mocked route: ${method} ${path}`);
  } });
  const github = Object.fromEntries(["readIssue", "inspectPullRequest", "approve"].map(method =>
    [method, (...args) => serviceCall(() => adapter[method](...args))]));
  const options = { store: new RunStore(directory), catalog, config, github,
    viewEvidence: { read: () => { throw new Error("Pilot must never read native evidence"); } },
    completion: { finish: () => { throw new Error("Pilot must never submit completion"); } } };
  const engine = new RunEngine(options);
  const input = { runId: "mocked-pilot", mode: "live-canvas-pilot", orderId: order.id };
  const answers = { price: order.price, serving: order.serving, scope: "one-drink" };
  return { engine, options, input, answers, remote, assignment, config, adapter,
    open: () => engine.open(input), act: (action, value = {}) => engine.dispatch(input.runId, action, value),
    review: async () => {
      for (const surface of ["summary", "changes", "checks"]) await engine.dispatch(input.runId, "view", { surface });
    } };
}
