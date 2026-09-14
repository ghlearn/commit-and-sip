import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadCatalog } from "../.github/extensions/commit-and-sip/domain.mjs";

test("menu contains only exact catalog drinks with unique IDs", async () => {
  const menu = JSON.parse(await readFile(new URL("../src/data/specials.json", import.meta.url), "utf8"));
  const { orders } = await loadCatalog();
  assert.ok(Array.isArray(menu));
  assert.ok(menu.length <= orders.length);
  assert.equal(new Set(menu.map(item => item.id)).size, menu.length);
  for (const item of menu) {
    const order = orders.find(order => order.id === item.id);
    assert.ok(order, `Unknown drink: ${item.id}`);
    assert.deepEqual(item, order);
  }
});
