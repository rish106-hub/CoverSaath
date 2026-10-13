# CP6 Page specs: landing page and onboarding

Status: done, 13 October 2026. Copy comes from [04-ia-and-copy-deck.md](04-ia-and-copy-deck.md), components from
[05-design-system-spec.md](05-design-system-spec.md), and values from [tokens.json](tokens.json). Desktop is specified at
1440 wide (content 1200, margins 120 at that width), mobile at 390 (margins 20).

## 1. Landing page, section by section

| # | Section | Desktop (1440) | Mobile (390) | Motion |
|---|---|---|---|---|
| 0 | Nav | 72 tall. Logo at the left margin; links centred in the row; button right | 64 tall. Logo and menu button | None |
| 1 | Hero | Padding 96 top, 128 bottom. Columns 1 to 7: H1 (Display, max 11ch, two lines), 24 gap, lead (max 54ch), 40 gap, compact form, 12 gap, helper. Columns 8 to 12: reading card, top aligned with the H1, overhanging the section's bottom edge by 64 so it bridges into the provenance line | Padding 40 top, 72 bottom. H1 (42px, three lines max), lead, form stacked, then the reading card full width below | M1 on load |
| 2 | Provenance | 64 top padding (the card's overhang), one centred line in Source type, max 70ch | Left aligned, 40 padding | None |
| 3 | Contrast | Paper ground, padding 128. H2 and lead in columns 1 to 7; table across 12 columns below (48 gap) | Padding 72. Stacked pairs | None |
| 4 | How it works | Mist, padding 128. H2 and lead in columns 1 to 6. Route sequence: line at column 1; stops with text in columns 2 to 6 and specimen in columns 8 to 12. Quote after the last stop, columns 3 to 10, 96 gap above | Text only; specimens hidden except the Next stop. Quote full width | None |
| 5 | Stories | Paper, padding 128. H2 and lead in columns 1 to 7. Grid: large block columns 1 to 7 spanning two rows (with a 4:3 photo slot), three small blocks columns 8 to 12. The 7-of-19 footnote spans 12 columns under the grid | One column; the large block first | None |
| 6 | Household control | Tide band, padding 128. H2 and lead in columns 1 to 5 (Paper and Tide Soft text); permission panel in columns 7 to 12; body line under the lead | Panel under the text, full width | M4 on toggle |
| 7 | What we will not do | Mist, padding 128. H2 columns 1 to 4 (top aligned with the first term); definition list columns 5 to 12 | H2, then the list | None |
| 8 | Partners | Mist Deep, padding 96. Eyebrow, H2, body in columns 1 to 6; three points in columns 8 to 12 with Phosphor icons; outline button under the body | Stacked | None |
| 9 | Questions | Mist, padding 128. H2 columns 1 to 4; accordion columns 5 to 12 | H2 then the accordion | M3 on open |
| 10 | Closing | Paper, padding 128. H2 and lead centred (max 20ch), form card centred at 640 wide below | Full-width card, 20 margins | M5 on submit |
| 11 | Footer | Tide Deep, padding 80 top and 48 bottom. Four columns; disclaimer and sources beneath | Stacked | None |

**Approximate page height:** 7,900 desktop and 10,400 mobile.

## 2. Onboarding (future state)

| Screen | Frame | Key layout | States drawn |
|---|---|---|---|
| O1 Start | 390 x 844 | H1, body, field, primary button pinned | Default; error |
| O2 What is coming up | 390 x 844 | H1, body, five option rows (one selected) | Selected |
| O3 People | 390 x 844 | Person rows (You, Maa, Papa), "Add a person" outline button, note | Filled |
| O4 Sharing | 390 x 844 | One card per person with three permission rows; emergency access row | Default privacy settings |
| O5 Add a policy | 390 x 844 | Upload zone, document chips, two uploaded file rows, skip link, security note | One error row (file over 15 MB) |
| O6 Reading | 390 x 844 | H1, live list of found items, body | Mid-read (three found, one not found) |
| O7 First matrix | 1440 x 900 and 390 x 844 | Desktop table of three people; mobile stacked cards | Filled, with one Conflicting row |

The flow is a clickable prototype in the design file: each primary button links to the next screen.

## 3. Placeholder register

| ID | Where | Brief | Size | Do not use |
|---|---|---|---|---|
| P1 | Stories, large block | Still life of a household's insurance papers in a plastic folder on a steel almirah shelf, soft daylight; policy numbers unreadable | 4:3, at least 1600 x 1200 | Hospital beds, stethoscopes, smiling families, stock "insurance" imagery |
| P2 | Optional, household control | An adult and an older parent at a dining table, hands and one document in frame, faces out of frame | 4:5, at least 1200 x 1500 | Posed stock models, medical settings |
| P3 | Open Graph image | The reading card's final state on Mist, with the lockup | 1200 x 630 | Text-only slogans |
| P4 | Partner email, contact email | [PARTNERS EMAIL], [CONTACT EMAIL] | | Personal email addresses |
| P5 | Legal | Privacy notice, terms, disclaimer wording, licensed partner disclosure | | Invented legal text |
| P6 | Consent re-check | Quotes and story figures E2 to E6 | | Publishing before consent is re-confirmed |

## 4. Responsive rules

- Grids collapse with `repeat(auto-fit, minmax(min(<min>px, 100%), 1fr))`; nothing uses a fixed root width.
- Display scales with `clamp(42px, 4.4vw, 64px)`; H2 with `clamp(32px, 3.1vw, 44px)`; body 17 to 19.
- Between 390 and 1440 the hero switches from stacked to split at about 960 (the reading card needs 440).
- Test at 320 wide and at 200% zoom: no horizontal scroll, the CTA never wraps, and chips wrap to a new line.
