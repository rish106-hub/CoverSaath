# CP1 reference teardown: consumer fintech (EarnIn, Albert, Monarch, Kikoff)

Checkpoint CP1 of the Knowvia design brief. This is a first-principles reverse-engineering of four consumer
fintech landing pages. It weights typography, design language, copy and animation. It is reference analysis
only. Nothing here is Knowvia copy, and no line from these sites should be reused.

## Method, evidence labels and capture log

- Each home page was loaded on 13 October 2026 with `capture.mjs` (headless Chromium, 1440 x 900 desktop,
  390 x 844 mobile at 2x). The script records computed type for every visible line in order, a type ramp, large
  block backgrounds and padding, transitions, animations, keyframes, motion libraries, reduced-motion media
  rules, and elements hidden or offset before scroll (`preReveal`).
- **[captured]** means the value came from `capture.json` or is plainly visible in a captured screenshot.
  **[inferred]** means it is my reading of the evidence, not a measured value.
- Line-height ratios and tracking in `em` are computed from the captured px values (lh / size, tracking / size).
- Max widths are measured from screenshot pixel positions at 1440px, so they are approximate **[captured, approx.]**.
- Contrast ratios were computed with the WCAG formula from captured RGB values.
- Hover, focus and scroll-linked states were not driven. Motion is read from the CSS that was present.

| Site | Desktop | Mobile | Notes |
|---|---|---|---|
| EarnIn | 200, 190 copy lines, 23 ramp entries, 8845px tall | ok | A cookie panel covers the lower-left hero in both hero shots. Read around it. |
| Albert | 200, 121 copy lines, 17 ramp entries, 12708px tall | ok | Clean capture. |
| Monarch | 200, 128 copy lines, 19 ramp entries, 9274px tall | **partial** | Hero and product videos failed in headless ("Media Error"). The mobile hero screenshot is a cookie banner over a blank ground, so mobile layout was not readable. The mobile H1 value is the first H1 in the DOM, which is the second headline on the page (see below). |
| Kikoff | first run **502**, retry 200, 78 copy lines, 23 ramp entries, 8992px tall | ok (from retry) | All Kikoff values come from the retry. Some headings exist in the DOM but are blank in the full-page screenshot (see Motion). |

Changes since the earlier research doc (`research-doc.txt`, same date, earlier run) **[captured]**:
EarnIn's primary CTA is now black, not blue #1F6FF8. Monarch's display face is now `ABC Otto` with an
`ABC Oracle` sans and `Beltram Mono` eyebrows, not Copernicus, its hero headline now reads "The modern way to
manage your money", and its coral is rgb(248,103,19). Kikoff's hero CTA is black, not lime, and its headline stat
is now "+86pts". Albert matches the research doc.

---

## 1. EarnIn (earnin.com), earned-wage access

### Type system

Families **[captured]**: `earnInMori` (custom grotesque, weights 400, 600, 700, 800) carries display, headings,
body and footer. `Inter` (variable 100 to 900) is used only for buttons. FAQ `summary` rows fall back to
`ui-sans-serif`. One brand voice, one utility face for controls.

| Role | Family | Size px | Weight | Line-height | Tracking | Case |
|---|---|---|---|---|---|---|
| Display (H1) | earnInMori | 80 | 800 | 1.15 (92) | -0.36px (-0.005em) | Sentence |
| Closing display (H2) | earnInMori | 96 | 600 | 1.00 (96) | -1.44px (-0.015em) | Sentence |
| H2 section | earnInMori | 56 | 400 | 1.11 (62) | -0.9px (-0.016em) | Sentence |
| H2 small (steps) | earnInMori | 36 | 700 | 1.17 (42) | normal | Sentence |
| H3 step | earnInMori | 30 | 600 | 1.20 (36) | normal | Sentence |
| H3 FAQ | earnInMori | 24 | 600 | 1.15 (27.6) | -0.24px | Sentence |
| Quote | earnInMori | 24 | 400 (key words bold) | 1.15 (27.6) | -0.2px | Sentence |
| Eyebrow | earnInMori in a yellow chip ("EarnIn Offers") | not captured (span without class) | not captured | | | Title case **[captured, screenshot]** |
| Body | earnInMori | 20 | 400 | 1.20 (24) | normal | Sentence |
| Small / labels | earnInMori | 16 | 400 | 1.50 (24) | -0.16px | Sentence |
| Fine print | earnInMori | 12 to 14 | 400 | 15px | -0.12px | Sentence |
| Button | Inter | 20 (hero), 16, 14 (nav) | 600 | 1.40 (28) | -0.25px | Sentence |

All [captured] except where noted.

- **How hierarchy is built [inferred]:** weight does the most work at the top (800 hero vs 400 section H2s), so
  the hero is the only heavy block on the page. Section H2s drop to weight 400 at 56px, which reads editorial,
  not shouty. The closing line gets the largest size on the page (96px at 600) to bookend the hero. Negative
  tracking grows with size (-0.005em at 80 heavy, -0.016em at 56 regular), because heavy weights already close
  up. No uppercase anywhere; case is never a hierarchy tool.
- **Display to body ratio:** 80 / 20 = **4.0** [captured]. Against 16px labels it is 5.0.
- **Mobile H1:** 42px, line-height 48.3px (1.15), tracking -0.36px [captured]. Desktop to mobile = **1.90**.
- **Pairing logic [inferred]:** a single warm grotesque at very different weights says "one friendly voice".
  Inter on buttons separates "things you press" from "things you read". A heavy rounded grotesque fits a
  promise of speed and relief; it is not a trust-in-deliberation face.

### Colour and ground

| Token | Value | Role | Rough share |
|---|---|---|---|
| Warm off-white ground | rgb(245,244,240) | Every content section [captured] | ~70% |
| Black | rgb(0,0,0) | Text, primary pill CTA, footer band [captured] | ~15% |
| Payday yellow | ~rgb(255,235,61), radial gradient in closing band | Promo card, quote tiles, product panels, closing band, mini "Get started" chips on photo cards [captured] | ~12% |
| Link blue | rgb(29,109,245) | Footnote numerals and legal links only [captured] | <1% |
| White | | Nav, step cards | small |

- **Accent discipline [inferred]:** yellow is a *surface* colour, not a button colour. It never carries the main
  CTA, which is black (white on black 21:1, black on the yellow 17.3:1 [computed]). Yellow never appears on body
  text. Blue survives only as a compliance signal on footnotes, so "blue" now means "check the small print".

### Layout and rhythm

Max content width about 1180px (130px side margins at 1440) [captured, approx.]. Section wrappers have 0px
padding; the inner wrapper and the yellow closing band use 60px top and bottom [captured]. Gaps between
sections are large and visually ~160 to 200px [inferred from screenshot].

