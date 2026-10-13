# Landing v2: visual redesign, industry data and supporters

Status: built 13 October 2026, published to the canvas (version 21). The user found v1 too text-heavy. This round adds
visual energy without dropping the evidence rules.

## Decisions (user, 13 October 2026)

| ID | Decision | Effect |
|---|---|---|
| D9 | Make the page visually exciting: images or visuals, big numbers, animations, effects in the nav and footer | Hero composition, charts per number, sticky frosted nav, giant footer wordmark, motion dial raised from 3 to 5 |
| D10 | Say explicitly that Knowvia is for health insurance | H1 "Health insurance, read before the hospital does."; policy-type tabs under the lead; a band of health-policy clauses; FAQ "Is this only for health insurance?" |
| D11 | Supporters: Lightspeed India and Insurance Samadhan, logos under the email form | Official marks from lsip.com and insurancesamadhan.com, rendered to transparent PNG and tinted Tide; files in `assets/supporters/` |
| D12 | Launching soon | "Launching soon" pill in the nav and helper text; replaces "not open yet" |
| D13 | Use more of the green and teal range for highlights | Sprout, Fern, Pine, Seafoam, Mint, Lime added to `tokens.json` as highlight-only colours |
| D14 | Add shocking but real industry numbers, and make them move | A sourced statistics track on Pine that glides sideways and counts up |

The pill "Only health insurance. Nothing else." was removed at the user's request (it read as AI-generated) and
replaced by folder-style tabs naming the policies Knowvia reads.

## Industry evidence register (I1 to I4), each opened at its source on 13 October 2026

