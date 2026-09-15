import { readFile } from "node:fs/promises";

export function parseStep(markdown) {
  const blocks = markdown.trim().split(/\n\s*\n/);
  const title = blocks.shift();
  if (!/^# Step 1: [^\n]+$/.test(title ?? "")) throw new Error("The exercise must have one Step 1 title.");
  const sections = [];
  for (const block of blocks) {
    if (/^## [^\n]+$/.test(block)) {
      sections.push({ heading: block.slice(3), paragraphs: [] });
    } else {
      if (!sections.length || /[<>`*\[\]{}]|^\s*(?:#|>|-|\d+\.)/m.test(block)) {
        throw new Error("Exercise sections support plain paragraphs only; use a level-two heading for each activity.");
      }
      sections.at(-1).paragraphs.push(block.replaceAll("\n", " "));
    }
  }
  if (!sections.length || sections.some(section => !section.paragraphs.length)) {
    throw new Error("Each exercise activity needs learner instructions.");
  }
  return { title: title.slice(2), sections };
}

export function renderTemplate(template, values) {
  const rendered = template.replace(/\{\{([a-z]+)\}\}/g, (_, key) => {
    if (!Object.hasOwn(values, key) || typeof values[key] !== "string" || !values[key].trim()) {
      throw new Error(`Missing exercise template value: ${key}`);
    }
    return values[key];
  });
  if (/[{}]/.test(rendered)) throw new Error("Unresolved or unsupported exercise template placeholder.");
  return rendered.trim();
}

const [step, orderTemplate, feedbackTemplate, completionTemplate, liveStep, criteriaTemplate] = await Promise.all([
  "../../steps/1-review-and-serve.md",
  "../../markdown-templates/rehearsal-order.md",
  "../../markdown-templates/order-feedback.md",
  "../../markdown-templates/step-completion.md",
  "../../markdown-templates/live-review-guide.md",
  "../../markdown-templates/order-criteria.md"
].map(path => readFile(new URL(path, import.meta.url), "utf8")));
const guide = parseStep(step);
const liveGuide = parseStep(liveStep);

export function renderLiveOrder(order, { repo, prNumber, headSha, baseRef, runId }) {
  const criteria = renderOrderCriteria(order);
  return [
    `<!-- commit-and-sip-order:${runId} -->`,
    `<!-- commit-and-sip-pr:${prNumber} -->`,
    `Prepared order for ${repo}#${prNumber}. Revision: ${headSha}. Intended base: ${baseRef}.`,
    "Provisioned only: not reviewed, served, or completed. Staff prepared this PR; no Copilot authorship is asserted.",
    criteria,
    liveStep.trim()
  ].join("\n\n");
}

function renderOrderCriteria(order) {
  if (typeof order.price !== "number" || !Number.isFinite(order.price) || order.price < 0 || order.price > 100) {
    throw new Error("The rehearsal order needs a valid price.");
  }
  if (!["hot", "cold"].includes(order.serving)) throw new Error("The rehearsal order needs a valid serving style.");
  return renderTemplate(criteriaTemplate, { ...order, price: order.price.toFixed(2) });
}

export function renderRehearsalOrder(order) {
  return renderTemplate(orderTemplate, { title: guide.title, criteria: renderOrderCriteria(order) });
}

export function checkpointFeedback(order, answers) {
  const enteredPrice = answers.price === Number(answers.price.toFixed(2)) ? answers.price.toFixed(2) : String(answers.price);
  const mismatch = answers.price !== order.price
    ? `The price should be $${order.price.toFixed(2)}, but your answer was $${enteredPrice}.`
    : answers.serving !== order.serving
      ? `The serving style should be ${order.serving}, but your answer was ${answers.serving}.`
      : answers.scope !== "one-drink"
        ? "The change adds only the ordered drink, with no unrelated edits."
        : null;
  return mismatch ? renderTemplate(feedbackTemplate, { mismatch }) : null;
}

export function exerciseContent(run) {
  return {
    ...(run.mode === "live" ? liveGuide : guide),
    completion: run.phase === "completed"
      ? renderTemplate(completionTemplate, { name: run.order.name }) : null
  };
}
