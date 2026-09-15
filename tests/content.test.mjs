import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseStep, renderTemplate, renderRehearsalOrder, checkpointFeedback, exerciseContent } from "../.github/extensions/commit-and-sip/content.mjs";
import { loadCatalog, makeRun, publicRun, rehearsalIssue } from "../.github/extensions/commit-and-sip/domain.mjs";

const { orders } = await loadCatalog();

test("the canonical Step 1 is the canvas guide for fresh and previously saved runs", async () => {
  const markdown = await readFile(new URL("../.github/steps/1-review-and-serve.md", import.meta.url), "utf8");
  const guide = parseStep(markdown);
  assert.equal(guide.title, "Step 1: Review and serve your order");
  assert.equal(guide.sections.length, 7);
  assert.match(guide.sections.map(section => section.paragraphs.join(" ")).join(" "), /no next lesson to unlock/);
  for (const order of orders) {
    const run = makeRun({ runId: `content-${order.id}`, mode: "rehearsal", order });
    run.issue = { title: "Preserved assignment", body: "Staff-edited instructions" };
    const original = structuredClone(run);
    for (const phase of ["order", "reviewing", "approved", "served", "completed"]) {
      const projected = publicRun({ ...run, phase });
      assert.deepEqual(projected.exercise.sections, guide.sections);
      assert.equal(projected.exercise.title, guide.title);
      assert.deepEqual(projected.issue, original.issue);
      if (phase === "completed") {
        assert.match(projected.exercise.completion, /Step 1 complete/);
        assert.ok(projected.exercise.completion.includes(order.name));
        assert.match(projected.exercise.completion, /Inspect, check, approve/);
      } else assert.equal(projected.exercise.completion, null);
    }
    assert.deepEqual(run, original, "presentation must not migrate or overwrite persisted state");
    assert.equal(exerciseContent({ ...run, mode: "live", phase: "approved" }).completion, null);
  }
});

test("every rehearsal order uses exact catalog criteria and honest simulation labels", () => {
  for (const order of orders) {
    const rendered = renderRehearsalOrder(order);
    assert.equal(rehearsalIssue({ order }).body, rendered);
    for (const value of [order.name, `$${order.price.toFixed(2)}`, order.serving, order.artwork, order.description]) {
      assert.ok(rendered.includes(value), `Missing ${order.id} criterion: ${value}`);
    }
    assert.match(rendered, /preserve existing items and their ordering/);
    assert.match(rendered, /simulated, not a real GitHub issue/);
    assert.match(rendered, /Approval is not a merge/);
    assert.match(rendered, /local result/);
    assert.doesNotMatch(rendered, /\{\{|https?:\/\//);
  }
});

test("content rejects missing, inherited, invalid, and unsupported placeholders instead of posting them", () => {
  for (const key of ["name", "price", "serving", "artwork", "description"]) {
    const incomplete = { ...orders[0] };
    delete incomplete[key];
    assert.throws(() => renderRehearsalOrder(incomplete), /valid price|valid serving style|Missing exercise template value/);
  }
  for (const price of [NaN, Infinity, -1, 101, "5.50"]) {
    assert.throws(() => renderRehearsalOrder({ ...orders[0], price }), /valid price/);
  }
  assert.throws(() => renderTemplate("Hello {{name}}", {}), /Missing exercise template value: name/);
  assert.throws(() => renderTemplate("{{name}}", Object.create({ name: "Inherited" })), /Missing exercise template value/);
  assert.throws(() => renderTemplate("{{bad-key}}", {}), /unsupported exercise template placeholder/);
  assert.throws(() => renderTemplate("{{name}}", { name: "{{leftover}}" }), /Unresolved/);
  assert.equal(renderTemplate("{{name}} / {{name}}", { name: "$&" }), "$& / $&");
});

test("step authoring is limited to one Step 1 title, activity headings, and plain paragraphs", () => {
  for (const markdown of [
    "", "# Step 2: Next\n\n## Activity\n\nDo it.",
    "# Step 1: Review\n\nMissing section.",
    "# Step 1: Review\n\n## Empty",
    "# Step 1: Review\n\n## Activity\n\n<script>bad</script>",
    "# Step 1: Review\n\n## Activity\n\n[Leave the App](https://example.com)",
    "# Step 1: Review\n\n## Activity\n\n- Unsupported list",
    "# Step 1: Review\n\n## Activity\n\nText.\n\n# Step 2: Next"
  ]) assert.throws(() => parseStep(markdown));
  assert.deepEqual(parseStep("# Step 1: Review\n\n## Activity\n\nRead the\nchange.\n"), {
    title: "Step 1: Review", sections: [{ heading: "Activity", paragraphs: ["Read the change."] }]
  });
});

test("checkpoint feedback identifies one mismatch at a time for every catalog order", () => {
  assert.match(checkpointFeedback(orders[0], { price: 5.501, serving: "hot", scope: "one-drink" }), /answer was \$5\.501/);
  for (const order of orders) {
    const answers = { price: order.price + 1, serving: order.serving === "hot" ? "cold" : "hot", scope: "unrelated-edits" };
    const price = checkpointFeedback(order, answers);
    assert.ok(price.includes(`price should be $${order.price.toFixed(2)}`));
    assert.doesNotMatch(price, /serving style should|change adds only/);
    answers.price = order.price;
    const serving = checkpointFeedback(order, answers);
    assert.ok(serving.includes(`serving style should be ${order.serving}`));
    assert.doesNotMatch(serving, /price should|change adds only/);
    answers.serving = order.serving;
    const scope = checkpointFeedback(order, answers);
    assert.match(scope, /only the ordered drink/);
    for (const feedback of [price, serving, scope]) {
      assert.match(feedback, /Return to Changes/);
      assert.match(feedback, /Hints and retries never reduce your score/);
    }
    answers.scope = "one-drink";
    assert.equal(checkpointFeedback(order, answers), null);
  }
});
