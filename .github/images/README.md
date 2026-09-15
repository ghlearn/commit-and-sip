# Authentic images and QR release checklist

No App screenshots are supplied yet. Do not fabricate them, reuse unrelated product screenshots, or present canvas artwork as evidence of native App UI.

## Three captures to obtain

Capture these from the actual approved booth App build using a prepared, non-sensitive exercise. Crop for readable controls without removing necessary navigation context. Remove tokens, personal identities, unrelated repository details, and device/account identifiers before committing.

| Planned file | Authentic capture | Suggested alt text |
| --- | --- | --- |
| `review-summary.webp` | Assigned PR's native summary, with its route to changed files visible | “Copilot App pull-request summary for the Mona Latte order, with navigation to the changed files.” |
| `review-changes.webp` | Native changed-files view showing the single menu addition | “Copilot App diff showing one Mona Latte menu item with price 5.50 and hot serving style.” |
| `review-checks.webp` | Native checks view showing required check name and actual result for the assigned head | “Copilot App checks view showing the menu-validation result for the assigned pull request.” |

Confirm the actual capture matches its alt text, status, and control labels; revise the text if the App build differs. Add concise keyboard/touch instructions beside screenshots. Do not convey required information solely through arrows or color.

Once the files exist, repository Markdown may reference them relatively. Issue comments need an approved issue-renderable image URL; do not assume `.github/images/...` resolves from an issue body. Use the real repository/ref or approved asset-host URL, and test access from the intended viewer context.

Example **syntax only**, not a published asset:

```markdown
![Copilot App diff showing the single Mona Latte addition.](APPROVED_ISSUE_RENDERABLE_CHANGES_IMAGE_URL)
```

Replace the uppercase marker with the verified URL before posting any learner issue. No credential-bearing URL is acceptable.

## Leaderboard QR — not generated yet

Required committed output: `.github/images/leaderboard-qr.png`.

Companion output: `.github/images/leaderboard-qr.png.json`, containing the encoded leaderboard URL, PNG SHA-256 digest, generation timestamp, and alt text. Review and retain the PNG and manifest together.

There is currently no approved public leaderboard URL, so no production QR should be generated or advertised. After approval, run from the repository root:

```sh
npm ci
npm run qr -- <configured-HTTPS-leaderboard-URL>
```

The repository is intentionally private. A committed PNG alone is not publicly readable. Approve a public HTTPS asset location, publish the genuine generated PNG there, and configure `qrImageUrl` to that location. Never embed a GitHub access token or use a loopback/private-network address.

The generator checks public destination reachability before writing either output. Configure the image origin explicitly in `approvedQrOrigins` (default `[]`); the live client also checks the public QR URL is reachable as an image. An independent `jsqr` decoding test checks the generated image's payload. These technical checks do not constitute URL/branding approval or replace scanning the actual published image on a phone.

Recommended alt text: “QR code opening the Commit & Sip leaderboard.” Pair it with a descriptive **View the Commit & Sip leaderboard** link and readable destination text. Test the final issue-rendered image on the booth display and scan with a phone that has no staff credentials, including from cellular.

Release checks: correct approved destination, sufficient resolution, high contrast, intact quiet zone, accessible fallback, public image retrieval, mobile read-only leaderboard, and no attendee identity disclosure. Placeholders and mockups must never be described as scannable production assets.

## Branding

Current drink imagery uses original cup/glass artwork, not official mascot art. Drink names, GitHub/product references, event copy, and final artwork still require brand and trademark review. Do not add unapproved Mona, Copilot, or Ducky artwork to fulfill the historical outline. Retain original artwork provenance and record approval before event publication.
