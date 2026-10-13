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
