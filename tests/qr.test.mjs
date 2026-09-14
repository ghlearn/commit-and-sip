import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PNG } from "pngjs";
import jsQR from "jsqr";
import { generateQr } from "../scripts/generate-qr.mjs";

test("generated QR independently decodes to the configured HTTPS URL with quiet zone", async t => {
  const directory = await mkdtemp(join(tmpdir(), "sip-qr-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = "https://example.org/commit-and-sip";
  const output = join(directory, "test-qr.png");
  let verified;
  const manifest = await generateQr({ url: target, output, verify: async url => { verified = url; } });
  const image = PNG.sync.read(await readFile(output));
  const code = jsQR(new Uint8ClampedArray(image.data), image.width, image.height);
  assert.equal(code.data, target);
  assert.equal(verified, target);
  assert.equal(manifest.leaderboardUrl, target);
  assert.equal(image.width, 512);
  assert.deepEqual([...image.data.slice(0, 4)], [255, 255, 255, 255]);
  await assert.rejects(generateQr({ url: "http://localhost:3000", output, verify: async () => {} }));
});
