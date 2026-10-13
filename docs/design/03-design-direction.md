# CP3 Design direction and system spec

Status: done, 13 October 2026. Built on [01-reference-teardown.md](01-reference-teardown.md), [02-product-audit.md](02-product-audit.md)
and the decisions in [00-requirements-and-framework.md](00-requirements-and-framework.md). The user asked to continue through the
checkpoints, so this file goes straight to CP4 instead of stopping for approval. Every decision here can still be overruled
and is traced to its source.

## 1. Design read

> Reading this as: a trust-first consumer landing page for Indian household insurance operators, with one partner
> block, in a calm editorial language: Newsreader over Source Sans 3, the Knowvia teal and gold system, and a single
> orchestrated motion moment.

Dials (taste skill): **DESIGN_VARIANCE 4, MOTION_INTENSITY 3, VISUAL_DENSITY 3.** These follow the trust-first band
(3 to 4, 2 to 3, 4 to 5), eased toward editorial, because the audience includes parents aged 46 to 60 reading
consequential text.

## 2. The idea

**The page behaves like the product.** Knowvia's promise is "show the source, name the limit, say the next step". The
landing page does the same thing to itself:

1. **Every number on the page has a visible source** set directly under it, like a citation in a policy reading. This
   is the honest form of the asterisk the references use (CP1, copy). It is the page's quiet signature.
2. **One bold element: the reading card.** The hero shows one example household's policy being read. The lines
   settle into Known (with the page each fact comes from), Not confirmed, and Next. It is the only orchestrated motion
   on the page, and it demonstrates the product's actual job instead of a feature list.
3. **The route.** The K mark is a vertical line, a branch and a gold destination marker. The same geometry draws the
   Known, Not confirmed, Next sequence: a thin Deep Tide line runs down the reading card and ends at a Signal Gold
   marker on Next. Gold always means "this is where you act".

Self-review against generic defaults (frontend-design process). The table below records what was considered and
changed:

| Default that crept in | Why it is generic | Change |
|---|---|---|
| A stat strip of three big numbers under the hero | The "big number, small label" default; and Knowvia has no stats | Replaced by one sentence of provenance and the story section, where numbers carry sources |
| Three equal how-it-works cards | Banned by the taste skill; template tell | A single sequence along the route line, read top to bottom on the reading card's own vocabulary |
| Uppercase KNOWN, UNKNOWN, NEXT labels | All-caps label tell, and the brand spec's own banner idea | Sentence case labels with an icon and a shape cue: Known, Not confirmed, Next |
| Section eyebrows above every H2 | Template chrome | One eyebrow on the whole page (the partner block) |
| Cream ground with serif and clay accent | AI-default palette | Knowvia's cool Mist and Deep Tide with teal and gold, from the brand spec |
| Fade-up on every section | Generic scroll reveal | No scroll reveals at all. Content is there when you arrive |

## 3. Colour tokens

Base values come from the brand spec. Additions are marked and justified. All ratios were computed with the WCAG 2.2
formula.

