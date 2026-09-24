# Sourcing the moderation blocklist

**Status: a proposal awaiting a human decision. Nothing here approves a list.**

`booth/blocked-terms.json` ships as a placeholder. This document exists so the person who owns that decision has the tradeoffs in front of them instead of starting from a blank file. It deliberately contains no candidate terms: choosing them is the reviewable act, and a document that quietly supplied them would let the review be skipped.

## What the list is actually defending

The exposure is narrower than "user-generated content", and sizing the list to the real surface matters more than sizing it to a generic one.

An attendee-submitted name has already passed structural validation before the blocklist sees it. It is 3–40 characters, ASCII letters, numbers, spaces, hyphens and apostrophes only, contains no links or mentions, and must contain `mona`, `copilot`, or `ducky`. It is displayed on a booth screen, on the house menu for the rest of the event, and — once a leaderboard exists — on a public board.

Two consequences follow. Non-ASCII evasion is structurally impossible, so no confusable or homoglyph table is needed. And the mascot requirement means every hostile submission is wrapped around one of three tokens, which constrains what an attacker can construct but does not prevent anything.

## The constraint most public lists do not satisfy

Our entries carry a `match` mode:

- `substring` rejects the fragment anywhere in the name.
- `word` requires the term to consume whole words.

Public profanity lists are flat arrays. They do not carry this distinction, because most matchers do not have it. Importing one wholesale as `substring` reproduces the Scunthorpe problem at a booth with a queue behind the attendee; importing it wholesale as `word` misses terms that are genuinely never innocent as fragments.

So classification is a human pass over every entry regardless of source. **The size of the list is therefore the size of the review, not the size of the download.** This is the single fact that should drive the decision below.

## Option A — vendor an attributed public list

Candidates worth evaluating, in rough order of provenance quality:

- **LDNOOBW** ("List of Dirty, Naughty, Obscene and Otherwise Bad Words", maintained by Shutterstock). Multilingual, widely used, clear upstream.
- **`cuss`** (the wordlist behind `retext-profanities`). Notable because it carries a 0–2 severity rating per term, which maps usefully onto the `word`/`substring` decision.
- **Ofcom's offensive-language research.** Not a machine-readable list, but it ranks terms by public perception of severity and is the strongest justification available for where to draw a line.

Verify licence and attribution requirements at the source before vendoring anything. Do not take them from this document, and do not take them from a package README.

A hazard worth stating plainly: most npm profanity packages are undocumented derivatives of each other. Vendoring one often means vendoring an unattributed copy of a list whose original curation nobody can describe — which is precisely the situation the `review` block exists to prevent.

**Strength:** breadth, and an external party to point at.
**Weakness:** a 1,500-term list cannot honestly be read and accepted by one person in one sitting. `reviewedBy` would then record a name against a list that person did not actually review, which is worse than an empty field because it looks resolved.

## Option B — a short curated list, using A as a reference

Draw from the sources above, but keep only terms that are unambiguous at a family-friendly conference booth, and classify each one deliberately.

**Strength:** it can genuinely be read, argued about, and accepted. The provenance record becomes true. False positives stay low, which matters because a false positive is a live person being refused in front of a queue.
**Weakness:** it will miss things.

## Recommendation: Option B, with A cited as the source

Three reasons, in order of weight.

**The matcher already absorbs most of what list size would buy.** Digit folding, separator stripping, and repeat collapsing mean one entry covers `b4d`, `b a d`, `b-a-d`, and `baaad`. Long lists are mostly spelling variants of shorter ones, and those variants are exactly what we already handle.

**Takedown covers the tail, and the tail is the honest majority.** No list predicts what someone will type. `npm run remove` takes a name off the menu and standings within seconds and reserves it against retyping. Reaching for a longer list is reaching for the weaker of the two controls.

**A reviewable list produces a truthful provenance record.** `blocklistStatus` gates on `reviewedBy` and `reviewedAt`. Those fields are only worth having if they describe something that happened.

## What the reviewer records

Set in `booth/blocked-terms.json`:

- `review.placeholder` → `false`
- `review.reviewedBy` → the accountable person, not a team or a tool
- `review.reviewedAt` → an ISO date
- `review.source` → what the terms were drawn from, including the licence if a list was vendored
- `review.notes` → keep the matching guidance; replace the placeholder text

Then confirm the booth start no longer logs the moderation warning. That warning disappearing is the only automated signal that the gap is closed, and it checks provenance, not adequacy. **Nothing in this repository can certify that a list is sufficient.** Scope the list to the languages the event actually runs in, and re-review it for each event rather than treating one approval as permanent.
