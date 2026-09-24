import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { startServer } from "../.github/extensions/commit-and-sip/server.mjs";

const fonts = new URL("../.github/extensions/commit-and-sip/renderer/fonts/", import.meta.url);
const hashes = {
  "MonaSansVF.woff2": "62e40f6e14e5bbb97132b4513a4d97319ab6aaa46996cf46c7a9f357edadb662",
  "MonaSansVF-Italic.woff2": "6dd9d760c5fc0c9a7e70b462eeb6b59172ac59ce3514793c930f2c623c785be4"
};

test("bundled Mona Sans faces and license match the unmodified upstream release", async () => {
  for (const [filename, expected] of Object.entries(hashes)) {
    const bytes = await readFile(new URL(filename, fonts));
    assert.equal(bytes.subarray(0, 4).toString(), "wOF2");
    assert.equal(createHash("sha256").update(bytes).digest("hex"), expected);
  }
  const license = await readFile(new URL("OFL.txt", fonts), "utf8");
  assert.match(license, /Copyright 2022 The Mona Sans Project Authors/);
  assert.match(license, /SIL OPEN FONT LICENSE Version 1\.1/);
});

test("the booth screen serves the local fonts with correct MIME and same-origin CSP", async t => {
  {
    const panel = await startServer({ panel: { runId: "font-test", get: async () => ({}), dispatch: async () => ({}) } });
    t.after(() => panel.close());
    const origin = new URL(panel.url).origin;
    const page = await fetch(panel.url);
    assert.match(page.headers.get("content-security-policy"), /(?:^|; )font-src 'self';/);
    assert.match(await page.text(), /href="\/fonts\/MonaSansVF\.woff2" as="font" type="font\/woff2" crossorigin/);
    for (const filename of Object.keys(hashes)) {
      const response = await fetch(`${origin}/fonts/${filename}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "font/woff2");
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(new URL(filename, fonts)));
    }
    const license = await fetch(`${origin}/fonts/OFL.txt`);
    assert.equal(license.status, 200);
    assert.match(await license.text(), /SIL OPEN FONT LICENSE/);
    assert.notEqual((await fetch(`${origin}/fonts/not-allowlisted.woff2`)).status, 200);
  }
});