| Token | Hex | Role | Key contrast |
|---|---|---|---|
| `tide` | `#163F42` | Headlines on light, dark band ground | Paper on it 11.51 |
| `tide-deep` | `#0B383B` | Footer ground (from the wordmark) | Paper on it 12.78 |
| `harbour` | `#176F69` | **The only action colour**: primary buttons, links, selected controls | White on it 5.98; on Paper 5.98; on Mist 5.53 |
| `harbour-hover` *(added)* | `#125A55` | Button hover and press | White on it 8.02 |
| `harbour-tint` *(added)* | `#E3F0EE` | Known chip ground (Tide text and icon), selected-control ground | Tide on it 9.85 |
| `gold` | `#E0A02B` | Focus ring, the Next marker, at most two highlights | Never text on light (2.27 on Paper). On Tide 5.06 |
| `gold-tint` *(added)* | `#FBF1DD` | Not confirmed chip ground | `gold-ink` on it 6.17 |
| `gold-ink` *(added)* | `#7A5207` | Not confirmed chip text and icon | On Paper 6.91 |
| `mist` | `#F3F7F6` | Page ground | Ink on it 12.82 |
| `mist-deep` *(added)* | `#E6EFEC` | Alternate section ground (contrast block, partner block) | Ink 11.82; Slate 4.94 |
| `paper` | `#FFFFFF` | Cards, forms, reading surfaces | Ink 13.85 |
| `ink` | `#1A3034` | Body text | |
| `slate` *(adjusted)* | `#55696D` | Secondary text, sources | Paper 5.79, Mist 5.36, Mist Deep 4.94. Darkened from brand `#5C7074`, which fails on Mist Deep (4.45) |
| `fog` | `#CFDCDA` | Decorative dividers only | 1.41 on Paper: never a control boundary |
| `rule` *(added)* | `#7B918E` | Input and control borders | 3.34 on Paper, 3.10 on Mist (WCAG non-text 3:1) |
| `tide-soft` *(added)* | `#C9DDD9` | Secondary text on Deep Tide | 8.13 on Tide |
| `brick` | `#A74335` | Errors only | On Paper 6.00 |

**Proportions** (60-30-10, adjusted): Mist and Paper about 75%, Deep Tide about 18% (one band plus the footer), Harbour
under 5% (actions only), gold under 2%.

**Rules.** Harbour never sits on Deep Tide (1.93:1); there is no primary button on a dark band. On the dark band the
only control is the permission panel's segmented switch, inside a Paper card. The partner block's outline button sits
on Mist Deep. Harbour marks actions only: buttons, links and selected controls. Known chips, the comparison rule and
the eyebrow use Tide (CP7 M1). Status is never colour alone: Known has a check
icon and a solid chip, Not confirmed a question icon and a dashed border, Next an arrow and the gold marker.

**Dark theme** (tokens only, assumption A4): ground `#0E2224`, surface `#132C2E`, ink `#E8F1EF` (14.34), muted
`#A9BEBA` (8.45), action `#5FC2B4` with `#0E2224` text (7.75), gold `#F1B53A` (8.96), control border `#5B7774` (3.41).

## 4. Type

Families: **Newsreader** (variable, optical size 6 to 72, weights 200 to 800, italic) for display, H2 and pull quotes;
**Source Sans 3** for everything read, filled in or calculated; **Noto Sans Devanagari** reserved. All are SIL OFL on
Google Fonts. Fallbacks: `Newsreader, "Iowan Old Style", Georgia, serif` and `"Source Sans 3", system-ui, -apple-system,
"Segoe UI", Roboto, Arial, sans-serif`.

| Role | Family and weight | Desktop size / line-height / tracking | Mobile | Use |
|---|---|---|---|---|
| Display | Newsreader 400, `opsz` auto | 64 / 1.05 / -0.015em | 42 / 1.08 / -0.01em | Hero headline only |
| H2 | Newsreader 400 | 44 / 1.12 / -0.01em | 32 / 1.15 / -0.005em | Section headlines |
| Quote | Newsreader 400 italic | 30 / 1.3 / 0 | 24 / 1.32 / 0 | Customer quotes only |
| Figure | Newsreader 400, lining numerals | 56 / 1.0 / -0.01em | 40 / 1.0 | Rupee figures in stories |
| H3 | Source Sans 3 600 | 22 / 1.3 / 0 | 20 / 1.3 | Card and step titles |
| Lead | Source Sans 3 400 | 21 / 1.5 / 0 | 19 / 1.5 | Hero sub-line, section intros |
| Body | Source Sans 3 400 | 19 / 1.6 / 0 | 17 / 1.6 | All reading text, consent, conditions |
| Label | Source Sans 3 600 | 15 / 1.3 / 0.01em, sentence case | 15 | Chips, field labels, the signature labels |
| Source | Source Sans 3 400 | 15 / 1.45 / 0, `slate` | 15 | Source lines under numbers and quotes |
| Button | Source Sans 3 600 | 17 / 1 / 0.005em | 17 | All buttons, never wraps |

