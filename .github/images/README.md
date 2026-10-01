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

The event owner has supplied a static code for `https://gh.io/commit-and-sip-leader`, which redirects to the leaderboard service. It is not committed here, because the booth renders each attendee's own code from `leaderboardUrl`. Advertising it is still gated on the blocklist review and the service redeploy. The supplied image has almost no quiet zone (it decodes only once a white border is added), so print it with a margin. After approval, run from the repository root:

```sh
npm ci
npm run qr -- <configured-HTTPS-leaderboard-URL>
```

A committed PNG alone is not a public phone destination. Approve a public HTTPS leaderboard, verify the generated code resolves to it, and never embed an access token or use a loopback or private-network address.

The generator checks public destination reachability before writing either output, and an independent `jsqr` decoding test checks the generated image's payload. The canvas renders its own QR server-side as a data URL, so this script produces a reviewable artifact rather than the code attendees scan. None of these technical checks constitutes URL or branding approval, or replaces scanning the real destination on a phone.

Recommended alt text: “QR code opening the Commit & Sip leaderboard.” Pair it with a descriptive **View the Commit & Sip leaderboard** link and readable destination text. Test the code on the booth display and scan it with a phone that has no staff credentials, including from cellular.

Release checks: correct approved destination, sufficient resolution, high contrast, intact quiet zone, accessible fallback, a mobile read-only leaderboard, and no attendee identity disclosure. Placeholders and mockups must never be described as scannable production assets.

## Branding

The chalkboard above the menu carries one illustration: a cup drawn in the house palette, with the official Mona mascot sitting in the froth as latte art. The cup is original work for this booth. The mascot is not — it is official GitHub brand art, unaltered apart from cropping and background removal.

So unapproved official mascot art is on the attendee screen today. That makes brand and trademark review a gate on publication rather than a formality, and it is the only outstanding release item where this repository already ships something review might require us to undo rather than merely withhold.

| Served asset | Origin | Status |
| --- | --- | --- |
| Cup, saucer, steam, chalkboard — inline SVG in `renderer/booth.html` | Original work for this booth | No third-party rights involved. Event copy still needs review |
| `renderer/mona.png` | Official Mona mascot, from a GitHub brand asset sheet | **Unapproved for this use** |
| `renderer/fonts/MonaSansVF*.woff2` | Mona Sans upstream release | Licensed: SIL OFL 1.1, bundled as `fonts/OFL.txt` |
| `renderer/repo-qr.png` | Supplied by the event owner. Encodes `https://gh.io/commit-and-sip` (decoded with jsQR and ZXing), with the GitHub mark at its centre | Shown on the booth's served screen and the public leaderboard. The repository it opens is private |

### `mona.png` provenance

- **Supplied by:** the booth owner, from a brand asset sheet, during development. The path was added with a cream silhouette in commit `e957c44`; the current full-colour asset replaced it in commit `81ddf8e`.
- **Upstream source and licence:** not recorded. Establish and record both before publication. A file being handed to us is not a licence to publish it on a public menu.
- **Modifications:** cropped to the mascot, with the Gray 1 (`#f2f5f3`) sheet background keyed to transparency. No recolouring. `tests/palette.test.mjs` asserts the brand pink and purple survive, and rejects silhouetting, posterising, and aspect distortion.
- **Approved by:** nobody. No decision has been recorded on placing Mona in a coffee cup.

Contrast this with the bundled font, which ships its upstream licence and has a test asserting the licence matches the unmodified release. The mascot has no equivalent record. Closing that is a human task, not a code one.

### If review says no

The froth reverts to a plain cream pour. Replace the mascot assertions in `tests/palette.test.mjs` rather than deleting them, so whatever takes its place still has to read against the coffee — those guards exist because mid-tone art on mid-tone coffee disappears.

Any further artwork must be original work unless it is separately approved the same way. Drink names, product references, and event copy still require brand and trademark review.
