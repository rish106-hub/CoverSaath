# CP1 reference teardown: Indian insurance (Loop Health, Acko)

Checkpoint: CP1, research specialist. Scope: typography, design language, copy, motion, trust and compliance devices,
reverse engineered from first principles for Knowvia ("Know your cover. Before you need it.").

## Method and evidence labels

- Capture tool: `capture.mjs` (Playwright), desktop 1440 x 900 and mobile 390 x 844 at 2x, locale en-IN, run 13 Oct 2026.
- **Loop Health** (https://www.loophealth.com/): captured, HTTP 200, 86 copy lines, 26 type combinations, page height 7531px.
- **Acko** (https://www.acko.com/): captured, HTTP 200, 118 copy lines, 9 type combinations, page height 4488px. The hero
  carousel rendered this time (the earlier research caveat about a blank hero no longer applies). The copy extractor
  mostly picked up `h1` to `h4`, `p`, `a` and `button`; many Acko lines live in `div` and `span`, so those lines were
  read from the screenshots. 17 Acko stylesheets were cross-origin and unreadable, so keyframes and
  `prefers-reduced-motion` rules on Acko could not be counted.
- **[captured]** = computed value from `capture.json` or a value read directly off a screenshot (marked "screenshot"
  where it matters). **[inferred]** = my reading of intent or mechanism. Pixel values from screenshots are approximate.
- Every quoted line is the site's own copy, used only as analysis evidence. Transferable rules are abstract; none of
  these lines should be copied or paraphrased into Knowvia.

---

## 1. Loop Health (employer health insurance, B2B2C)

### 1.1 Type system

One family: **Work Sans** at 400, 500, 600, 700 [captured: fontsLoaded]. No serif anywhere. Hierarchy is built from size
and negative tracking, with weight held mostly at 600.

**The ramp is an integer multiple of one fluid base unit.** At 1440px every size is a multiple of 13.86px
(= 0.9625vw): 69.3 = 5x, 55.44 = 4x, 41.58 = 3x, 27.72 = 2x, 17.30 = 1.25x, 14.86 = 1.07x [captured values;
the vw-based Webflow scaling is inferred from the ratios]. The whole page therefore scales with the viewport rather
than stepping at breakpoints.

| Role | Family | Size px (1440) | Weight | Line height (ratio) | Tracking | Case | Evidence |
|---|---|---|---|---|---|---|---|
| Display (H1) | Work Sans | 69.3 | 700 | 1.10 | -2.772px (-0.04em) | Sentence | [captured] |
| H2 | Work Sans | 55.44 | 600 (700 on the closing H2) | 1.08 | -2.218px (-0.04em) | Sentence | [captured] |
| Pull quote | Work Sans | 41.58 | 500 | 1.10 | -0.04em | Sentence | [captured] |
| H3 / stat numeral | Work Sans | 27.72 | 500 | 1.18 | -0.04em | as numerals | [captured] |
| H3 (list item, card title) | Work Sans | 17.30 | 400 to 500 | 1.25 to 1.6 | -0.022em | Sentence | [captured] |
| Eyebrow / section label | Work Sans | 17.30 (set as an `h2`) | 400 | 1.40 | -0.04em | Sentence | [captured] "Customers transforming employee health" |
| Body (lead) | Work Sans | 17.30 | 400 | 1.60 | -0.021em | Sentence | [captured] |
| Small body | Work Sans | 14.86 | 400 | 1.30 or 1.60 | -0.025em | Sentence | [captured] |
| Footer column head | Work Sans | 14.41 | 500 | 1.34 | -0.022em | Authored ALL CAPS (no `text-transform`) | [captured] |
| Button | Work Sans | 13.86 | 600 (primary), 500 (secondary) | 1.6 | -0.02em | Title Case | [captured] |
| Tab label | Work Sans | 11.09 | 500 | 1.25 | -0.033em | Title Case | [captured] |
| Fine print (legal) | Work Sans | 12.09 | 400 | 1.60 | -0.031em | Sentence | [captured] |
| IRDAI licence block | Work Sans | about 9 to 10 (screenshot) | 400 to 500 | about 1.8 | n/a | Sentence | [captured, screenshot] |

- **How hierarchy is built:** size jumps of whole multiples (5x, 4x, 3x, 2x) plus tight negative tracking on
  everything above 27px (-0.04em). Colour also separates levels: H1 in cream #F1EEDB on green, H2 in brand green
  #025F4C on light ground, body in near-black #182422. [captured]
- **Display to body ratio:** 69.3 / 17.30 = **4.0**. H2 to body = 3.2. [captured]
- **Mobile H1:** 46.8px, line height 1.10, tracking -1.872px (-0.04em). Desktop to mobile = **1.48**. The mobile H1 wraps
  to three lines and shows a dark offset text shadow that is not visible at desktop. [captured, screenshot]
- **Two-tier H2:** "Loop's Mission" and "20+ healthy years for India's workforce" sit in one `h2`, with the second line
  visibly smaller (about 40px, screenshot). A label and a claim share one heading. [captured text, inferred structure]
- **Rupee numbers:** the home page sets no rupee figures at all. Scale numbers use Western shorthand ("950k+",
  "100k+", "1250+") rather than lakh or crore, in 27.72px 500 numerals over a 14px grey label. [captured] The choice
  reads as B2B and investor-facing rather than household-facing. [inferred]
- **Fine print:** the broker line is 12.09px white on #1B1A1F; the IRDAI licence block is smaller still, right-aligned,
  in the bottom-right of the footer. [captured]

### 1.2 Colour and ground

| Token (observed) | Value | Role | Rough share | Evidence |
|---|---|---|---|---|
| Forest green | #025F4C | Hero ground, H2 colour, testimonial and "Why Loop" panels, button text | 25% | [captured] |
| Cream | #F1EEDB (text), #F9F7F2 / #F6F3EA (grounds) | H1 colour on green; alternate section grounds | 25% | [captured] |
| Cool off-white | about #F8F8FA | Page ground under logo and stat strip | 20% | [captured, screenshot pixel] |
| White | #FFFFFF | Stat cards, product cards, body text on green | 10% | [captured] |
| Lime | #BCDD33 | Primary CTA fill only (text #025F4C, 4.93:1) | under 3% | [captured] |
| Sun yellow | about #FDD506 | Closing CTA card only (green text on it, 5.36:1) | 5% | [captured, screenshot pixel] |
| Ink | about #1B1A1F | Footer | 8% | [captured, screenshot pixel] |
| Rainbow stripe | yellow, violet, coral | One curved ribbon behind the hero photo collage | under 2% | [captured, screenshot] |

- **Accent discipline:** lime is reserved for primary buttons and a few icon dots; it never colours text on light
  ground. Yellow appears once, as the closing card. The secondary action is always an outlined button in green or white.
  [captured]
- **Contrast faults:** the cookie banner body (#7F8785 on white) is 3.68:1, which fails AA for 14px text. [captured]
  Large grey lead text in the mission block is also low contrast because it is mid-reveal (see Motion). [captured]

### 1.3 Layout and rhythm

| # | Section (y px) | Layout family | Ground | Evidence |
|---|---|---|---|---|
| 1 | Floating nav bar (0) | White rounded bar inset from edges, logo left, links, outline + lime buttons right | White on green | [captured] |
| 2 | Hero (0 to 724) | Centred stack: H1, two-line sub, two buttons; photo collage of seven rounded tiles straddling the fold, rainbow ribbon behind | Green, bleeding into off-white | [captured] |
| 3 | Logo strip + stats (945 to 1435) | Centred label, horizontal logo row cut off at the right edge, four equal white stat cards | Off-white | [captured] |
| 4 | Mission (1436 to 2289) | Centred two-tier H2, then a 50/50 split: manifesto card left, two paragraphs and CTA right | Cream gradient with faint radial rays | [captured] |
| 5 | Product (2089 to 3188) | Centred H2, then a split: accordion list of benefits left, dashboard screenshot right | White with dot texture | [captured] |
| 6 | HR hassles (3187 to 3835) | Zig-zag: dashboard image left, H2, sub, CTA, tab carousel right | Cream #F9F7F2 | [captured] |
| 7 | Culture (3835 to 4547) | Zig-zag reversed: H2, lead, four icon metrics left, hand-held phone right | White | [captured] |
| 8 | Testimonials (4547 to 5162) | Hard split: green half with H2 and pixel motif, cream half with large quote carousel | Green / cream | [captured] |
| 9 | Why Loop (5163 to 5726) | Hard split: photo left, green panel right with three icon rows | Photo / green | [captured] |
| 10 | Resources (5725 to 6453) | Editorial blog grid: one large feature plus three stacked items | Off-white | [captured] |
| 11 | Closing CTA (about 6450 to 6913) | Rounded yellow card overlapping the dark footer; photo left, H2, sub, white button right | Yellow on ink | [captured] |
| 12 | Footer (6913 to 7531) | Logo and helpline top, four link columns, newsletter, broker line left, IRDAI block right | Ink | [captured] |

- **Grid and width:** content runs from about x 188 to x 1252, a **1064px** container; the nav bar is about 1114px.
  [captured, screenshot] Both scale with the viewport. [inferred from the vw ramp]
- **Section padding:** every `section` reports 0px top and bottom padding; spacing lives on inner wrappers and was not
  captured. Visible gaps between sections are roughly 100 to 140px at 1440. [captured 0px; gap read from screenshot]
- **Alignment:** centred for hero, mission and section openers; left-aligned for every reading block; zig-zag in 6 and 7.
  [captured]
- **Imagery:** real photographs of Indian families and colleagues (hero collage, closing scooter couple), product
  dashboards, a hand holding a phone, a stock-style laptop consultation. Icons are small, round and pastel. [captured]

### 1.4 Motion

| What moves | How | Purpose | Evidence |
|---|---|---|---|
| Libraries | GSAP + ScrollTrigger, Lottie, Swiper, Webflow Interactions | Scroll scenes, icon animation, carousels | [captured: libs] |
| Signature easing | `cubic-bezier(0.165, 0.84, 0.44, 1)` (ease-out-quart) at 0.3s, 0.32s, 0.5s, 0.6s, 0.7s, 0.75s | Fast start, long soft settle; one easing across the page | [captured: transitions] |
| Scroll-linked text fill | Mission paragraph sits at opacity 0.5 before reveal; screenshot shows paragraph one grey and paragraph two full black | Paces reading of the manifesto line by line | [captured: preReveal opacity 0.5; scrub behaviour inferred] |
| Hero photo collage | Tiles captured rotated 40 degrees and 20 degrees, and one translated 95px on Y before reveal | Collage assembles or settles as the page loads or scrolls | [captured: preReveal transforms; choreography inferred] |
| Accordion (benefit list) | min-height and height 0.7s, background 0.5s, ease-out-quart | Opens one benefit at a time | [captured] |
| Hover on buttons and links | opacity, transform, colour 0.2s to 0.24s ease; border and background 0.3s ease-out | Quiet affordance | [captured] |
| Testimonial cards | keyframes `float-testimonial-1`, `float-testimonial-2` | Gentle idle float on quote cards | [captured: keyframe names; amplitude not captured] |
| Loader | keyframe `spin` | Loading state | [captured] |
| Logo row | Row is cut at the right edge; no marquee library detected | Likely a CSS or GSAP horizontal drift | [inferred] |
| Carousels | Swiper on testimonials and HR tabs, with arrow controls | User-driven, not autoplay as far as visible | [captured lib; autoplay not verified] |

- **Reduced motion:** one `prefers-reduced-motion` rule exists in readable CSS; its scope was not captured, and GSAP
  scenes are JS-driven, so they may ignore it. [captured count; coverage inferred]

### 1.5 Copy, line by line

| # | Line (verbatim) | Role | Words | Punctuation and syntax | Buyer state targeted | Principle | Transferable rule |
|---|---|---|---|---|---|---|---|
| 1 | "Claims Helpline" | Nav secondary button | 2 | Title Case noun phrase, no verb | Existing member in a claim | Recognition over recall | Put the panic route in the header, named as a noun people already search for |
| 2 | "Request a Demo" | Nav primary CTA | 3 | Title Case imperative | HR buyer, evaluating | Commitment ladder (low step) | Primary CTA names the next meeting, not the purchase |
| 3 | "Healthcare & insurance made easy" | H1 | 4 + "&" | Ampersand fuses two categories into one object; no full stop, so it reads as a banner | HR lead tired of juggling vendors | Category fusion, simplicity promise | A headline can merge two things the buyer manages separately into one job |
| 4 | "Not just for sick days!" | Sub-line, line 1 | 5 | Fragment plus exclamation: the only shout on the page, signals optimism | Sceptic who sees insurance as a cost | Reframe by negation | Lead the sub-line with what the category is assumed to be, then deny it |
| 5 | "An insurance plan that works to keep you healthy." | Sub-line, line 2 | 9 | Full sentence with full stop, calm after the exclamation | Same | Benefit in plain clause | Follow a punchy fragment with one plain sentence that carries the actual meaning |
| 6 | "Request Demo" | Hero CTA | 2 | Article dropped versus nav ("Request a Demo") | HR buyer | Consistency (broken) | Keep CTA wording identical in every slot; drift weakens recognition |
| 7 | "Customers transforming employee health" | Logo-strip label | 4 | Participle phrase, no full stop, set in body size | Buyer checking peers | Social proof (Cialdini) | Label a proof strip with what peers are doing, not with "trusted by" |
| 8 | "950k+" / "Happy Members" | Stat | 1 + 2 | Western "k" with plus; label in Title Case | Buyer sizing the vendor | Authority via scale | Figure large, label small; the plus sign marks a floor, not an exact count |
| 9 | "100k+" / "Claims Passed" | Stat | 1 + 2 | "Passed" not "settled": exam metaphor | Buyer worried about rejection | Outcome proof | Name the outcome the buyer fears losing, in their own verb |
| 10 | "4.8/5" / "App Rating" | Stat | 1 + 2 | Ratio form, no star glyph | User-experience check | Social proof | Pair one usage proof with scale proofs |
| 11 | "Loop's Mission" | H2 label | 2 | Possessive, Title Case, no punctuation | Buyer asking "who are you" | Identity before offer | A short label can introduce a purpose block |
| 12 | "20+ healthy years for India's workforce" | H2 claim | 6 | Numeral first; plus sign; national scope word | Buyer who wants purpose to sell internally | Big, vivid goal | Lead a purpose claim with a concrete unit people can picture |
| 13 | "A new vision for India's workforce—healthier, longer lives powered by preventive care, not just treatment when you're sick." | Mission lead | 19 | Em dash to expand; "not just" repeats the hero frame | Same | Repetition of the core frame | Repeat the hero's reframe once, lower down, in long form |
| 14 | "It's a call to reimagine insurance and healthcare as a system that gives people more time to be with loved ones, to do meaningful work, and to chase lifelong dreams." | Mission body | 30 | Triad ("to be", "to do", "to chase") with serial comma | Emotional buyer | Rule of three, aspiration | A triad of human outcomes gives rhythm; keep it under 20 words for Knowvia's rule |
| 15 | "THE LOOP MANIFESTO" | Card title (image) | 3 | All caps, set as an artefact | Buyer looking for conviction | Branded artefact | Turn a belief into a named object the reader can open |
| 16 | "Read the Manifesto" | CTA | 3 | Imperative, Title Case | Curious reader | Low-ability ask (Fogg) | A reading CTA is a low-commitment step that sits beside the main CTA |
| 17 | "Give your team the best care" | H2 | 6 | Imperative with "your"; superlative unproven | HR buyer | Ownership framing | Address the buyer's responsibility for others, in second person |
| 18 | "Competitive rates from the most trusted insurers." | Card sub | 7 | Full stop; vague superlatives ("most trusted") | Price-checking buyer | Authority by association | Avoid unsourced superlatives; name the mechanism instead |
| 19 | "Access 24/7, free virtual consults with Medical Experts." | Benefit row | 8 | Comma after "24/7"; capitalised "Medical Experts" for status | Employee benefit evaluator | Availability plus price anchor (free) | Lead each benefit row with the verb the user will do |
| 20 | "Yoga, pilates, zumba, nutrition, sleep and much more!" | Benefit row | 8 | List plus exclamation, no serial comma here | Culture-minded buyer | Variety signal | Lists signal breadth; one list per page is enough |
| 21 | "Focused chronic care programs for diabetes, hypertension, maternity, elder care, and much more." | Benefit row | 13 | Serial comma here (inconsistent with line 20) | Buyer with older or chronic staff | Specificity | Name real conditions or situations to show coverage depth; keep comma style consistent |
| 22 | "Design policy strategies to empower teams, drive productivity, and boost employee happiness." | Benefit row | 12 | Triad of verbs; "empower" is a banned word for Knowvia | HR strategist | Outcome stacking | Stack at most three outcomes and use concrete verbs |
| 23 | "HR hassles gone for good" | H2 | 5 | Alliteration ("HR hassles"), no verb tense, no full stop | Operationally tired HR | Name the pain | Name the operational pain in the reader's own word |
| 24 | "Use solutions to manage your benefits effectively" | Sub | 7 | Generic nouns ("solutions") | Same | (weak) | A sub-line must add a mechanism, not restate the headline abstractly |
| 25 | "Build a culture of wellbeing" | H2 | 5 | Imperative, abstract noun | HR leader with culture goals | Aspiration | Headline verbs should be things the reader can actually start today |
| 26 | "Improve productivity and reduce your health insurance premiums by implementing a scientifically tested preventive healthcare setup." | Lead | 16 | Long noun stack; "scientifically tested" unsourced | CFO-minded buyer | Money outcome | Put the money outcome first and cite the method or drop the adjective |
| 27 | "80%+ increase in health engagement" | Metric | 5 | Percent plus floor sign; no source shown | Data-minded HR | Quantified outcome | Any percentage needs a source line nearby |
| 28 | "20% NPSF for your employer brand and retention" | Metric | 8 | Apparent typo ("NPSF") left live | Same | (fault) | Proofread every number line; a typo next to a number erodes the number |
| 29 | "Reduce premiums by 10% by keeping your team healthy" | Metric | 9 | Imperative plus mechanism ("by keeping") | CFO-minded buyer | Cause and effect | Pair a claimed result with the cause in the same line |
| 30 | "Spend less time managing endorsements and claims" | Metric | 7 | Plain imperative; uses insurance jargon "endorsements" correctly | HR admin | Name the chore | Use the domain word the operator uses daily, even if jargon |
| 31 | "Don't just take our word for it." | H2 (testimonials) | 7 | Full stop on an H2: the only H2 that ends with one; conversational | Sceptic | Social proof handoff | A full stop on a heading makes it sound spoken rather than announced |
| 32 | "Here are some of our success stories from our customers." | Sub | 10 | "our" twice; filler | Same | (weak) | Cut sub-lines that only announce what follows |
| 33 | "Loop's wellness sessions are a super hit with our team!" | Pull quote, 41.58px | 10 | Exclamation in customer voice, attributed to a named CHRO | HR peer | Peer authority (titled attribution) | Attribute quotes by role, and let the role match the buyer |
| 34 | "Why Loop?" | H2 | 2 | Question as heading | Comparing buyer | Answer the comparison question directly | One question heading can open a differentiation block |
| 35 | "24X7, free Medical Advisors accessible for all health and insurance needs to deliver 'empathy at scale'." | Feature row | 15 | Capital X in "24X7" (vs "24x7" in footer); scare quotes around a slogan | Buyer worried about support | Availability promise | Write availability claims in one consistent format and only if staffed |
| 36 | "Not just for sick days" | Closing H2, 700 weight | 5 | Same words as the hero sub, now without the exclamation | Reader at the end | Bookending | Close with the hero's idea in a calmer voice |
| 37 | "Super-charged healthcare benefits for modern teams" | Closing sub | 6 | Hyphenated intensifier | Same | Energy | Avoid intensifiers; Knowvia's calm tone forbids them |
| 38 | "Get Started" | Closing CTA | 2 | Differs from hero "Request Demo" | Same | Consistency (broken) | Use the same CTA words at top and bottom |
| 39 | "We are reachable 24x7" | Footer label, lime | 4 | Lower-case x; above a phone number | Member in need | Availability | Put contact availability where people look when stuck: footer top right |
| 40 | "Insurance products are offered and serviced by Invoq Loop Insurance Brokers Pvt Ltd" | Regulatory line | 13 | Passive, legal entity name in full, no full stop | Diligent buyer, compliance team | Disclosure of role | State plainly which legal entity does what, in one sentence |

### 1.6 Trust and compliance devices

| Device | Where | Type treatment | Evidence |
|---|---|---|---|
| Claims Helpline button | Nav (outline, right) and hero (outline, left of primary) | 13.86px 500, outlined, same size as primary | [captured] |
| Phone and email | Footer top right under "We are reachable 24x7" (lime, about 14px) | Phone at 17.30px white, email 14.86px | [captured] |
| Broker disclosure | Footer bottom left | 12.09px 400 white on ink, line height 1.6 | [captured] |
| IRDAI licence block | Footer bottom right: CIN, "IRDAI Broking License Registration Code: IRDA/DB970/2022, Certificate No. 876", "License category- Direct Broker (Life & General)", "License validity till 09-02-2029." | About 9 to 10px, white, five stacked lines, right-aligned column | [captured, screenshot] |
| Cookie consent | Bottom-left modal on first load with equal-size Accept and Decline | Heading 18px 600 green; body 14px grey (3.68:1, fails AA) | [captured] |
| Titled testimonials | Testimonial split | Name in bold, role and company in grey below a photo | [captured] |
| Logo wall and stat cards | Directly under hero | Logos in full colour; stats in white cards | [captured] |

No asterisks or footnotes are used on the home page; the metrics (80%+, 20%, 10%) carry no source line. [captured]

### 1.7 First-principles takeaways for Knowvia (Loop)

- **A fluid integer ramp keeps hierarchy honest.** Loop's 5x, 4x, 3x, 2x steps make every level unmistakable. Knowvia can
  set Newsreader display and H2 as clean multiples of one Source Sans 3 base, and use fluid `clamp()` so the
  desktop to mobile ratio stays near 1.4 to 1.5.
- **The reframe by negation is the strongest device on the page,** and it works because it is repeated three times
  (hero sub, mission body, closing H2). Knowvia should pick one operational reframe and bookend the page with it,
  without the exclamation.
- **Put the "when it goes wrong" route in the header,** as Loop does with its claims button. Knowvia cannot run a helpline,
  so its equivalent is a calm, clearly labelled route to "what to do at the hospital desk", stated as guidance only.
- **Disclose the legal role in one plain sentence near the footer.** Loop names who offers and services the products.
  Knowvia must state the opposite: that it is not an insurer or broker and does not sell or settle anything.
- **Avoid Loop's faults:** CTA drift (three different primary labels), unsourced percentages, a typo beside a number,
  intensifiers, and a cookie banner that fails contrast.

---

## 2. Acko (direct-to-consumer insurer: motor, health, life, travel)

### 2.1 Type system

One family: **Euclid Circular B** at 400, 500, 600 [captured: fontsLoaded]. No tracking adjustments anywhere
(`letter-spacing: normal`) [captured]. Text colour is black at alpha rather than grey hex: rgba(0,0,0,0.88) for
primary and rgba(0,0,0,0.56) for secondary [captured].

**The ramp is a 3.5px grid on a 14px base:** 10.5 (0.75x), 14 (1x), 17.5 (1.25x), 21 (1.5x), 31.5 (2.25x), 42 (3x)
[captured values; the rem multiplier mechanism is inferred].

| Role | Family | Size px | Weight | Line height (ratio) | Tracking | Case | Evidence |
|---|---|---|---|---|---|---|---|
| Display (H1) | Euclid Circular B | 42 | 600 | 1.125 | normal | Sentence | [captured] |
| H2 | Euclid Circular B | 31.5 | 600 | 1.11 | normal | Sentence, one word in caps ("FREE") | [captured] |
| H3 / card title (h4) | Euclid Circular B | 21 | 600 | 1.25 | normal | Sentence | [captured] |
| Stat numeral | Euclid Circular B | about 40 (screenshot) | 600 | n/a | normal | numerals, violet #8B5CF6 | [captured, screenshot] |
| Eyebrow / award laurel text | Euclid Circular B | about 18 (screenshot) | 400 to 500 | n/a | normal | Sentence with asterisk | [captured, screenshot] |
| Body (lead) | Euclid Circular B | 17.5 | 400 | 1.30 | normal | Sentence | [captured] |
| Card body / links | Euclid Circular B | 14 | 400 | 1.25 | normal | Sentence | [captured] |
| Button | Euclid Circular B | 14 | 600 | normal | normal | Sentence ("Visit our digital showroom") | [captured] |
| Price label | Euclid Circular B | 10.5 | 400 | 1.33 | normal | "Price starts from" | [captured] |
| Fine print / ad reference | Euclid Circular B | 10.5 | 400 | 1.33 | normal | "UID: 6484 \| ARN: L0110 \| T&C apply" | [captured] |

- **How hierarchy is built:** weight 600 on every heading, size steps of 1.5x and 1.33x, and opacity (0.88 versus
  0.56) instead of grey hues. Inside cards, a **violet lead phrase** (#6815E5, 6.81:1 on the card) followed by grey
  text makes the first few words the claim and the rest the qualifier. [captured, screenshot pixel]
- **Display to body ratio:** 42 / 17.5 = **2.4** (the flattest in the reference set; the product grid is the hero).
  [captured]
- **Mobile H1:** 21.52px, line height 1.25, centred (desktop is left-aligned). Desktop to mobile = **1.95**. On mobile the
  card order changes: car first, health second. [captured]
- **Rupee numbers:** rupee sign set tight to the figure with no space ("₹657/month", "₹2094*", "₹457*"); four-digit prices
  are not comma-grouped, five-digit and larger use Indian grouping ("₹80,000", "₹26,519"); large values use Indian
  units, abbreviated in cards ("₹25 L to ₹100 Cr") and spelt out in commerce ("₹12.5 Lakhs"). Prices live in a lavender
  pill with a violet check icon; the struck-through reference price is small grey beside the live price; savings sit in
  a green outlined pill ("You save ₹26,519"). [captured, screenshot]
- **Fine print:** 10.5px with an asterisk attached directly to the claim or price ("#1*", "2025*", "₹2094*"); the
  explanations appear in the footer at 10.5px, white at 0.56 alpha on black (6.49:1). [captured]

### 2.2 Colour and ground

| Token (observed) | Value | Role | Rough share | Evidence |
|---|---|---|---|---|
| Grey ground | #EBEBEB | Page ground for hero, showroom and app sections | 45% | [captured] |
| Card white | about #F5F5F5 to #FFFFFF | Product cards, nav bar, trust section band | 25% | [captured, screenshot pixel] |
| Ink | rgba(0,0,0,0.88) and #111111 | Headings, body, all filled buttons (Login, showroom, View more, Download) | 10% | [captured] |
| Black | #000000 to near | Footer | 20% of height | [captured, screenshot] |
| Violet | #6815E5 (text), #8B5CF6 (stat numerals, 4.23:1 on white, large text only) | Lead phrases in cards, stat numerals, brand mark | under 3% | [captured, screenshot pixel] |
| Lavender | gradient pill fill | Price and feature pills, card bottom gradient | under 3% | [captured, screenshot] |
| Green | outlined pill | Savings only | under 1% | [captured, screenshot] |
| Gold | star glyphs | Ratings only | under 1% | [captured, screenshot] |

- **Accent discipline:** the brand violet never fills a button. Actions are black; violet marks the claim inside a
  sentence or a proof number. Colour is assigned by meaning: violet = what we promise, green = what you save,
  gold = what others rate. [captured colours, inferred rule]

### 2.3 Layout and rhythm

| # | Section (y px, from screenshot) | Layout family | Ground | Evidence |
|---|---|---|---|---|
| 1 | Floating nav bar (24) | Rounded light bar: logo, Products, Enterprise, Why ACKO?, Support; right: Renewals, Claims (outlined), Login (black), language | Light on grey | [captured] |
| 2 | Hero (0 to 840) | H1 left, two laurel award marks right, then a bento grid: one tall health card plus five cards (2 over 3), ad reference line centred below | Grey | [captured] |
| 3 | Trust (840 to 1710) | Centred H2, three-column stat strip with hairline dividers, UID line, then two equal rounded panels: claim app mock and review carousel | White | [captured] |
| 4 | Showroom (1710 to 2550) | Full-bleed 3D rendered showroom, centred H2 and sub, car carousel with price card and arrows, black button | Rendered photo | [captured] |
| 5 | App services (2550 to 3420) | Centred H2, sub, black app-download button, store ratings, phone mockup | Grey | [captured] |
| 6 | Footer (3420 to 4488) | Four link columns, four SEO accordions, company identity, address, social, fine print block, PCI DSS and IRDAI badges | Black | [captured] |

- **Grid and width:** content runs from x 80 to x 1360, a **1280px** container with about 16px gutters between cards.
  Card radius is large (about 24px). [captured, screenshot]
- **Section padding:** only the body block was captured (no section elements over the size threshold), so padding was
  not measured; visible gaps are about 60 to 90px. [captured limitation; screenshot estimate]
- **Alignment:** H1 left on desktop, centred on mobile; every other section heading is centred. [captured]
- **Imagery:** cut-out 3D objects (heart held in hands, white SUV, scooter, globe and plane, travel card), one family
  photo on the term life card, a 3D car showroom, phone mockups. The health card uses a heart with a medical cross,
  which is on Knowvia's banned list. [captured]
- **Density:** six product cards, each with title, violet claim, grey qualifier, price pill and arrow, all above the
  fold at 1440 x 900. [captured]

### 2.4 Motion

| What moves | How | Purpose | Evidence |
|---|---|---|---|
| Libraries | None detected (no GSAP, Lenis, Framer, Swiper); one `video` element | Bespoke CSS modules (Next.js style hashed class names) | [captured] |
| Card and element entrance | CSS animation `_3q9t9z0` 0.6s ease, run once, on 13 elements; `_3q9t9z1` 0.5s once | Staggered fade or rise of hero cards on load | [captured names and timing; effect inferred] |
| Showroom hero | `DriveHeroNew_fadeUp` 0.4s ease-out once | Headline and car rise in | [captured] |
| App section | `appService_moveLeft` and `appService_moveRight` 1s ease, `appService_easeIn` 0.8s ease-out | Phone UI pieces slide in from both sides | [captured] |
| Card hover | `transform 0.3s ease` on 23 elements | Lift or arrow nudge on product cards | [captured transition; exact transform inferred] |
| Accordions | `max-height 0.3s ease-out` (21) and `ease-in-out` (5) | Footer SEO groups and nav menus | [captured] |
| Carousels | `transform, scale, opacity 0.5s cubic-bezier(0.25, 0.46, 0.45, 0.94)` (ease-out-quad) | Car showroom and review slides, user-driven via arrows | [captured] |
| Slow drift | `transform 10s ease-out` on one element | Slow zoom or pan, probably the showroom render | [captured; target inferred] |
| Claim mock | Phone shows "File a claim" and a chat bubble "Tell us what happened" | Demonstrates a conversational claim flow; motion not verified | [captured text; animation inferred] |

- **Reduced motion:** 0 rules found, but 17 stylesheets were unreadable, so this is unknown rather than absent.
  [captured limitation]
- **Character:** short (0.3 to 0.6s), once-only entrances, no scroll scrubbing, no smooth scroll. Motion serves a
  shopping page: it signals that cards are interactive and lets a carousel feel physical. [inferred]

### 2.5 Copy, line by line

| # | Line (verbatim) | Role | Words | Punctuation and syntax | Buyer state targeted | Principle | Transferable rule |
|---|---|---|---|---|---|---|---|
| 1 | "Claims" | Nav dropdown, outlined | 1 | Single noun, outlined so it reads as a button | Customer mid-claim | Recognition, Fitts | Give the stressful task its own visible header control |
| 2 | "Renewals" | Nav dropdown | 1 | Plural noun | Existing customer near expiry | Task routing | Name recurring jobs in the nav as nouns |
| 3 | "Why ACKO?" | Nav | 2 | Question with brand caps | Comparing buyer | Answer the comparison | A question label invites the sceptic in |
| 4 | "Have an award-winning insurer by your side" | H1 | 7 | Imperative "Have"; hyphenated compound; no full stop | Buyer unsure whom to trust | Authority, companionship ("by your side") | Combine an authority marker with a relationship phrase |
| 5 | "India's #1* insurance app" | Award laurel | 4 | Hash-one plus asterisk tied to a footnote | Sceptic | Authority with substantiation | Every superlative carries a footnote marker at the claim |
| 6 | "Best direct insurer 2025*" | Award laurel | 4 | Year as proof of recency; asterisk | Same | Recency, authority | Date-stamp any external recognition |
| 7 | "Health insurance" | Card title | 2 | Category noun only | Shopper scanning categories | Hick's law via chunking | Card titles are the plain category name |
| 8 | "100% hospital bill payments, from syringes to surgeries. No deductions." | Card claim | 10 | Violet lead phrase; alliterative merism ("syringes to surgeries"); two-word sentence to close | Family fearing out-of-pocket costs | Concrete range, then a flat denial | Show the range of a promise with two concrete endpoints, then close with a short sentence |
| 9 | "From ₹657/month" | Price pill | 2 | Monthly framing, slash unit | Price-sensitive buyer | Reference price, chunked cost | Show the smallest honest unit of cost |
| 10 | "Simple prices. Super fast claims. That's our promise." | Card claim (desktop) | 8 | Three short sentences; the third names the act of promising | Motor buyer wary of claims | Commitment, parallel structure | Two parallel fragments then a sentence that owns them |
| 11 | "Simple prices. Fast claims." | Same card (mobile) | 4 | Intensifier dropped on mobile | Same | Copy fits the viewport | Write a short variant for narrow screens, not just smaller type |
| 12 | "Starting at just ₹2094*" | Price pill | 4 | "just" minimises; asterisk qualifies | Price-sensitive | Anchoring | Anchor with the floor price and qualify it visibly |
| 13 | "Insure your bike or scooter in just 1 minute" | Card claim | 9 | Numeral "1" for scan speed | Busy rider | Effort reduction | Quantify the user's effort, in numerals |
| 14 | "Coverage from ₹25 L to ₹100 Cr" | Card claim | 7 | Indian abbreviations L and Cr; range | Term buyer sizing cover | Range anchoring | Use Indian units when the audience thinks in them |
| 15 | "Pure life cover" | Feature pill | 3 | Adjective "Pure" separates from investment-linked plans | Buyer burned by mis-selling | Contrast effect (implicit) | One word can signal "not the thing you distrust" |
| 16 | "Emergency medical coverage in 150+ countries" | Card claim | 6 | Plus sign as floor | Traveller | Scope proof | State scope with a countable unit |
| 17 | "Flying domestic?" | Card title | 2 | Question, unlike the other noun titles | Occasional flyer | Pattern break (Von Restorff) | One question among nouns draws the eye to a new product |
| 18 | "ACKO AirPass pays you back for delayed, cancelled and missed flights" | Card claim | 11 | Active verb "pays you back"; triad without serial comma | Same | Concrete outcome | Describe what happens to the user's money in an active verb |
| 19 | "UID: 6484 \| ARN: L0110 \| T&C apply" | Ad reference line under grid | n/a | Pipes as separators; 10.5px grey, centred | Regulator, careful reader | Compliance by placement | Put the required reference immediately under the claims it covers |
| 20 | "Your trust isn't assumed, its earned" | H2 (trust) | 6 | Antithesis across a comma; "its" missing its apostrophe | Sceptic | Earned authority | A contrast sentence can carry trust, but proofread it: an error in a trust heading costs trust |
| 21 | "7 mins" / "Fastest claim settlement" | Stat | 2 + 3 | Abbreviated unit; superlative "Fastest" means best case, not typical | Claim-anxious buyer | Peak anchoring | Never present a best case as a norm; label which it is |
| 22 | "94.3%" / "Claims settled in 1 week" | Stat | 1 + 5 | Decimal precision signals measurement | Same | Precision as credibility | Precise figures read as measured; round figures read as marketing |
| 23 | "24x7" / "Instant customer support" | Stat | 1 + 3 | Availability as a number | Same | Availability | State availability only when it is staffed |
| 24 | "UID: 7993 \| T&Cs Apply*" | Ad reference under stats | n/a | Second reference, different number from line 19 | Regulator | Compliance per claim block | Each block of claims gets its own reference |
| 25 | "Claims shouldn't be hard" | Panel heading | 4 | Negative modal, no full stop; states a belief | User who has had a bad claim | Shared enemy | Name the bad experience as the thing both of you are against |
| 26 | "Tell us what happened" | UI mock chat bubble | 4 | Imperative, conversational | User mid-incident | Lower the first step | Show the first sentence of the real flow, in plain words |
| 27 | "Promises made. Promises kept." | Panel heading (reviews) | 4 | Chiasmus-like parallel, two full stops | Sceptic | Consistency principle | Parallel two-sentence headings land as a vow |
| 28 | "I recently switched to ACKO Insurance and I'm thoroughly impressed! ... The claims process is also seamless and hassle-free." | Review | about 35 | Exclamation in customer voice; five stars above | Sceptic | Social proof | Reviews that mention the feared moment (claims) carry most weight |
| 29 | "ACKO customer" | Review attribution | 2 | First name plus initial avatar; product, not city | Same | Specific source | Attribute with the minimum identity that still feels real |
| 30 | "Save as much as ₹80,000 on top-selling cars" | H2 (showroom) | 8 | "as much as" signals a ceiling; Indian grouping | Car shopper | Gain framing | Hedge maximum claims explicitly ("up to"), never imply typical |
| 31 | "Explore, compare, and book your brand new car from our digital showroom" | Sub | 12 | Triad of verbs, serial comma | Same | Journey preview | List the steps of the journey in order |
| 32 | "You save ₹26,519" | Savings pill (green) | 3 | Second person, present tense | Same | Loss aversion reversed | Express a difference as the user's gain |
| 33 | "Visit our digital showroom" | Button | 4 | Imperative, sentence case | Same | Low commitment | A "visit" verb lowers the stakes of a click |
| 34 | "Explore FREE helpful services on our app" | H2 | 7 | One word in caps for emphasis | Non-customer | Reciprocity (Cialdini) | Offer value before asking for the sale |
| 35 | "Even if you are not our customer" | Sub | 7 | Concessive clause, no full stop | Non-customer | Reciprocity, low pressure | Say explicitly when help does not require buying |
| 36 | "Stay prepared for health emergencies" | App UI heading | 5 | Imperative; preparedness, not fear | Family planner | Prevention framing | Talk about readiness, not catastrophe |
| 37 | "*Listed #1 for "insurance" on the Apple App Store" | Footnote | 9 | Asterisk resolves line 5; quotes show the search term | Diligent reader, regulator | Substantiation | Each footnote explains exactly how a claim was measured |
| 38 | "The use of images and brands are only for the purpose of indication and illustration." | Disclaimer | 15 | Grammatical slip ("use ... are") | Regulator | Disclosure | Disclaim illustrative imagery in one sentence |
| 39 | "Acko Technology & Services Ltd. ("Acko Tech") is the holding company of Acko General Insurance Ltd. and Acko Life Insurance Ltd. and is not registered as an insurance intermediary. ..." | Entity disclaimer | about 80 | Defined-term parenthesis; long legal sentences | Regulator | Role separation | State what the site's legal entity does not do, in plain sentences |

### 2.6 Trust and compliance devices

| Device | Where | Type treatment | Evidence |
|---|---|---|---|
| Claims and Renewals in nav | Header right, Claims outlined beside a black Login | 14px | [captured] |
| Award laurels with asterisks | Top right of hero, opposite the H1 | About 18px dark text inside laurel graphics | [captured, screenshot] |
| Ad reference line (UID, ARN, T&C) | Directly under the product grid and again under the stat strip | 10.5px, rgba(0,0,0,0.56), centred | [captured] |
| Stat strip | First section after the hero | Violet numerals about 40px, 14 to 16px labels, hairline dividers | [captured, screenshot] |
| Reviews | Carousel panel beside the claim mock | Five gold stars, about 14px centred text, initial avatar | [captured, screenshot] |
| Store ratings | App section | Numerals about 24px bold over 12px store names | [captured, screenshot] |
| Footnotes and disclaimers | Footer bottom, full width | 10.5px, white at 0.56 alpha on black | [captured] |
| CIN and company identity | Footer | Company name about 16px white; CIN 10.5px | [captured, screenshot] |
| IRDAI and PCI DSS badges | Footer bottom right, dark tiles | Small logos, no text | [captured, screenshot] |
| "Financials & disclosures" link | Footer Legal column | 14px link | [captured] |

### 2.7 First-principles takeaways for Knowvia (Acko)

- **Colour by meaning, not decoration.** Acko's violet marks the promise inside a sentence, black carries every action,
  green marks only savings. Knowvia can do the same with Harbour for actions only and a text-level emphasis for the one
  phrase that matters, keeping Signal Gold to two highlights.
- **Lead phrase plus qualifier** is a strong pattern for explaining cover: a short coloured or bolder claim, then a
  grey qualifier. For Knowvia the "claim" is never a promise; it is the fact found in the policy, and the qualifier is
  the condition or uncertainty.
- **Asterisk at the claim, explanation in the footer, reference under the block.** Knowvia has no awards or stats, but
  it will show real rupee amounts from research cases; each needs an evidence marker beside it and a source line close
  by, not only in the footer.
- **Indian number conventions matter for a household reader.** Use the rupee sign tight to the figure, Indian grouping
  on every amount (including four digits, for consistency), and lakh or crore in words where the reader thinks in them.
  Set prices and conditions in Source Sans 3 with tabular numerals, never in the display serif.
- **Avoid Acko's faults:** a flat 2.4 display ratio and a 21.5px mobile H1 that makes the headline feel like a label,
  a "fastest" best case shown as a stat, a typo in the trust heading, and medical-cross imagery.

---

## 3. Cross-site comparison

| Dimension | Loop Health | Acko | Read for Knowvia |
|---|---|---|---|
| Buyer | HR lead buying for others | Individual or family buying for themselves | Knowvia's household operator is closer to Acko's buyer but in Loop's role: managing cover for others |
| Families | Work Sans only | Euclid Circular B only | Both use one sans; Knowvia's serif display is a deliberate departure toward editorial calm |
| Ramp logic | Integer multiples of a fluid base (5x, 4x, 3x, 2x) | 3.5px steps on a 14px base | Pick one base and derive every size from it |
| Display to body | 4.0 | 2.4 | Knowvia should sit between (about 3 to 3.5) so the headline leads without shouting |
| Desktop to mobile H1 | 1.48 | 1.95 | Keep near 1.5; never let the mobile H1 collapse to body-like size |
| Tracking | -0.04em on all display sizes | None | A serif display needs little or no negative tracking; test Newsreader at 0 to -0.01em |
| Colour | Green ground, lime action, yellow close | Grey ground, black action, violet promise | Both keep the action colour exclusive; Knowvia's Harbour should be the same |
| Hero | Centred slogan, photo collage | Left H1, product grid with prices | Knowvia has no products or prices; its hero proof is the explained example, not a catalogue |
| Motion | GSAP scroll scenes, scroll-scrubbed text, one ease-out-quart curve | Short CSS once-only entrances, no scroll scrubbing | Knowvia: Acko's restraint with Loop's single easing curve; no scrubbed reveals that hide text |
| Claims in copy | "Claims Passed", "Claims Helpline" | "Super fast claims", "Claims shouldn't be hard", claim stats | Knowvia cannot make claim speed or outcome claims; it can only promise clarity before the claim |
| Regulatory text | Broker line plus IRDAI licence block in the footer | Ad references under each claim block, footnotes, entity disclaimer, IRDAI badge | Knowvia needs a plain "not an insurer, not a broker" statement and evidence markers next to numbers |
| Weak points | CTA drift, unsourced percentages, typo, low-contrast cookie text | Typo in trust H2, best-case stat, tiny mobile H1 | Proofread numbers and trust lines; keep the CTA wording fixed |
