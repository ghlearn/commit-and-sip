import QRCode from "qrcode";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { guardNodeVersion } from "./require-node.mjs";
import { validateLeaderboardUrl, verifyPublicUrl } from "../.github/extensions/commit-and-sip/services/public-url.mjs";

guardNodeVersion();

export async function generateQr({ url, output, verify = verifyPublicUrl }) {
  const target = validateLeaderboardUrl(url);
  await verify(target);
  const bytes = await QRCode.toBuffer(target, {
    type: "png", errorCorrectionLevel: "M", width: 512, margin: 4,
    color: { dark: "#000000ff", light: "#ffffffff" }
  });
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, bytes);
  const manifest = {
    leaderboardUrl: target,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    generatedAt: new Date().toISOString(),
    alt: "QR code linking to the live Commit & Sip leaderboard"
  };
  await writeFile(`${output}.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length !== 1) throw new Error("Usage: npm run qr -- https://YOUR-APPROVED-PUBLIC-LEADERBOARD");
  const output = resolve(".github/images/leaderboard-qr.png");
  const manifest = await generateQr({ url: args[0], output });
  process.stdout.write(`Generated ${output}\nEncodes: ${manifest.leaderboardUrl}\nPublish only to an approved issue-readable asset host; never use a private-repository auth URL.\n`);
}