Display-to-body ratio 3.37 (CP1: calm sites 3.15 to 3.3). Desktop-to-mobile display 1.52 (CP1: 1.4 to 1.6). Newsreader
is never used for forms, prices, conditions or anything under 24px except the italic quote. Line length: body capped at
68ch, lead at 54ch, H2 at 18ch.

## 5. Grid, spacing, shape and elevation

- **Grid.** Desktop: 12 columns, 1200px content, 24px gutter, 80px side margin at 1440. Tablet (described only): 8
  columns, 40px margin. Mobile: 4 columns, 20px margin, 16px gutter.
- **Spacing scale (8px base).** 4, 8, 12, 16, 24, 32, 40, 48, 64, 80, 96, 128. Section padding 128 desktop and 72 mobile.
  Card padding 32 desktop and 24 mobile. Card gap 24. Section gap is about 5 times the card gap, which gives each claim
  a full screen to itself (CP1 layout).
- **Radius.** Chips 6, controls 10 (from the product), cards 16 (from the product), reading card 24, primary button
  pill 999. A different radius per level of hierarchy, not one radius on everything (frontend-design calibration).
- **Elevation.** One shadow, used once per screen: `0 18px 50px rgba(22,62,54,.09)` (from the product) on the reading
  card and the form card. Everything else is flat with a 1px Fog divider or no border.
- **Focus.** A 2px Tide outline at 2px offset plus a 5px Signal Gold halo (`box-shadow`). Tide carries the 3:1 on
  light grounds (10.66 on Mist, 11.51 on Paper); gold carries it on Tide (5.06). Built this way at CP7 (H1).
- **Hit targets.** At least 44px. Primary button height 52px desktop and 56px mobile.

## 6. Motion

| Token | Value | Use |
|---|---|---|
| `press` | 120ms, ease-out | Button press: translateY(1px) |
| `hover` | 180ms, ease-out | Background and border colour changes |
| `expand` | 240ms, `settle` | FAQ panels, permission toggle |
| `settle` | 420ms, `cubic-bezier(0.165, 0.84, 0.44, 1)` | Elements arriving in place; at most 8px of travel |
| `reading` | 2200ms total, once | The hero sequence (below) |

**Motion inventory.** The page has six motions and no others.

1. **M1 Reading sequence** (on load, once, the one orchestrated moment). 200 to 1900ms: the route line draws down the
   card. 300, 520 and 740ms: three Known lines settle in (420ms each); each source line fades in 120ms later. 1050ms:
   the Not confirmed line settles in, inside its dashed box. 1500ms: the Next line settles in. 1800 to 2200ms: the gold
   marker lands on Next. 2200ms: still. No loop. Under reduced motion every animation is off and the final state shows
   immediately; the static design is the final state.
2. **M2 Button.** Hover darkens to `harbour-hover` (180ms); press moves 1px (120ms).
3. **M3 FAQ.** The chevron rotates 180 degrees and the answer settles in (240ms); closing is instant.
4. **M4 Permission demo.** Choosing a viewer (You, your brother) changes which fields are visible.
   Hidden values become a lock and the words "Not shared" (180ms cross-fade). The motion is user-triggered and shows what
   changed.
5. **M5 Form.** Submitting shows "Joining" with the product's loading line under the button. Success replaces the form
   with a confirmation card (420ms `settle`, 8px).
6. **M6 Onboarding reading.** While a policy is read, each found item ticks into a list as it is found. No percentage,
   no fake progress.

Never: scroll reveals, parallax, smooth-scroll libraries, marquees, counters, carousels, autoplay video, scale above 1.02,
bounce or overshoot.

## 7. Icons and imagery