| ID | Figure on the page | Source | Note |
|---|---|---|---|
| I1 | 44% of health insurance claimants say their claim was rejected (15%) or partly approved (29%) for invalid reasons | [LocalCircles release, 7 March 2026](https://www.localcircles.com/a/press/page/health-insurance-claim-survey), 18,989 responses, claims made 2023 to 2025 | Self-reported; the page says "say" and "for reasons they found invalid" |
| I2 | ₹26,037 crore of health claims rejected or disallowed in 2023-24 (₹15,100 crore disallowed, ₹10,937 crore repudiated) | Minister of State for Finance, Lok Sabha reply, as reported by [Moneylife, 7 February 2025](https://www.moneylife.in/article/health-insurance-claims-worth-rs2603765-crore-rejected-by-insurers-in-fy2324-govt/76282.html) | Matches IRDAI annual report coverage |
| I3 | 5 in 10 claimants waited 6 to 48 hours for approval and discharge; the IRDAI rule is 1 hour for cashless authorisation and 3 hours for discharge | Same LocalCircles release, 18,119 responses | The IRDAI rule is as cited in that release; the circular itself was not opened |
| I4 | ₹43 of every ₹100 spent on health is out of pocket (43.4% of total health expenditure, 2022-23) | [PIB release, National Health Accounts 2022-23](https://www.pib.gov.in/PressReleasePage.aspx?PRID=2265816&lang=1&reg=3) | Newer than the widely quoted 39.4% (2021-22) |

Rejected as unverified: the Insurance Ombudsman total of 31,490 health complaints and "95% about claims" (secondary
sources only; the primary article confirms only "a majority").

Framing rule: the page never says Knowvia fixes rejections. The closing line of the section reads "Knowvia cannot
overrule an insurer. It changes the part you control: knowing your cover, and its rules, before the desk does."

## Overrides logged this round

| Rule | Override | Reason |
|---|---|---|
| MOTION_INTENSITY 3 | Raised to 5: count-up numbers, two opposite-direction marquees, hover lifts, frosted sticky nav, hero highlighter | User decision D9. Every motion has a reduced-motion end state; numbers default to their final values |
| One marquee per page (taste skill) | Two (clauses, statistics), running in opposite directions | User asked for numbers moving side by side |
| No trust strip in the hero (taste skill) | Supporter logos sit under the email form | User decision D11 |
| Gold for focus, Next and two highlights | Lime now carries the headline marker and the top statistic; gold keeps focus, Next and two chart highlights | Spreads emphasis across the new green family |

## Open before launch

- Permission to show the Lightspeed and Insurance Samadhan logos, and the exact words "Supported by".
- Real photography if wanted (automated sourcing was blocked or poor; licensed images should be chosen by the team).
- Re-check the industry numbers close to launch; newer IRDAI or LocalCircles releases may supersede them.

## Round 2 changes (13 October 2026, version 22)

- "Launching soon" removed everywhere (nav pill, hero helper, closing line, FAQ). Pre-launch honesty is kept with "Knowvia is not open yet."
- "What we will not do" is no longer a grid of cards. It is a manifesto: five refusals set large in Newsreader, each struck through by a Fern line that draws across as it scrolls into view, with the plain explanation beside it. It moved to just before the closing call to action and ends on a sign-off line: "That leaves the one job that matters: reading your family's health cover with you, before you need it." References: Loop's manifesto device, Dezerv's contrast pairs, Cardless's restraint.
- Permission panel: each viewer has its own animation. "You" slides in from the left, the lock on medical details springs open and the value is revealed left to right. "Your brother" slides in from the right, a Tide redaction bar sweeps over medical details, and a "Not shared" lock drops in with a small shake. Reduced motion shows the end states.

## Round 3 changes (13 October 2026, version 24)

- "This keeps happening to families" is now a horizontal track the visitor controls: drag, trackpad or touch scroll, with scroll snap, previous and next buttons and a progress bar. It still moves on its own, one card every 3.8 seconds, and stops while the pointer, focus or a finger is on it. Reduced motion stops the auto-advance.
- The clause band (room rent limit, co-pay, waiting period, sub-limit, deductible, network hospital and six more) runs continuously at 26 seconds per loop; hover no longer pauses it.
- Source marks (superseded in round 4): typographic marks were used first because of the State Emblem Act concern below.
- "Questions families ask us" now has ten answers (three added: employer group policy, documents needed to start, who can see family information) and a "Still have a question?" card with a contact slot.
- Contrast section: the "With Knowvia" card now stands out. It has a Pine ground, sits 20 px higher than the hospital desk card, carries a "The better way" badge with a pulsing dot, has Lime check discs and a deeper shadow, and ends on a benefit line ("Walk in already knowing your limits, your gaps and your next step.") with "Join the early list" and a partner link to the partners section. It makes no outcome promise about claims.
- The partners email block is removed. "Talk to us about a pilot" now points to the contact card in the questions section; the footer keeps only [CONTACT EMAIL].
- Merged the user's canvas edit: the consent marker was removed from the quote caption. The consent re-check itself is still open (see 08-review.md).

## Round 4 changes (13 October 2026, version 25)

The user asked for the official logos of the organisations behind each number. Each statistic card now ends with a
white "Source" plate showing those marks, and a full-width plate under the heading lists all five.

| Card | Number | Marks shown | Why |
|---|---|---|---|
| 1 | 44% | LocalCircles | Survey publisher |
| 2 | ₹26,037 cr | Ministry of Finance, Lok Sabha, IRDAI | Minister of State for Finance answered in the Lok Sabha using data shared by IRDAI (Moneylife, 7 February 2025, re-read on 13 October 2026) |
| 3 | 48 hours | LocalCircles, IRDAI | Survey publisher; the 1 hour and 3 hour rule is IRDAI's |
| 4 | ₹43 of ₹100 | Ministry of Health and Family Welfare | National Health Accounts 2022-23, released by the ministry |

How the files were made (docs/design/assets/sources/):
- IRDAI: the official SVG from irdai.gov.in, rendered to PNG.
- LocalCircles: cropped from the official sprite on localcircles.com (177 x 53 px, low resolution; ask them for a vector before launch).
- Ministry of Finance, Ministry of Health and Family Welfare, Lok Sabha: the government sites refused automated access, so these
  are lockups in the standard government format (the Emblem of India SVG from Wikimedia Commons, a rule, then the Hindi and
  English names and "Government of India" or "Parliament of India"). Swap in the files the ministries publish if the team
  obtains them.

[LEGAL REVIEW] before launch: the State Emblem of India (Prohibition of Improper Use) Act, 2005 restricts use of the emblem
for any trade, business or profession, and the ministry and Lok Sabha marks carry it. The user chose to show them as source
attributions. Before going public, counsel should confirm this use, or the plate should fall back to the typographic marks
(kept in round 3). IRDAI and LocalCircles marks also need permission or a fair-use view. The plates say "Source", never
"in partnership with" or "endorsed by".

## Round 5 changes (13 October 2026, version 28)

- "What we will not do" is now in proportion with the rest of the page. The heading uses the standard H2 size beside a numbered list of five struck terms (24 to 30 px, down from 64 px), each with one line of explanation; the sign-off line sits under the heading. Section padding drops to the standard 72 to 112 px.
- The closing section is no longer a giant headline beside an email box. The H2 drops to the standard display size, with three trust lines beside a compact form card. The card offers two ways in:
  - **Write it:** first name (optional), email, "Which health policies does your family have?" chips and "What is coming up?" chips.
  - **Say it:** a voice note of up to 60 seconds. A consent checkbox must be ticked before the record button works. States: before recording, recording (pulsing ring, live waveform, timer), and ready to send (play or pause, Record again). The send button becomes "Send voice note and join".
- Fixed a bug: the closing email field inherited `flex:1 1 260px` from the hero form and rendered about 260 px tall.
- New canvas tweaks: `closingMode` (write or voice) and `closingVoiceState` (idle, recording or recorded).
- Open before launch: [CONFIRM LANGUAGES] for voice notes; [LEGAL REVIEW] for voice-note retention, transcription and deletion. Voice about health is sensitive personal data under the DPDP Act, so consent must be explicit and specific.
- The Figma plugin and HTML pack are regenerated, with three new voice-note state boards (32 boards in all).
