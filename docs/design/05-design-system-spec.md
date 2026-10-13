# CP5 Design system spec: foundations and components

Status: done, 13 October 2026. Tokens: [tokens.json](tokens.json) (W3C Design Tokens format). Direction and the reasoning
behind every value: [03-design-direction.md](03-design-direction.md). This file specifies each component's anatomy, sizes and
states so Claude Design (and later code) builds it the same way every time.

## 1. Foundations recap

- **Grounds:** Mist (page), Paper (cards), Mist Deep (alternate section), Tide (one band), Tide Deep (footer).
- **Text:** Ink on light, Paper on dark; Slate and Tide Soft for secondary text.
- **Action:** Harbour only. Gold only for focus and the Next marker.
- **Type:** Newsreader 400 for display, H2, quote and figure; Source Sans 3 for everything else (see the CP3 type table).
- **Space:** 8px base; section padding 128 and 72; card padding 32 and 24; gap 24.
- **Shape:** chip 6, control 10, card 16, reading card 24, pill 999.
- **Elevation:** one tinted shadow per screen.
- **Motion:** press 120, hover 180, expand 240, settle 420, reading 2200. One easing curve: `cubic-bezier(0.165, 0.84, 0.44, 1)`.

## 2. Components

### Primary button

- **Anatomy:** label only. No trailing arrow (frontend-design tell list).
- **Size:** height 52 desktop and 56 mobile; horizontal padding 28; pill radius; Button type style; never wraps.
- **Colour:** Harbour ground, Paper text (5.98:1).
- **States:** hover Harbour Hover (8.02:1), 180ms; press translateY(1px), 120ms; focus gold ring; disabled at 40% opacity with
  `aria-disabled`, and the reason shown in helper text; busy shows the label "Joining" and the loading line.
- **Use:** "Join the early list", "Continue", "Send code", "Read my documents", "Save", "Try again".

### Outline button

- 2px Harbour border, Harbour text, transparent ground, same size and radius as primary. Hover: Harbour Tint ground.
- **Use:** "Talk to us about a pilot" only, plus "Add a person" and "Add a policy" in onboarding.

### Text link

- Harbour, underline 1px at 0.18em offset; hover Harbour Hover with a 2px underline. Inline links only; never a lone
  "Learn more".

### Nav bar

- Height 72 desktop and 64 mobile; Mist ground; bottom divider Fog 1px.
- Desktop: logo left (28px mark plus wordmark), four links at 16px Source Sans 3 600 in Ink with 32px gaps, primary
  button right (height 44 in the nav).
- Mobile: logo and a 44px menu button. The menu opens a full-width sheet with the same links and the primary button.

### Signature chip (Known, Not confirmed, Next)

| Variant | Ground | Text and icon | Border | Icon |
|---|---|---|---|---|
| Known | Harbour Tint | Harbour | none | check |
| Not confirmed | Gold Tint | Gold Ink | 1.5px dashed Gold Ink | question |
| Next | Tide | Paper | none; 10px gold marker dot to the left | arrow-right |

Height 28, padding 4 by 10, radius 6, Label type. Always read aloud with its prefix ("Known:"). Colour is never the only
cue: each variant has its own icon and border.

### Source line

- Source type (15/1.45), Slate. A 1px Fog rule 12px wide sits before it as a typographic mark (an em-rule substitute,
  not a dash character). It sits directly under the number, fact or quote it supports.

### Reading card (hero component)

- **Size:** 480 wide at desktop (5 of 12 columns), full width on mobile. Paper ground, radius 24, padding 32, the one
  shadow on the screen.
- **Anatomy, top to bottom:**
  1. A row with the "Example" label (Label type on a Mist Deep chip) and the person tabs (You, Maa, Papa; 36px tall;
     the selected one has a Tide 2px underline).
  2. Title (H3) and meta ("2 documents read", Source type).
  3. A route line: a 2px Tide vertical line on the left at x=16, running through all rows.
  4. Three Known rows, each with chip, statement (Body 17 on desktop inside the card) and source line.
  5. One Not confirmed row with a dashed border box around the statement.
  6. A Next row: the gold marker dot (12px) sits on the route line, and the statement is set in Body 600.
  7. A caption under the card: Source type, Slate.
- **Motion:** M1 (CP3 §6). The final state is the static design; the sequence plays once from empty rows.

### Comparison table

- Two equal columns on Paper with a row header column on desktop (3 columns: 200px label, 1fr, 1fr). The left column is
  in Slate; the right in Ink with a 3px Harbour line on its left edge for the whole column (column-level, not per card).
