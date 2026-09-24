# Authentic images and QR release checklist

No App screenshots are supplied yet. Do not fabricate them, reuse unrelated product screenshots, or present canvas artwork as evidence of native App UI.

## Three captures to obtain

Capture these from the actual approved booth App build, using a prepared attendee run with no real personal details. Crop for readable controls without removing necessary context. Remove tokens, personal identities, unrelated repository details, and device or account identifiers before committing.

| Planned file | Authentic capture | Suggested alt text |
| --- | --- | --- |
| `booth-idle.webp` | The counter at rest, ready for the next attendee, with the house menu visible | "Commit & Sip booth canvas at rest, showing the house menu and the button to start an order." |
| `booth-naming.webp` | The naming form with the mascot and placement pickers and a name typed in | "Commit & Sip naming form with a mascot picker, a placement picker, and an invented drink name entered." |
| `booth-scored.webp` | The score breakdown with the drink on the house menu and the booth standing | "Commit & Sip result showing a rubric score out of 5,000, its breakdown, and the drink added to the house menu." |

Confirm each capture matches its alt text, status, and control labels; revise the text if the App build differs. Add concise keyboard and touch instructions beside screenshots. Do not convey required information solely through arrows or color. Do not show a real attendee's handle without their agreement.

Once the files exist, repository Markdown may reference them relatively.

## Leaderboard QR — not generated yet

Required committed output: `.github/images/leaderboard-qr.png`.

Companion output: `.github/images/leaderboard-qr.png.json`, containing the encoded leaderboard URL, PNG SHA-256 digest, generation timestamp, and alt text. Review and retain the PNG and manifest together.

There is currently no approved public leaderboard URL, so no production QR should be generated or advertised. After approval, run from the repository root:

```sh
npm ci
npm run qr -- <configured-HTTPS-leaderboard-URL>
```

A committed PNG alone is not a public phone destination. Approve a public HTTPS leaderboard, verify the generated code resolves to it, and never embed an access token or use a loopback or private-network address.

The generator checks public destination reachability before writing either output, and an independent `jsqr` decoding test checks the generated image's payload. The canvas renders its own QR server-side as a data URL, so this script produces a reviewable artifact rather than the code attendees scan. None of these technical checks constitutes URL or branding approval, or replaces scanning the real destination on a phone.

Recommended alt text: “QR code opening the Commit & Sip leaderboard.” Pair it with a descriptive **View the Commit & Sip leaderboard** link and readable destination text. Test the code on the booth display and scan it with a phone that has no staff credentials, including from cellular.

Release checks: correct approved destination, sufficient resolution, high contrast, intact quiet zone, accessible fallback, a mobile read-only leaderboard, and no attendee identity disclosure. Placeholders and mockups must never be described as scannable production assets.

## Branding

The booth screen currently ships no drink artwork. The original cup illustration belonged to the retired review page and was removed with it; any replacement must be original work, not official mascot art. Drink names, product references, event copy, and any future artwork still require brand and trademark review. Do not add unapproved Mona, Copilot, or Ducky artwork to fulfil the historical outline. Retain artwork provenance and record approval before event publication.