- **Icons.** Phosphor Icons, Regular weight (MIT), at 20px in chips and 24px in lists. In the Claude Design file they are
  drawn as inline stroke SVG at the same geometry. Set: check, question, arrow-right, lock-simple, file-text, users,
  user, shield-check (permissions only, never as a brand symbol), whatsapp-logo (only if confirmed), caret-down,
  envelope, phone.
- **Imagery.** Mostly typographic. Two placeholder photographs, each with a brief: (1) a still life of a household's
  insurance papers on a steel almirah shelf or in a plastic folder, with the policy number area out of focus; (2) an
  adult and a parent at a dining table reading one document together, hands and paper only, faces out of frame. Banned:
  hospital imagery, shields as a brand symbol, smiling-family stock, stethoscopes, heart-rate lines, gradient blobs.
- **The mark.** The existing K route mark and wordmark (`docs/assets/knowvia-wordmark.svg`, `knowvia-linkedin-logo.svg`).

## 8. Components (built in CP5)

Nav bar, primary button, outline button (dark), text link, signature chip (Known, Not confirmed, Next), source line,
reading card, comparison table, story block, quote, permission panel, FAQ item, early-list form (all states), footer,
onboarding step frame, progress steps, upload zone, person row, permission row, household matrix row.

## 9. Dependencies for whoever builds it later (no installation now)

| Need | Choice | Licence | Note |
|---|---|---|---|
| Fonts | Newsreader, Source Sans 3, Noto Sans Devanagari via Google Fonts or self-hosted | SIL OFL | Subset Latin and Devanagari; `font-display: swap` |
| Icons | Phosphor Icons | MIT | Tree-shake to the 12 icons listed |
| Motion | CSS transitions and keyframes; no library | n/a | M1 runs on load; nothing uses scroll |
| Framework | Decided at implementation (requirements non-goal) | n/a | `CLAUDE.md` points public indexable pages to Next.js and TypeScript; a static site generator is enough for this page |

## 10. Conflicts logged at this checkpoint

| Conflict | Resolution |
|---|---|
| Brand Slate `#5C7074` fails on the new Mist Deep ground (4.45) | Slate darkened to `#55696D` for all secondary text |
| Brand spec signature in uppercase (KNOWN, UNKNOWN, NEXT) versus the all-caps label tell | Sentence case, with icon and shape cues |
| Product "Unknown" versus a customer-facing word | "Not confirmed" (vocabulary map, CP2 §5) |
| Taste skill's single-theme lock versus Deep Tide bands | One band plus the footer (requirements §3) |
| CP1 Loop easing curve borrowed | A standard ease-out-quart curve, not proprietary |
| Gold focus ring alone failed 3:1 on light grounds (CP7 H1) | Two-tone ring: Tide outline plus gold halo |
| Harbour on Known chips, comparison rules and the eyebrow (CP7 M1) | Moved to Tide; Harbour is for actions only |

### Logged overrides (taste-skill pre-flight and copy rules, CP7 M14 and M15)

| Rule | Override | Reason |
|---|---|---|
| Every headline has an active verb (NN12) | "What we will not do" and "Questions families ask us" stay as labels | They are navigational labels, set without a full stop; a verb would make them slogans |
| Hero stack: no tiny text under the CTA | The helper line "Knowvia is not open yet. We will email you when it is." stays, at body size | Non-negotiable 2 (pre-launch truth) outranks the taste rule |
| Icons from Phosphor, not hand-drawn | Inline stroke SVG in the canvas | The Claude Design format requires inline SVG; the build uses Phosphor Regular at the same sizes |
| No two sections share a layout family | Sections 7 and 9 both use a heading-left, content-right split | They are not adjacent, the page uses seven layout families, and the taste skill's floor (four) is met |
| Gold only for focus and two highlights (NN18) | The K mark's gold arm and diamond appear in the nav and footer | The brand mark is exempt; it is not a highlight |