- Rows are separated by space (24) and one Fog divider between rows, not top and bottom borders on every row.
- Mobile: each row becomes a stacked pair: label, "At the hospital desk" text, then "With Knowvia" text, each prefixed
  by its column label in Label type.

### Route sequence (How it works)

- A vertical 2px Tide line on the left, three stops. Each stop: signature chip, H3, body (max 46ch), and on desktop a
  small specimen to the right (a single reading-card row in the real component style).
- The last stop ends in the gold marker. No numbers (the chips are the labels; frontend-design numbering rule).

### Story block

- Figure (Newsreader 56), story (Body), source line. The large block spans 7 of 12 columns and two rows, with a
  placeholder photo slot (the paper still life). The small blocks span 5 columns, stacked. Paper ground, radius 16,
  padding 32, no shadow.

### Quote

- Newsreader italic 30, Tide, max 30ch, with an opening quotation mark hung in the margin. Attribution in Label type,
  source line under it. No left border bar (AI tell).

### Permission panel (dark band)

- A Paper card on Tide (radius 16, padding 32). A segmented control at the top (You, Your son): 44px tall, Mist Deep track,
  the selected segment Paper with a Tide label. Three rows (Cover amount, Policy details, Medical details): Label type for
  the class and Body for the value; hidden values show a lock icon and "Not shared" in Slate.
- **Motion:** M4, a 180ms cross-fade of values only.

### Definition list (What we will not do)

- Two columns on desktop: term (H3, Tide) at 4 columns, description (Body) at 7 columns. 32px between items, no rules.
  Single column on mobile.

### FAQ item

- A full-width button with the question in H3, a caret icon right, 72px minimum height. A Fog divider between items.
  Opening rotates the caret 180 degrees and expands the panel (M3); the answer is Body, max 62ch. `aria-expanded` and
  `aria-controls` are set. All items start closed except the first.

### Early-list form

- **Hero (compact):** label above the field; the field and button side by side on desktop (field 320 wide, 52 tall,
  radius 10, 1px Rule border, Paper ground) and stacked on mobile (both full width). Helper text under it in Source type.
- **Closing (full):** a Paper card (radius 16, padding 40, the one shadow), with the field, the optional chip group
  (multi-select chips, 44px tall, Rule border; selected chips get a Harbour Tint ground and a Harbour border and check),
  the button, the negation line and the consent line.
- **States:** default, focus (gold ring), error (Brick 2px border plus an error icon and the message under the field;
  `aria-invalid` and `aria-describedby`), submitting, success card, already on the list, network error, server error.
  Copy for each is in CP4 §4.

### Footer

- Tide Deep ground; Paper text for the lockup; Tide Soft for links and small text. Four columns on desktop (lockup,
  Knowvia, Contact, Legal), stacked on mobile. Disclaimer and sources under a Paper-at-16% divider, Source type.

### Onboarding components

- **Step frame:** a 390 phone screen; top bar with a back button (44px) and "Step N of 5" in Label type; content padded
  20; primary button pinned to the bottom with 20 padding and a Mist ground behind it.
- **Option list:** full-width selectable rows (56px), Rule border, radius 10; selected rows get a Harbour border and a check.
- **Person row:** name, relationship and age on one line; an edit icon button (44px).
- **Permission row:** class name, current setting as a select (Shared with family, Only them, Choose people).
- **Upload zone:** 2px dashed Rule border, radius 16, 200px tall, file icon, the copy from CP4 and a "Choose a file"
  outline button. Drag-over: a Harbour border and Harbour Tint ground. Each uploaded file then shows as a row with name,
  size and a remove button.
- **Reading list:** each found item appears as a row with a check (Known) or question (Not confirmed) icon, using M6.
- **Matrix row:** Person (name and age), Policies, Known (chip plus source line), Not confirmed (chip), Next (chip plus
  owner). Desktop: a five-column table. Mobile: a stacked card per person. A "Why?" text button opens the source detail.

## 3. Accessibility checklist for every component

- Real elements: `<button>`, `<a href>`, `<input>` with `<label>`, `<fieldset>` and `<legend>` for option groups.
- Visible focus on every interactive element (the gold ring).
- Hit targets of at least 44px.
- Text contrast at least 4.5:1; borders of controls at least 3:1 (Rule).
- Status never by colour alone.
- Reading order follows the visual order; the reading card's sequence is announced only in its final state
  (`aria-live` off during M1).
- Every motion has a reduced-motion end state.