| # | Section | Layout family | Imagery |
|---|---|---|---|
| 1 | Hero: rating chips, H1, two pills | Centred stack | None above the fold except chips |
| 2 | Product carousel | Horizontal card rail with arrows and dots | Real-person photos with product name overlaid |
| 3 | "Want to get paid every second..." | Rounded yellow split card | 3D card render with balance chip |
| 4 | Three steps | Left-aligned H2, three equal cards, centred CTA | Line-and-yellow isometric illustrations |
| 5 | "Join millions..." | Centred H2, three-stat strip, 4 x 2 checkerboard of portraits and yellow quote tiles | Studio portraits |
| 6 | Perks | Split, text left, yellow phone panel right | Phone UI |
| 7 | Security | Split reversed (zig-zag) | Phone UI with bank connect |
| 8 | Closing band | Full-bleed yellow, split, 96px headline | Phone with dial |
| 9 | FAQ | Accordion, 11 questions | None |
| 10 | Footer | Black, four link columns, long legal | None |

### Motion

- [captured] Default transition is 0.3s `cubic-bezier(0.4, 0, 0.2, 1)` on colour, background, transform and
  opacity (Tailwind's standard ease). 10 elements use `all 0.7s` with the same curve and 4 use `all 0.5s
  cubic-bezier(0,0,0.2,1)`; [inferred] these are the carousel slides and card hovers.
- [captured] One running animation: `ask-anything-sweep 22.2s ... infinite` on the "Ask anything" button.
  [inferred] A slow light sweep that marks the AI entry point as alive without moving layout.
- [captured] Keyframes present: `marquee`, `wiggle-x`, `enter`, `exit`, `pulse`, `appear`, `spin`, plus a chat
  widget's own set. No GSAP, Lenis, Framer or AOS. One video element.
- [captured] `preReveal` is empty: nothing is hidden before scroll. Content is visible on arrival.
- [captured] One `prefers-reduced-motion` rule.
- [captured, screenshot] Hero product carousel with arrows and pagination dots.
- **Purpose [inferred]:** motion is for affordance (hover, carousel) and one "alive" cue on the AI button. It is
  never used to stage the argument; copy is readable without waiting.

### Copy, line by line

| Line (verbatim) | Role | Words | Punctuation and syntax | Buyer state | Principle | Transferable rule |
|---|---|---|---|---|---|---|
| 4.8 ⭐️ on App Store 352.5K reviews | Proof chip above H1 | 6 | No full stop; numeral first; review count in lighter grey | Sceptical first glance | Social proof placed before the claim | Put verifiable proof above the headline so the claim is read already trusted |
| 4.7 ⭐️ on Google Play 275K reviews | Proof chip | 6 | Same template as the first chip | Same | Similarity (Gestalt) | Twin proofs in one template read as one fact |
| Why wait for money you’ve already earned? | H1 | 7 | A question the reader answers "no reason"; contraction keeps it spoken; "already" carries the ownership | Frustrated, short of cash | Endowment effect; rhetorical question | Frame the benefit as something the reader already owns, then ask why they lack it |
| Get started | Primary CTA | 2 | Imperative, no object | Curious | Fogg ability: smallest ask | The first ask names no commitment |
| Ask anything | Secondary CTA | 2 | Imperative, open | Unsure | Lower the cost of a question | Offer a question route beside the action route for hesitant readers |
| Make every day payday | Carousel card sub | 4 | No full stop; product name above it does the noun work | Wants speed | Reframe | One four-word benefit per product card |
| Get paid up to 2 days early | Card sub | 7 | "up to" qualifier; numeral | Wants specifics | Specificity | Quantify with a bounded number, keep the qualifier honest |
| Want to get paid every second you work? | Promo H2 | 8 | Question; hyperbole on purpose | Playful | Curiosity gap | A question can open a feature as long as the next line answers it |
| Same. Now you can with Live Pay. | Promo answer | 7 | One-word fragment "Same." mirrors the reader's voice | Amused | Liking (Cialdini) | Answer your own question in the reader's register before naming the product |
| Get your pay now | Promo CTA | 4 | Imperative with possessive "your" | Ready | Endowment | Put the reader's possession in the button |
| Your grandpa waited to get paid. You don’t have to. | Steps H2 | 10 | Two sentences; old world then the reader; full stops create a beat | Resentful of the old way | Contrast effect | Name the old way in one sentence, release the reader in the next |
| Access money you’ve already earned in a few quick steps. | Steps sub | 10 | Restates the ownership idea; promises effort size | Wants ease | Fogg ability | State how much effort the next block will ask |
| Download the app and connect your bank | Step 1 H3 | 7 | No full stop; two imperatives joined by "and" | Planning | Chunking | Each step is one action pair |
| Get up to $200 of your upcoming paycheck2 — today | Step 2 H3 | 9 | Dash isolates "today"; footnote numeral attached | Wants amount and timing | Specificity, peak placement | Put the time word last so it lands |
| Arrives in 1-3 business days at no cost, or in minutes for a small fee10. | Step 2 body | 15 | Comma splits free vs paid paths; footnote | Fee-wary | Transparency reduces risk | State the cost trade-off in the body, not only in the fine print |
| Join millions getting paid as they work | Proof H2 | 7 | No full stop; "millions" is vague by design | Seeking reassurance | Social proof | Lead a proof block with a belonging line, then show the hard numbers |
| 700K+ 5-star reviews | Stat | 3 | Figure large, label small [screenshot] | Sceptical | Processing fluency | Figure first, label second, one line each |
| EarnIn helped me actually understand my money.8 | Quote | 7 | Bold on the outcome words; footnote on every quote | Wants to feel competent | Social proof plus disclosure | Bold only the outcome in a quote, and mark how quotes were gathered |
| It's my money. I'm not borrowing from anyone.8 | Quote | 8 | Two short sentences; denial of "borrowing" | Shame about debt | Reframe, dignity | Choose quotes that answer the category's main stigma |
| Perks that take your money further | H2 | 6 | No full stop; "further" implies motion | Exploring | Benefit framing | Section H2s can drop the full stop when they are labels, not claims |
| Save money, earn extra income, and grow your financial goals | Sub | 10 | Triad of verbs; serial comma | Aspirational | Rule of three | Triads summarise a section; keep each item a verb plus object |
| Secure by design | H2 | 3 | Fragment, no verb | Wary of linking a bank | Authority, brevity | A security headline can be a short principle, then prove it in the body |
| We use advanced security to protect your data, and we never sell your personal information. | Security body | 15 | First person plural; "never" is a commitment | Privacy fear | Commitment (Cialdini) | Pair a capability with a negative promise the reader can hold you to |
| The end of waiting for payday | Closing H2 | 6 | Noun phrase, no verb; echoes "wait" from the H1 | Convinced, needs a nudge | Bookending, recency | Close by restating the opening idea as an outcome |
| Get started with EarnIn | Closing CTA | 4 | Same verb as the hero CTA plus the brand | Ready | Consistency | Keep the CTA verb identical top and bottom |
| Are there mandatory fees or interest charges for using EarnIn? | FAQ | 10 | Uses the buyer's suspicious wording | Suspicious | Objection handling | Write FAQ questions in the buyer's own doubt words |
| Is EarnIn safe and secure to use? | FAQ | 7 | Plain yes/no question | Wary | Same | Ask the safety question out loud before the reader has to |

### First-principles takeaways for Knowvia

- **Borrow** the ownership frame: the reader already has cover and should know it. The hero can rest on what is
  already theirs, which suits a non-selling product.
- **Borrow** "answer your own question in the reader's voice" for one section, but not the jokes: grandpa humour
  would read as flippant next to health and money for a 26 to 60 audience.
- **Borrow** the security pairing: capability plus a negative promise ("never" statements) maps directly to the
  per-person permission promise.
- **Avoid** proof chips above the H1: Knowvia has no ratings and must not invent any. The slot can hold a
  research-backed line with an evidence ID instead.
- **Avoid** a heavy 800 display weight and saturated yellow surfaces; both say "speed", not "calm".

---

## 2. Albert (albert.com), banking and budgeting assistant

### Type system

Families **[captured]**: `seasonSerif` (300, 400) for display, section H2s and stat numerals. `seasonSans`
(500, 600, 700, plus intermediate 420 and 660 weights in use) for sub-lines, body, H3s, buttons and footer.
`albertIcon` is an icon font.

| Role | Family | Size px | Weight | Line-height | Tracking | Case |
|---|---|---|---|---|---|---|
| Display (H1) | seasonSerif | 58 | 400 | 1.30 (75.4) | -0.64px (-0.011em) | Sentence |
| Stat numeral | seasonSerif | 64 | 300 | 1.30 (83.2) | -0.48px | n/a |
| H2 section | seasonSerif | 48 | 400 | 1.30 (62.4) | -0.48px (-0.010em) | Sentence |
| H2 card | seasonSerif | 38 | 400 | 1.20 (45.6) | -0.32px | Sentence |
| H2 in blue band | seasonSans | 38 | 400 | 1.20 | -0.32px | Sentence |
| Hero sub-line | seasonSans | 20 | 400 | 1.40 (28) | normal | Sentence |
| H3 feature | seasonSans | 18 / 16 | 600 | 1.56 / 1.50 | normal | Sentence |
| Eyebrow | none; emoji tab pills do this job | 16 | 400 | 1.15 | normal | Title case |
| Body (section intro) | seasonSans | 18 | 400 | 1.56 (28) | normal | Sentence |
| Body (feature) | seasonSans | 16 | 500 | 1.40 (22.4) | normal | Sentence |
| Small / disclosures | seasonSans | 13 | 400 | 1.50 (19.5) | normal | Sentence |
| Button | seasonSans | 16 | 500 | 1.15 (18.4) | normal | Sentence |

All [captured].

- **Hierarchy [inferred]:** the serif carries every claim; the sans carries every explanation. Weight barely
  changes (serif 300 to 400), so hierarchy is size plus family switch. Tracking is light and constant
  (about -0.01em) on all serif sizes. One accent device: a single word in each serif headline turns royal blue
  ("Genius", "big moments", "seamlessly", "Protect", "Albert") [captured, screenshot].
- **Display to body ratio:** 58 / 18 = **3.2**; against the 20px hero sub-line it is 2.9 [captured].
- **Mobile H1:** 36px, line-height 41.4px (1.15), tracking -0.64px [captured]. Desktop to mobile = **1.61**.
  Note the line-height tightens from 1.30 to 1.15 on mobile.
- **Pairing logic [inferred]:** a book serif at regular weight over a soft grotesque gives "personal service,
  considered advice". The 1.30 display line-height is generous for a serif and adds calm. This is the closest
  structural match to Newsreader over Source Sans 3.

### Colour and ground

| Token | Value | Role | Rough share |
|---|---|---|---|
| Light grey ground | rgb(245,245,245) | Hero [captured] | ~7% |
| White | rgb(255,255,255) | All middle sections [captured] | ~75% |
| Cool grey | rgb(242,243,247) | Closing CTA and footer [captured] | ~12% |
| Ink | rgb(17,17,17) | Headlines, body | text |
| Muted ink | rgb(96,97,105) | Sub-lines, section intros [captured]; 5.65:1 on the hero grey [computed] | text |
| Royal blue | rgb(0,42,240) | Pill CTAs, one word per serif headline, one gradient band, 3D hero objects [captured] | ~5% |
| Yellow-green glow | radial, hero and Genius card | Atmosphere only [captured, screenshot] | trace |

- **Accent discipline [inferred]:** blue appears on filled CTAs (white on blue 8.1:1 [computed]), on exactly one
  word of a headline, and on one full band. It never colours body text or links in running copy. Secondary
  actions ("Learn more") are outlined black pills, so blue fill means "the main action" only.

### Layout and rhythm

Feature content runs about 1024px wide (208 to 1232) inside a nav width of about 1280 [captured, approx.].
Captured padding: hero top 112px; stats section 192px top, 256px bottom; closing section 64px top. Most section
wrappers report 0 and space with inner margins, with ~200px visible gaps [inferred from screenshot].

| # | Section | Layout family | Imagery |
|---|---|---|---|
| 1 | Hero | Centred stack inside a slowly rotating orbit ring of floating 3D objects | 3D glass objects, UI chips |
| 2 | "Albert sees your full financial picture." | Centred H2, emoji tab pills, one-line descriptor, outlined CTA, product UI | Desktop plus phone UI |
| 3 | "Unlock the full power..." | Centred H2, tab pills, then split card (text left, UI right) | Gradient UI card |
| 4 | "Discover Genius in action" | Left H2 with arrow buttons, horizontal card carousel | Dark UI cards |
| 5 | "Know where your money's going" | Centred H2, UI, three-column features | UI |
| 6 | "Plan for life's big moments" | Same pattern | UI |
| 7 | Blue band | Rounded gradient card, split | Flow diagram UI |
| 8 | "Bank, save, and invest seamlessly." | Centred H2, disclosure line, three cards | Card, notification, chart |
| 9 | "Protect your accounts" | Bento of security features | UI |
| 10 | Stats | Centred H2, three serif numerals, CTA, blue radial glow | None |
| 11 | Closing | Left-aligned H2 and CTA on cool grey | None |
| 12 | Footer | Four columns plus long disclosures | None |

### Motion

- [captured] `slow-spin 60s linear infinite` on 2 elements. [inferred] This is the hero orbit ring carrying the
  3D objects: one revolution per minute is below the threshold of "something is moving at me".
- [captured] Transitions are short: `opacity 0.15s` (36 elements), `all 0.15s` (30), colour sets at 0.15 to 0.2s,
  all on `cubic-bezier(0.4, 0, 0.2, 1)`; one `transform 0.5s cubic-bezier(0.22, 1, 0.85, 1)` [inferred: a tab
  indicator or carousel slide with a soft settle].
- [captured] Lottie is present. 60 keyframes exist, almost all belonging to in-app product components
  (chat, modal, bottom sheet, card spin) shipped with the marketing bundle.
- [captured] `preReveal` empty: no scroll-hidden content. 7 `prefers-reduced-motion` rules.
- [captured, screenshot] Tab pill switchers and a carousel with prev/next buttons.
- **Purpose [inferred]:** one ambient motion establishes "an assistant orbiting your life" in the hero; every
  other motion is a fast UI response. Nothing gates reading.

### Copy, line by line

| Line (verbatim) | Role | Words | Punctuation and syntax | Buyer state | Principle | Transferable rule |
|---|---|---|---|---|---|---|
| Introducing Genius. Your personal financial assistant. | H1 | 6 | Two fragments, each closed by a full stop; announcement then definition | Busy, curious | Personification; processing fluency | Name the thing, then define it in a possessive noun phrase |
| Budget, save, invest, and shop smarter with a financial assistant who gets money and things done. | Hero sub | 16 | Verb list with serial comma; "who" makes the product a person | Admin fatigue | Rule of four, anthropomorphism | The sub-line lists the jobs; the headline stays abstract |
| Get started | Hero CTA | 2 | Imperative | Ready to try | Fogg ability | Lowest-commitment verb in the primary pill |
| Sign up | Nav CTA | 2 | Imperative | Returning | Consistency | Nav CTA can differ from hero CTA only if both mean "start" |
| Albert sees your full financial picture. | H2 | 6 | Brand as subject with a perception verb | Wants overview | Agency transfer | Let the product be the subject that does the noticing |
| Create a custom budget, track spending, monitor bills, and find savings. | Tab descriptor | 11 | Four verb phrases | Evaluating features | Chunking | One sentence per tab, verbs only |
| Learn more | Secondary CTA (outlined) | 2 | Imperative | Exploring | Hick (secondary weight) | Secondary actions look different from the primary, every time |
| Unlock the full power of Albert with Genius. | H2 | 8 | Upsell framing; product word in blue | Considering premium | Curiosity | Avoid "unlock"-style verbs; state what changes instead (also banned in Knowvia rule 14) |
| Genius does it for you | Card H2 | 5 | No full stop; "it" is unspecified on purpose | Tired | Effort reduction | A headline can promise less effort without listing the tasks |
| Instantly handle time-consuming tasks. Genius does anything you request, from transferring funds to buying and selling investments. | Card body | 17 | Imperative opener then a "from X to Y" range | Sceptical of scope | Range framing | Show the span of help with two concrete ends |
| Discover Genius in action | Carousel H2 | 4 | Invitation | Curious | Demonstration | Label demos as watching, not reading |
| Securely store important documents. Genius can even break down insurance policies and other financial data. | Feature body | 15 | "even" signals a stretch capability | Has unread documents | Surprise, specificity | Mention the hardest document the product reads, with a plain verb |
| Know where your money’s going | H2 | 5 | Imperative of knowing; contraction | Anxious about leakage | Certainty | Promise knowledge, not control |
| Monitor your spending and cash flow, track your bills, and find savings. | Sub | 12 | Triad | Practical | Rule of three | The sub-line turns the promise into three verbs |
| Plan for life’s big moments | H2 | 5 | "big moments" in blue | Anticipating costs | Future framing | Highlight the outcome phrase, not the feature |
| See how major expenses fit into your budget months in advance. | Sub | 11 | Time horizon "months in advance" | Planner | Specificity | Give the time window the reader gains |
| Do less — and get more from your money — with Genius. | Band H2 | 10 | Paired dashes bracket the gain; less vs more | Effort-averse | Contrast effect | Pair a smaller effort with a larger result in one line (Knowvia cannot use the dashes) |
| Bank, save, and invest seamlessly. | H2 | 5 | "seamlessly" in blue | Wants simplicity | Fluency | Avoid "seamless"; it claims ease without proving it (banned in Knowvia rule 14) |
| Albert is not a bank. Banking services provided by Albert’s bank partners. See disclosures | Disclosure under H2 | 13 | Negative definition first; placed beside the claim it qualifies | Cautious | Transparency as trust | Put the "what we are not" line next to the claim it limits, not only in the footer |
| Protect your accounts | H2 | 3 | Imperative; "Protect" in blue | Fearful of fraud | Agency | Short imperative H2 when the section is a set of safeguards |
| Guard your identity and financial accounts 24/7. Protect yourself against threats and fraud. | Sub | 12 | Two imperatives; "24/7" | Fearful | Loss aversion | Do not promise round-the-clock cover unless it is staffed (Knowvia rule 3) |
| Over 10 million customers trust Albert. | Proof H2 | 6 | Round number; "trust" as the verb | Sceptical | Social proof | One sentence of scale before the numbers |
| 200K+ / 5-star app reviews | Stat | 4 | Light serif numeral, sans label | Sceptical | Processing fluency | Numerals in the display face, labels in the body face |
| $13B+ / Budgeted, tracked, and managed | Stat | 5 | Past-participle triad as label | Wants evidence | Specificity | A stat label can describe actions, not just a noun |
| Sign up in minutes and see what Albert can do for you. | Closing H2 | 12 | Time cost plus "for you" | Convinced | Fogg ability, reciprocity | Close with the time cost and a benefit to the reader |

### First-principles takeaways for Knowvia

- **Borrow** the structure of serif claim over sans explanation, at regular weight and about 1.3 line-height.
  It is already Knowvia's pairing; Albert proves it reads calm at 48 to 58px.
- **Borrow** the "not a bank" move: a short negative definition beside the relevant claim maps to "Knowvia is not
  an insurer" without hiding it in the footer.
- **Borrow** the one-accent-word headline idea sparingly, but Knowvia rule 18 caps highlight use, so use at most
  two on the whole page, or use weight instead of colour.
- **Borrow** the slow ambient hero motion principle (one cycle per minute) only if it has a stated reason; a
  rotating orbit of objects would breach the imagery and calm rules.
- **Avoid** "unlock", "seamlessly" and 24/7 promises, all of which Knowvia's rules already ban.

---

## 3. Monarch (monarch.com), personal finance dashboard

### Type system

Families **[captured]**: `ABC Otto` (serif display, 350) for H1, H2 and press quotes. `ABC Oracle` (sans, 350
and 500, plus a Light 300 cut) for the hero headline, sub-lines, body, buttons and nav. `Beltram Mono` (500) for
uppercase eyebrows. Three families, each with a single job. [captured, screenshot] The hero headline sets
"your money" in a heavier serif inside a light sans line.

| Role | Family | Size px | Weight | Line-height | Tracking | Case |
|---|---|---|---|---|---|---|
| Display (hero H1) | ABC Oracle Light | 59.68 | 300 | 1.15 (68.6) | -1.22px (-0.020em) | Sentence |
| H1 / H2 lead | ABC Otto | 48 | 350 | 1.20 (57.6) | -0.96px (-0.020em) | Sentence |
| H2 section | ABC Otto | 40 | 350 | 1.20 (48) | -0.8px (-0.020em) | Sentence |
| H3 press quote | ABC Otto | 32 | 350 | 1.20 (38.4) | -0.64px | Sentence |
| H5 card title | ABC Oracle | 20 | 350 | 1.40 (28) | normal | Sentence |
| Eyebrow | Beltram Mono | 14 | 500 | 1.30 (18.2) | +0.42px (+0.030em) | UPPERCASE |
| Hero sub | ABC Oracle | 24 | 350 | 1.50 (36) | normal | Sentence |
| Body | ABC Oracle | 18 | 350 | 1.40 (25.2) | normal | Sentence |
| Small | ABC Oracle | 14 / 16 | 350 | 1.30 | normal | Sentence |
| Fine print | ABC Oracle | 13 | 500 | 1.50 | normal | Sentence |
| Button | ABC Oracle | 19 (hero), 18, 14 | 350 | 1.15 to 1.55 | -0.19px (hero) | Sentence |

All [captured].

- **Hierarchy [inferred]:** almost everything is weight 350, so weight is not a hierarchy tool at all. Hierarchy
  comes from size, from family (serif for claims, sans for explanation), and from the mono eyebrow, which is the
  only uppercase, only positive tracking and only accent-coloured text. The eyebrow is a filing label that lets
  long zig-zag rows feel indexed.
- **Display to body ratio:** hero 59.68 / 18 = **3.3**; serif H1 48 / 18 = 2.7 [captured].
- **Mobile H1:** 32px, line-height 38.4px (1.20), tracking -3.2px as reported [captured]. This is the first H1 in
  the DOM ("Your home base for money clarity"), so desktop to mobile for that line is 48 / 32 = **1.50**. The
  hero H1's mobile size was not captured.
- **Pairing logic [inferred]:** a light, wide sans for the hero says "modern tool"; the warm serif for every
  section says "considered, domestic". The mono eyebrow borrows the language of statements and ledgers. The
  promise is clarity, and each family is used for exactly one kind of sentence.

### Colour and ground

| Token | Value | Role | Rough share |
|---|---|---|---|
| Cream ground | rgb(255,250,236) | Page ground [captured, sampled] | ~70% |
| Sand panel | rgb(243,236,215) | Inset rounded panels (features, press) [captured] | ~12% |
| Warm ink | rgb(42,41,38) | Text [captured] | text |
| Coral | rgb(248,103,19) fill; rgb(243,91,22) eyebrows | CTAs, eyebrows, closing band, promo bar gradient [captured] | ~8% |
| White | | Nav bar, cards, secondary pills | ~8% |
| Yellow | | One "syncing" logo panel [captured, screenshot] | trace |

- **Accent discipline [inferred]:** coral appears on filled CTAs, the eyebrow labels, the promo bar and one
  closing band. Body text and headlines are never coral. **Contrast failure [computed]:** white on the coral
  fill is 2.96:1, which fails AA for the 14 to 19px button labels; coral eyebrows on cream are 3.15:1, which
  fails AA for 14px text.

### Layout and rhythm

Content width about 1140px (150 to 1290) [captured, approx.]. Panels and the closing band are inset 16 to 32px
from the viewport edge with rounded corners, so the page reads as a stack of cards on a cream table [captured,
screenshot]. Captured padding: 64 / 96, 32 / 32 (panel), 64 / 128 (zig-zag run), 96 / 96 (community), hero
bottom 32.

| # | Section | Layout family | Imagery |
|---|---|---|---|
| 0 | Promo bar | Full-width coral gradient strip | None |
| 1 | Floating nav | Inset rounded white bar | Logo |
| 2 | Hero | Full-bleed video with dark overlay, left-aligned text | Couple at home (video) |
| 3 | Awards strip | Four laurel-framed proofs in a row | Press logos |
| 4 | "WHAT IS MONARCH?" | Centred eyebrow, H1, paragraph, product video | Product UI video |
| 5 | "Everything you need..." | Inset panel; four tabs in quadrants around a central phone | Phone UI |
| 6 | Feature run (6 rows) | Zig-zag split: eyebrow, serif H2, paragraph vs floating UI cards | Real-looking UI fragments with named people |
| 7 | Syncing | Split with yellow logo panel | Bank logos |
| 8 | Members | 3 x 3 review card grid | Stars |
| 9 | Press | Inset panel: logo column plus one large serif quote | Press logos |
| 10 | Community | Photo plus two cards | Lifestyle photo |
| 11 | Pricing | Split card, text left, photo right | Phone in hand |
| 12 | Closing | Inset coral band, centred white serif, white pill | None |
| 13 | Footer | Five columns | None |

### Motion

- [captured] `preReveal` found 23 elements hidden before scroll: images at `opacity: 0` with
  `scale(1.05)`, and two content blocks at opacity 0. [captured] The matching transitions are
  `opacity 1.5s cubic-bezier(0.075, 0.82, 0.165, 1)` (23 elements), `opacity 2s` (9) and
  `transform, opacity 2s` (8) on the same curve (easeOutCirc). [inferred] Images fade in and settle from 105%
  to 100% over 1.5 to 2s: a very slow, decelerating "developing photograph" reveal.
- [captured] Marquee class present; `scroll` keyframes running `0s linear infinite` on 2 elements at capture
  time [inferred: logo marquee whose duration is set or paused by script].
- [captured] 2 videos (hero and product), neither played in headless.
- [captured, screenshot] The four-quadrant tab block shows one active card and three dimmed ones
  [inferred: auto-advancing tabs].
- [captured] UI transitions 0.15 to 0.3s; 7 `prefers-reduced-motion` rules; one blocked stylesheet.
- **Purpose [inferred]:** slow reveals make each zig-zag row feel like a page being turned; long durations
  match the calm, domestic positioning. The risk is that a 2s fade delays reading for fast scrollers.

### Copy, line by line

| Line (verbatim) | Role | Words | Punctuation and syntax | Buyer state | Principle | Transferable rule |
|---|---|---|---|---|---|---|
| Get 30% OFF Core for one year with code WELCOME* | Promo bar | 9 | Caps on OFF; asterisk | Price-sensitive | Scarcity, anchoring | Keep discounts out of a trust-first page; if used, never above the promise |
| The modern way to manage your money | Hero H1 | 7 | No full stop; "your money" set in serif | Overwhelmed | Contrast of old vs modern (implied) | A category claim works when one phrase is visually owned by the reader |
| Budget, track your progress, and plan for the future—all in one app. | Hero sub | 13 | Triad, then a closed dash that sums it up | Scattered | Rule of three, consolidation | List three jobs, then name the single place |
| Unlock better money habits | Hero CTA | 4 | Benefit-as-button; "unlock" | Motivated | Goal framing | Avoid banned verbs; a CTA can name the habit the reader gains |
| 4.9 stars, 100,000+ reviews | Proof | 4 | Comma joins rating and count [screenshot] | Sceptical | Social proof | Rating and volume in one line |
| Best Overall Budgeting App | Award label (WSJ) | 4 | Title case marks it as a title, not a claim [screenshot] | Wants authority | Authority (Cialdini) | Third-party titles keep their own casing |
| WHAT IS MONARCH? | Eyebrow | 3 | Uppercase mono question | New visitor | Orientation | An eyebrow can ask the question the section answers |
| Your home base for money clarity | H1 / section | 6 | Metaphor, possessive "your" | Wants order | Metaphor fluency | One domestic metaphor, used once |
| Everything you need, all in one app | H2 | 7 | Comma splits scope from place | Comparing apps | Consolidation | Name the consolidation benefit after the definition, not before |
| Know where you stand | Tab title | 4 | Idiom | Uncertain | Certainty | Plain idioms beat feature names in titles |
| Make smart money moves together | Tab title | 5 | "together" names the couple | Shares money | Shared ownership | Name the second person in the household explicitly |
| Set goals (and crush them) | Tab title | 5 | Parenthetical aside adds voice | Ambitious | Liking | One parenthetical joke per page at most, never on serious content |
| All your accounts, in one place | Row H2 | 6 | Comma pause before the place | Scattered | Consolidation | Feature H2: scope, comma, place |
| Every transaction in one list | Row H2 | 5 | No verb | Wants overview | Specificity | Concrete noun plus one container |
| Take control of your subscriptions | Row H2 | 5 | Imperative | Leaking money | Agency | Give the reader the verb |
| Your goals, on track | Row H2 | 4 | Possessive noun, comma, state | Planner | Endowment | Possessive plus a status word reads as reassurance |
| On every device, always in sync | Row H2 | 6 | Two adverbial phrases | Multi-device | Fluency | Availability lines can be verbless |
| Best-in-class data connectivity | Row H2 | 3 | Superlative compound | Technical | Authority | Superlatives need a number in the body (they give 13,000+) |
| What our members say | Proof H2 | 4 | "members" not "users" | Sceptical | Belonging | Name customers with a relationship word |
| “Because of this app, I feel like I am not winging it financially anymore and feel on top of my spending.” | Review | 20 | Curly quotes; feeling words | Anxious | Social proof, emotion | Pick quotes that describe the feeling after, not the feature |
| App Store Review | Attribution | 3 | Source, no name | Sceptical | Source credibility | Every quote states where it came from |
| Community resources | H2 | 2 | Label | Engaged | Belonging | Labels are fine for utility sections |
| Try Monarch free for 7 days | Pricing H2 | 6 | Number as numeral | Price-sensitive | Risk reversal | State the trial length as a numeral |
| Collaborate with your partner or advisor at no extra cost. | Pricing body | 10 | "no extra cost" closes the sentence | Couples | Loss aversion | Put the removed cost at the end of the sentence |
| View pricing | Pricing CTA | 2 | Verb plus noun | Evaluating | Fogg ability | A section-specific CTA is allowed when it names its destination |
| Track, budget, and feel good about your money with Monarch in your corner. | Closing H2 | 13 | Two task verbs then a feeling; "in your corner" | Convinced | Emotional peak-end | End on a feeling after the tasks |
| Get started today | Closing CTA | 3 | Adds "today" | Ready | Urgency (mild) | Keep top and bottom CTA wording identical (Monarch does not, which Knowvia rule 15 forbids) |

### First-principles takeaways for Knowvia

- **Borrow** the household framing: Monarch names the partner in copy and shows two named people in UI. Knowvia's
  household operator needs the same "together" signal, with per-person permission visible.
- **Borrow** the mono or small-caps eyebrow as a filing label for long feature runs, but set it in Source Sans 3
  (two-family rule) with positive tracking around +0.03em.
- **Borrow** inset rounded panels on a warm ground as the way to group sections without hard full-bleed bands.
- **Avoid** the coral contrast failures: Harbour must clear 4.5:1 with its label text, and eyebrows must too.
- **Avoid** 1.5 to 2s image reveals with scale; they delay reading for older readers. If any reveal is used,
  keep it under about 400ms, opacity and small translate only, and disable it under reduced motion.

---

## 4. Kikoff (kikoff.com), credit builder

### Type system

Families **[captured]**: `DM Sans` (300 to 700) for everything on the page except testimonials. `Raleway` (700)
for testimonial text. `Inter` is loaded but not seen in the ramp. The hero mark is a lime plus glyph after the
full stop [captured, screenshot]; the H1 text reads "Tap into better credit.df", where "df" is
[inferred] an icon-font ligature for that glyph.

| Role | Family | Size px | Weight | Line-height | Tracking | Case |
|---|---|---|---|---|---|---|
| Display (H1) | DM Sans | 68 | 600 | 1.20 (81.6) | -4px (-0.059em) | Sentence |
| Stat numeral | DM Sans | not captured (tile text in divs) | ~600 [screenshot] | | | n/a |
| H2 section | DM Sans | 49 | 500 | 1.31 (64) | -0.735px (-0.015em) | Sentence |
| H2 factor | DM Sans | 40 | 400 | 1.10 (44) | -1.6px (-0.040em) | Sentence |
| Hero sub | DM Sans | 28 | 300 | 1.00 (28) | -0.5px | Sentence |
| Eyebrow | "Step 1" lime chip | not captured | ~600 [screenshot] | | | Title case |
| Lead paragraph | DM Sans | 32 | 300 | 1.20 | -0.5px | Sentence |
| Body (steps) | DM Sans | 20 | 300 | 1.20 (24) | -0.5px | Sentence |
| Body (FAQ, microcopy) | DM Sans | 18 | 400 | 1.56 (28) | -0.5px | Sentence |
| Testimonial | Raleway | 16 | 700 | 1.40 | -0.5px | Sentence |
| Fine print | DM Sans | 15 | 300 | 1.80 (27) | -0.04px | Sentence |
| Button (hero) | DM Sans | 20 | 500 | 1.70 (34) | -1px | Sentence |

All [captured] unless marked.

- **Hierarchy [inferred]:** weight runs light to heavy in the opposite direction from most sites: light 300 for
  sub-lines and body, 500 to 600 only for claims. The H1 has extreme negative tracking (-0.059em), which makes it
  a dense logotype-like block. Bold inside light body text marks the claim words ("no credit check", "starting
  at $5/mo") [captured, screenshot]. Numbers are the real display type: "+86pts" is visually larger than the H1.
- **Display to body ratio:** 68 / 20 = **3.4** [captured]; against 18px microcopy it is 3.8.
- **Mobile H1:** 44px, line-height 48.4px (1.10), tracking -2px [captured]. Desktop to mobile = **1.55**.
- **Pairing logic [inferred]:** one geometric sans says "simple, fast, numeric". Raleway bold for testimonials is
  a deliberate break to make customer voice look different from company voice.

### Colour and ground

| Token | Value | Role | Rough share |
|---|---|---|---|
| White | rgb(255,255,255) | Ground [captured] | ~60% |
| Tile grey | rgb(238,239,238) | Bento tiles, step cards, Log In pill [captured] | ~10% |
| Lime | rgb(181,252,79) | Stat tile, plus glyph, Sign Up pill, one full band, pricing buttons, footer links on black [captured] | ~12% |
| Near-black | rgb(19,20,19) / rgb(0,0,0) | Hero CTA, bento tiles, bureau card, testimonial cards, footer [captured] | ~15% |
| Muted ink | rgb(81,82,81), rgb(100,101,100) | Sub-lines, microcopy; 7.85:1 and 5.85:1 on white [computed] | text |

- **Accent discipline [inferred]:** lime is never text on white (it would fail contrast). It appears as a fill
  under black text (12.9:1 [computed]) or as text on black (footer links, bureau keywords). The primary hero CTA
  is black, so lime marks proof and score, while black marks action. That split is the clearest accent rule in
  this group.

### Layout and rhythm

Bento width about 1258px (85 to 1343); step cards about 1332px [captured, approx.]. Captured padding: hero
140 / 60; then 34 / 34, 40 / 40, 60 / 60, lime band 80 / 40, pricing 60 / 60, testimonials 20 / 60, closing
60 / 60. Tighter than the other three sites.

| # | Section | Layout family | Imagery |
|---|---|---|---|
| 1 | Hero | Centred stack with microcopy under the CTA | None |
| 2 | Proof bento | Asymmetric bento: lime stat, black stat, grey claim, phone, price, gauge | Phone UI, gauge |
| 3 | Rating and press | Centred laurel rating, "Featured in:" logo row with faded edges | Press logos |
| 4 | Bureaus | Black card left; scroll-linked headings right [inferred] | Bureau logos on a lime staircase |
| 5 | How it works | Three tall cards with Step chips and phones | Phone UI |
| 6 | More ways | Full-bleed lime band, card carousel with arrows and dots | Feature UI |
| 7 | Plans & pricing | Three price cards with a guarantee chip | None |
| 8 | Testimonials | Black cards with portraits | Portraits |
| 9 | FAQ | Accordion | None |
| 10 | Closing | Centred H2, lime stat tile, black CTA, microcopy | None |
| 11 | Footer | Black, lime links, long fine print | None |

### Motion

- [captured] Webflow Interactions present (`data-w-id`), Lottie present. No GSAP or Lenis.
- [captured] Transitions are short and plain: `all 0.2s ease` (42), `opacity, transform 0.2s ease` (37),
  `color 0.3s ease` (19), `background-color, color 0.1s` (16), and slower `background-color 0.625s` (2).
- [captured] Only `spin` keyframes; no running CSS animations. `preReveal` empty. 0 reduced-motion rules found,
  but 2 stylesheets were blocked, so this is not conclusive.
- [captured] Several headings ("The most-loved credit builder.", "Build credit, fast.", the three factor
  headings, "How it works") exist in the DOM at their positions but are blank in the full-page screenshot.
  [inferred] Webflow scroll interactions animate them in, and the right column beside the bureau card is a
  scroll-linked swap of three factor headings.
- [captured] The hero CTA text is duplicated ("Build credit fast Build credit fast"), and the mobile screenshot
  shows two stacked labels mid-transition. [inferred] A text-roll hover: the label slides up and an identical
  copy slides in.
- [captured, screenshot] Feature carousel with arrows and dots; press logos fade at the row edges
  [inferred: a logo marquee].
- **Purpose [inferred]:** fast 0.2s feedback says "responsive app"; scroll-linked headings teach the three
  credit factors one at a time. The text-roll CTA is decoration.

### Copy, line by line

| Line (verbatim) | Role | Words | Punctuation and syntax | Buyer state | Principle | Transferable rule |
|---|---|---|---|---|---|---|
| Tap into better credit. | H1 | 4 | Full stop, then a lime plus glyph as a visual "+" | Shut out | Brevity, brand glyph | A four-word H1 can carry the whole promise if the next line explains it |
| Credit-building & financial tools, made easy. | Hero sub | 5 | Ampersand compresses; comma then "made easy" | Intimidated | Processing fluency | The sub-line names the category and the ease in one clause |
| Build credit fast | Hero CTA | 3 | Verb plus outcome, no full stop | Motivated | Goal-gradient | A CTA can be the outcome, not the mechanism |
| No Credit Check. No interest. | CTA microcopy | 5 | Two fragments; title case on "Credit Check" | Fearful of rejection | Risk reversal | Put the two biggest fears, negated, right under the button |
| +86pts* | Stat tile | 1 | Plus sign and asterisk frame the number | Wants proof | Specificity, anchoring | A number with a footnote marker beats an adjective |
| on avg for users with starting credit under 600 in a year with on time payments | Stat label | 16 | Lowercase, abbreviated "avg"; full conditions | Sceptical | Honesty about conditions | Conditions sit directly under the number they limit |
| 80M+ total points increased2 | Stat | 4 | Footnote numeral | Sceptical | Social proof | Aggregate numbers need a footnote that explains the count |
| One tap. Score big.1 | Bento claim | 4 | Two fragments, rhythm 2 + 2 | Wants ease | Rhythm, effort reduction | Two two-word fragments make a slogan; use once |
| Plans start at $5 /month1 | Price tile | 5 | Price in display size | Price-sensitive | Anchoring | Show the lowest real price early, with its footnote |
| 4.9 App store rating | Proof | 4 | Numeral plus star, laurels | Sceptical | Authority | One rating, framed, centred |
| Featured in: | Label | 2 | Colon introduces logos | Sceptical | Authority | A colon label is enough for a logo row |
| The most-loved credit builder. | H2 | 4 | Superlative; full stop | Comparing | Social proof | Superlatives need proof in the same view |
| Since 2019, we've helped millions of people just like you take control of their financial future. | Lead | 16 | Year first; "just like you" | Doubting it works for them | Similarity, tenure | State tenure and similarity before the mechanism |
| Kikoff plans1 report to all three credit bureaus which can help improve your payment history, utilization, and account age. | Mechanism | 19 | Lime bold on four key terms; "can help" hedges | Wants to understand | Mechanism disclosure | Explain how it works in one sentence and bold the named levers |
| Build credit, fast. | H2 | 3 | Comma and full stop slow the reading | Motivated | Rhythm | Punctuation can slow a fast promise into a considered one |
| Build payment history | Factor H2 | 3 | No full stop; imperative | Learning | Chunking | Teach one factor per heading |
| How it works | H2 | 3 | Label | Wants steps | Expectation setting | A plain label before steps |
| Sign up in minutes with no credit check. No hidden fees or interest. | Step 1 | 13 | Bold on the negations | Wary | Risk reversal | Each step names its cost in time and money |
| More ways to score1, all in one place. | Band H2 | 7 | Comma splits benefit from place; pun on "score" | Engaged | Consolidation | One light wordplay line per page at most |
| Plans & pricing | H2 | 3 | Ampersand in a label | Evaluating | Transparency | Show price on the home page |
| 45 days money back guarantee4 | Pricing chip | 5 | Footnote numeral | Risk-averse | Risk reversal | Put the guarantee beside the price, with terms |
| Trusted and loved by our customers | H2 | 6 | Paired verbs | Sceptical | Social proof | Proof headings can be plain |
| My credit was in the 400s.... I didn't even know credit could go that low. Now it's in the 600s. Don't even think about it, just sign up. | Testimonial | 30 | Unedited voice, before and after numbers | Ashamed | Authenticity, before-after | Real phrasing with a before and after number is more credible than polished copy |
| Have questions? | FAQ H2 | 2 | Question | Hesitant | Objection handling | Invite questions before the close |
| You do not get money back after completing your Kikoff Credit Service1 plan, it is not a credit builder loan. | FAQ answer | 19 | Starts with the negative answer | Confused | Candour | Answer the uncomfortable FAQ with the "no" first |
| Ready to score? | Closing H2 | 3 | Question | Convinced | Commitment | A closing question works when the stat below answers it |

### First-principles takeaways for Knowvia

- **Borrow** the microcopy-under-CTA pattern: two negated fears right under the button. For Knowvia these would be
  operational fears (no selling, no sharing without permission), written in Knowvia's own words.
- **Borrow** "conditions under the number": any Knowvia figure gets its evidence ID and condition directly
  beneath it, in body size, not in a footnote zone.
- **Borrow** the accent split: proof colour and action colour are different jobs. Knowvia already assigns action
  to Harbour; Signal Gold must stay limited to focus and at most two highlights.
- **Borrow** "answer the uncomfortable FAQ with the no first", for example what Knowvia does not do with a claim.
- **Avoid** the -0.059em display tracking, lime-on-white energy, puns on scores and the text-roll CTA; all read as
  speed and play rather than calm.

---

## Cross-site: consumer fintech group

### Shared type moves

- **Display to body ratios sit between 2.7 and 4.0** (Albert 3.2, Monarch 3.3, Kikoff 3.4, EarnIn 4.0)
  [captured]. The calmer the site, the lower the ratio. Knowvia at 56 to 64px over 18px body lands at 3.1 to 3.6.
- **Mobile H1 shrinks by 1.5 to 1.9x** (Monarch 1.50, Kikoff 1.55, Albert 1.61, EarnIn 1.90) [captured]. Mobile
  H1s are 32 to 44px.
- **Negative tracking scales with size and weight**: -0.005em (EarnIn heavy) to -0.02em (Monarch light) on
  display; Kikoff's -0.059em is the outlier. Body tracking is normal or close to it on every site.
- **Display line-height runs 1.15 to 1.30**; the serif sites sit at the loose end (Albert 1.30 desktop).
- **Weight is not the main hierarchy tool on the calm sites**: Albert and Monarch hold display at 300 to 400 and
  build hierarchy from size and family switch. The energetic sites (EarnIn, Kikoff) use 600 to 800.
- **Serif for claims, sans for explanation** (Albert, Monarch). Uppercase appears only as a small mono eyebrow
  (Monarch); no site uses uppercase headlines.
- **Bold inside body text is reserved for the claim words** (EarnIn quotes, Kikoff steps and bureau line).

### Motion vocabulary

- **Fast UI response is universal**: 0.15 to 0.3s on colour, background and transform, with the standard
  `cubic-bezier(0.4, 0, 0.2, 1)` or `ease` [captured on all four].
- **At most one ambient loop**: Albert's 60s orbit, EarnIn's 22.2s sweep on the AI button [captured]. Both are
  slow enough to read as atmosphere.
- **Scroll reveals split the group**: Monarch hides 23 elements and reveals them over 1.5 to 2s with easeOutCirc
  and a 1.05 to 1 scale; Kikoff animates headings with Webflow interactions; EarnIn and Albert hide nothing
  [captured]. Content-first sites do not make the reader wait.
- **Carousels and tab switchers** appear on all four; marquee logo rows on Monarch and probably Kikoff.
- **Reduced motion is uneven**: 7 rules (Albert, Monarch), 1 (EarnIn), none found (Kikoff) [captured].
  Knowvia's rule 23 requires all motion off under reduced motion, which is stricter than any of these.

### Copy cadence patterns

- **Hero H1s are 4 to 7 words** (Kikoff 4, Albert 6, EarnIn 7, Monarch 7) and each has a different syntax:
  question (EarnIn), two fragments (Albert), noun phrase (Monarch), imperative (Kikoff).
- **The sub-line does the listing**: a triad or quartet of verbs with a serial comma (Albert, Monarch, EarnIn
  perks), keeping the H1 abstract.
- **Section H2s drop the full stop when they are labels** ("Perks that take your money further", "Every
  transaction in one list") and keep it when they are claims ("Albert sees your full financial picture.").
- **Negations near the action**: "No Credit Check. No interest.", "we never sell your personal information",
  "Albert is not a bank." Every site puts a "not" line close to the decision.
- **Closings echo the opening**: EarnIn returns to "waiting", Kikoff returns to its stat, Albert and Monarch
  return to the reader ("for you", "in your corner"). Only EarnIn and Kikoff keep the CTA wording close
  to identical top and bottom.
- **Proof grammar is figure first, label second**, and the strongest sites put the condition right under the
  figure (Kikoff).

### Five strongest principles for Knowvia (summary)

1. Serif states the claim, sans explains it; keep display at regular weight, 1.2 to 1.3 line-height, about
   -0.01em tracking, and a display to body ratio near 3.2.
2. One colour means "act", a different, rarer colour means "notice"; never let the action colour decorate.
3. Motion answers input in 0.15 to 0.3s; at most one slow ambient element; nothing hides content before scroll.
4. Put the "what we are not" line and the two biggest operational fears, negated, right beside the CTA.
5. Every figure sits above its condition and source in body size, so the reader never has to hunt for the
   catch.
