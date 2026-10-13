# CP1 reference teardown: benefits insurtech (Onsurity, Plum, Thatch)

Checkpoint CP1 of the Knowvia design brief. Research only: nothing here is approved Knowvia copy, and no line
from these sites is proposed for reuse. Quoted lines appear only so they can be analysed.

## Method and evidence status

| Site | URL | Capture status | Basis for this file |
|---|---|---|---|
| Onsurity | https://www.onsurity.com/ | **Failed twice.** HTTP 200, but the page rendered its own client error boundary ("Something went wrong", page height 540px) in headless Chromium on both runs. | Research doc (`research-doc.txt`, Onsurity section and cross-site tables) plus what the error shell still exposed: loaded font files, title, meta description, design tokens of the error state, global keyframes and reduced-motion rule count. |
| Plum | https://www.plumhq.com/ | OK. 88 copy lines, 12 type combos, page height 10,682px. One stylesheet blocked from inspection. | `capture.json`, desktop hero, mobile hero and full-page screenshots. |
| Thatch | https://thatch.com/ | OK on desktop. 134 copy lines, 17 type combos, page height 8,212px. The 390px screenshot rendered **unstyled** (browser default serif, raw list bullets), so mobile layout could not be read from the image. The `mobileHero` measurement (45.5px) carries site letter-spacing, so it was taken with styles applied, but treat it with caution. | `capture.json`, desktop hero and full-page screenshots. |

Labels: **[captured]** means read from `capture.json` computed styles or seen directly in a screenshot.
**[inferred]** means reasoned from captured evidence; the reasoning is stated. Pixel positions read from screenshots
are marked "measured from screenshot" and are approximate. Contrast ratios were computed from captured RGB values
(alpha text blended onto its captured ground) with the WCAG formula; they are approximate where a ground colour was
sampled from a screenshot.

Captured all three on 13 Oct 2026, public home pages only, no login or form use.

**Changes since the research doc** [captured]: Plum is no longer a cream-ground page with a dark footer. The hero
and most of the upper page sit on a dark aubergine ground (#2B0B21) with painterly night-scene illustration; cream
appears only in the middle and lower sections. Plum's "audience router" now lives in a nav menu ("+ EXPERIENCE",
with Plum Care, Employee and Admin links in the footer) and in an in-section toggle, not as a row at the top.
Thatch's hero CTAs are now a translucent ghost "Get started" plus a red "Book a demo".

---

## 1. Onsurity (employee healthcare, India)

### Type system

Families [captured, from the error shell's loaded fonts]: **Space Grotesk** (variable, 300 to 700) for display and
**Inter** (variable, 100 to 900) for everything else. Both are geometric or neo-grotesque sans. No serif is loaded.

| Role | Family | Size px | Weight | Line-height | Tracking | Case | Source |
|---|---|---|---|---|---|---|---|
| Display (H1) | Space Grotesk | 58 | 500 | not recorded | not recorded | Title Case every word | research doc |
| H2 | Space Grotesk (inferred) | not captured | | | | | |
| H3 | not captured | | | | | | |
| Eyebrow | not captured | | | | | | |
| Body | Inter | 16 | 400 | 1.6 | normal | sentence | [captured] error-state paragraph |
| Small | Inter | 14 | 600 | 1.5 | normal | sentence | [captured] skip link |
| Button | Inter | 15 | 600 | 1.5 | normal | sentence | [captured] error-state "Try again"; marketing pill CTA not captured |
| Error-state heading | Space Grotesk | 26 | 700 | 1.25 | normal | sentence | [captured] |

- Hierarchy [inferred]: built by family switch (Space Grotesk for heads, Inter for text) and size, not by case or
  tracking. The error shell uses normal tracking throughout, so the system does not lean on tight display tracking.
- Display to body ratio: 58 / 16 = **3.6** [inferred: assumes the marketing body matches the 16px shell body].
- Mobile H1: not captured. Desktop to mobile ratio unknown.
- Pairing logic [inferred]: two sans faces with slightly different personalities. Space Grotesk's quirky
  terminals add warmth to a rational frame; Inter is the neutral workhorse. The pairing says "fast, modern,
  operational": it matches the promise of set-up speed rather than editorial care.

### Colour and ground

- Pastel sky ground with cloud illustration in the hero; periwinkle pill CTA (#BED4FF) with navy text (#113070)
  [research doc]. Computed contrast for navy on periwinkle: about **8.4:1**.
- Navy #113070 is also the shell's heading colour and skip-link ground; body text is a warm dark grey #403A35;
  the error-state primary button is a mid blue #2560BF [captured, error state].
- Proportion [inferred from research doc]: pale sky and white dominate, navy carries text, periwinkle is the single
  accent on actions. Accent discipline: the accent is soft, so action is signalled by shape (pill) and position as
  much as by colour.

### Layout and rhythm (research doc, not re-captured)

| # | Section | Layout family |
|---|---|---|
| 1 | Hero: headline over cloud illustration, pill CTA | centred or split hero with illustration ground |
| 2 | Stat strip (cashless hospitals, days, crore, members) | centred four-up numeric strip with counters |
| 3 | "Trusted by growing businesses" logo strip | horizontal logo row |
| 4 | Product grid: four cards | four-up card grid |
| 5 | Vertical pill timeline | stacked timeline |
| 6 | Dashboard mockup | product UI showcase |
| 7 | Four-step "how to get started" | step sequence |
| 8 | Testimonials, awards, FAQ, closing CTA | proof stack then accordion then CTA band |

- Grid, max width and section padding: **not captured**.
- Imagery: soft illustration (clouds) plus product UI [research doc].
- Two audiences [research doc]: the HR buyer gets speed ("set up in hours"), stats and awards; the employee gets the
  "they'll actually use" promise. Separation is by section purpose, not by an explicit switch.

### Motion

- Stat counters count up on scroll: the earlier research capture caught them at their start values ("0+",
  "~0 days", "₹0 Cr+") [captured in research pass]. Purpose: draw the eye to proof as it enters view.
- Skip link slides in with `top 0.2s ease` [captured]. Purpose: accessible focus reveal.
- Global keyframe `spin` (loader) and **1** `prefers-reduced-motion` rule in global CSS [captured]. Whether the
  counters respect it is unknown.
- No GSAP, Lenis, Lottie, Swiper or AOS detected in the shell [captured], but the shell did not load the page
  bundle, so this is not conclusive.
- Failure mode [captured]: the whole home page was replaced by a client error boundary in two headless runs. The
  marketing content depended on client JavaScript succeeding. For a trust-first page this is the most important
  Onsurity lesson: content must render without the client bundle.

### Copy, line by line

The capture failed, so the table holds only lines recorded verbatim in the research doc or captured from the shell.

| Line (verbatim) | Role | Words | Punctuation and syntax | Buyer state targeted | Principle | Transferable rule |
|---|---|---|---|---|---|---|
| "Employee Healthcare Easy To Set Up. Even Easier To Use." | H1 | 10 | Two full stops make two beats: claim, then escalation. Title Case on every word adds formality and slows reading. The second sentence is a verbless fragment that tops the first. | Busy HR lead, fears admin | Fogg ability (lower perceived effort); rule of two with escalation | Answer the buyer's effort fear in beat one, then raise it for the end user in beat two. Keep sentence case for fluency. |
| "Give your team healthcare they'll actually use" | Headline-level line (position not recorded) | 7 | Imperative, second person. "actually" concedes a known failure (unused benefits) without naming it. No end stop, so it reads as a label. | HR lead who has seen low uptake | Implied contrast effect; specificity of outcome | Name the outcome the old way failed to deliver, with one concession word, not a paragraph about the failure. |
| "Set up in hours" | Proof phrase | 4 | Fragment. Unit of time instead of an adjective. | Time-poor buyer | Specificity; Fogg ability | Replace "quick" with a unit the reader can picture, and only when it is true. |
| "Trusted by growing businesses" | Logo strip label | 4 | Passive participle; the logos carry the proof, the label only frames it. "growing" self-selects the ICP. | Sceptical buyer checking peers | Social proof; similarity | Let the label select the reader ("people like you") and let the evidence below it do the persuading. |
| "Group Health Insurance" | Product card title | 3 | Category noun in Title Case. No adjective. | Buyer scanning for a known category | Processing fluency; recognition over recall | Use the words the buyer already searches for as titles; save the interpretation for the line below. |
| "Group Personal Accident" | Product card title | 3 | Same pattern; parallel structure across the four cards. | Same | Gestalt similarity | Keep sibling titles grammatically parallel so the grid reads as one set. |
| "Group Term Life" | Product card title | 3 | Same. | Same | Gestalt similarity | Same as above. |
| "Corporate Wellness" | Product card title | 2 | Breaks the "Group" prefix: the odd card is the non-insurance one. | Buyer looking beyond insurance | Von Restorff (mild) | When one item differs in kind, let its title differ in form. |
| "~0 days" | Stat label (counter start value) | 2 | Tilde signals an approximation; the unit is attached to the number. | Buyer who wants a speed number | Specificity; honest approximation | If a number is approximate, mark it as such in the number itself. |
| "₹0 Cr+" | Stat label (counter start value) | 2 | Rupee sign and "Cr" localise the scale; "+" claims a floor, not a ceiling. | Indian finance buyer | Authority; local fluency | Use local units (₹, lakh, crore) so the reader does not convert in their head. |
| "Monthly Employee Healthcare And Wellness Platform \| Onsurity" | Page title | 7 | Title Case, category first, brand last. "Monthly" puts the pricing model in the title. | Searcher comparing models | SEO fluency; specificity | Lead the title with the category and the one attribute that differentiates the model. |
| "Bring instant, reliable healthcare to your team." | Meta description, sentence 1 | 7 | Imperative, two stacked adjectives, full stop. | Searcher | Processing fluency | One sentence with one verb and the audience named. |
| "Group health insurance, wellness, term life and personal accident cover for Indian businesses." | Meta description, sentence 2 | 13 | Inventory list, no serial comma before "and", geography at the end. | Searcher qualifying fit | Specificity | Close the description with who and where it is for. |
| "Something went wrong" | Error-state heading (shell) | 3 | Plain, blameless, no apology word, no exclamation. | Any visitor, now frustrated | Expectation setting | Error headings state what happened in plain words and never blame the reader. |
| "This section failed to load. You can retry" | Error-state body (opening) | 8 | Two short sentences: what happened, what you can do. Second person. | Frustrated visitor | Fogg ability (one clear next action) | Every failure message pairs the fact with one action the reader can take. |
| "Try again" | Error-state primary button | 2 | Imperative, two words, verb first. | Same | Hick (one primary action) | One verb-first primary action; the secondary escape route is visually quieter. |
| "Go to homepage" | Error-state secondary button | 3 | Imperative escape hatch, outlined not filled. | Same | Hick; graceful degradation | Always offer a safe exit next to the retry. |

### First-principles takeaways for Knowvia

- **Render the story on the server.** Onsurity's page vanished behind an error boundary twice. Knowvia's hero,
  promise and early-list form must render as HTML without client JavaScript, with motion layered on top.
- **Name effort, not fear.** The H1 sells ease of set-up and use. Knowvia can sell ease of understanding (knowing
  what you have) in the same two-beat shape without naming illness.
- **Local units are proof of care.** "₹" and "Cr" make the numbers feel local. Knowvia's evidence-backed rupee
  amounts (section 11) should use ₹ and lakh, never converted figures.
- **Counters need a no-JS and reduced-motion end state.** The research pass caught counters at zero. Any Knowvia
  number must be readable at its final value before, or without, animation.

---

## 2. Plum (employee benefits, India)

### Type system

Families [captured]: **GT Alpina Standard** (serif; 300 italic, 300 and 400 loaded) for every heading from H1 to
H3, and **Passengersans** (sans; 300, 400, 500 loaded) for body, nav, buttons, labels and footer.

| Role | Family | Size px | Weight | Line-height (ratio) | Tracking | Case | Source |
|---|---|---|---|---|---|---|---|
| Display (H1) | GT Alpina Standard | 68 | 400 | 1.00 | -2.04px (-0.03em) | Sentence case, last word set in italic | [captured]; italic seen in screenshot, 300 italic face loaded |
| Closing display (H2) | GT Alpina Standard | 52 | 400 | 1.00 | -2.6px (-0.05em) | `text-transform: capitalize`, "of" and "for" in italic | [captured] |
| H2 | GT Alpina Standard | 51.2 | 400 | 1.00 | -1.536px (-0.03em) | Sentence | [captured], 8 uses |
| H3 | GT Alpina Standard | 40 | 400 | 1.00 | -1.2px (-0.03em) | Sentence | [captured] |
| Product list link | Passengersans | 22 | 300 | 1.40 | -0.32px (-0.015em) | Title Case, 60% opacity | [captured] |
| Eyebrow / toggle label | Passengersans | 14 | 500 | 1.00 | -0.28px (-0.02em) | UPPERCASE | [captured] |
| Hero sub-line (lead) | Passengersans | 16 | 500 | 1.40 | -0.32px (-0.02em) | Sentence | [captured] |
| Body | Passengersans | 16 | 400 | 1.40 (some 1.30) | normal | Sentence, often 60% opacity | [captured] |
| Small (footer, legal) | Passengersans | 13 | 300 | 1.40 | -0.26px (-0.02em) | Sentence | [captured] |
| Button | Passengersans | 14 | 400 | 1.40 | -0.32px (-0.023em) | UPPERCASE | [captured] |
| Stat numerals | sans, light, large | not captured (div text) | | | | | [inferred from screenshot: numerals are set in the sans, not the serif] |

- Hierarchy [captured]: the serif carries every heading at one weight (400); hierarchy comes from **size alone**
  (68, 52, 51.2, 40) plus tight, constant negative tracking (-0.03em) and solid 1.0 leading. The sans carries
  everything functional, and functional labels (nav, buttons, toggles) switch to **uppercase at 14px**, so case,
  not weight, marks "this is an action". Secondary text drops to 60% opacity rather than to a lighter colour token.
- Italic as emphasis [captured in screenshot]: one italic word in the H1 ("deserves") and italic function words in
  the closing line. Emphasis is done by **posture, not weight**; there is no bold anywhere in the heading ramp.
- Display to body ratio: 68 / 16 = **4.25** [captured].
- Mobile H1: **32px**, line-height 1.0, -0.96px (-0.03em) [captured]. Desktop to mobile ratio 68 / 32 = **2.1**.
  The mobile sub-line wraps to two lines at a visibly larger size than the desktop 16px [captured in screenshot;
  exact size not recorded].
- Pairing logic [inferred]: a soft, high-contrast book serif over a quiet grotesque. The serif says "considered,
  humane, long-term"; the uppercase sans says "operational and precise". Plum sells a people promise to an HR
  buyer, so the emotional layer gets the serif and the procurement layer gets the sans.
- Accessibility note [computed]: 60% ink body on the near-white ground is about 4.5:1 (borderline AA); 60% cream on
  aubergine is about 6.7:1.

### Colour and ground

| Token (captured) | Value | Role | Rough share of page height |
|---|---|---|---|
| Aubergine ground | #2B0B21 | Hero overlay, proof, product, testimonial, footer | about 55% (sections at y 0 to 3,898, 6,694 to 7,580, and the closing band) |
| Cream | #FFF1E5 (to #FFFEFE gradient) | Middle and lower sections; text colour on dark | about 40% |
| Plum ink | #3A0E2B | Text on cream | text only |
| Coral | #FF4052 | Primary CTA, toggle active state, step tags | under 2% |
| Painterly illustration | purples, oranges, teals | Hero, product cards, founders' letter, closing | large areas, mostly in the dark half |

- Accent discipline [captured]: coral appears only on "GET A QUOTE", "TALK TO SALES", "START NOW", the active
  toggle pill and small step tags. Small coloured step tags (yellow, blue, green) add a second, minor accent set.
- Contrast [computed]: cream #FFF1E5 on coral #FF4052 is about **3.1:1**, which fails AA for 14px button text.
  The accent was chosen for heat, not legibility.
- Ground switch [captured]: the page moves dark to light around y 3,900 with a cream gradient, and back to dark for
  testimonials and the close. The dark half is aspirational and illustrated; the light half is practical
  (tech, process, segments).

### Layout and rhythm

Max width [measured from screenshot]: content cards span roughly x 94 to 1,346 at 1,440px (about 1,250px);
nav spans about x 72 to 1,368. Section `padding` on `<section>` is **0px** everywhere [captured]; spacing lives on
inner wrappers, so section padding values could not be captured. Section heights [captured]: 900, 1,228, 1,770,
2,796, 886, 1,077, 908, 1,117.

| # | Section (captured order) | Layout family | Ground |
|---|---|---|---|
| 1 | Hero: centred serif H1, sub-line, inline email field with CTA, floating report card bottom right | full-bleed illustration, centred stack | illustration, dark |
| 2 | "We're setting the standard": three award cards, three stats, 4 by 3 logo grid with hairline borders | centred proof stack | aubergine |
| 3 | "Full spectrum healthcare...": two large split cards (text with link list beside illustration plus phone UI), mirrored | alternating split cards | aubergine |
| 4a | "Tech that turns benefits into breakthroughs": HR or talent toggle, illustration collage with UI cards, three tab labels | centred tabbed showcase | cream gradient |
| 4b | "We've reimagined insurance and healthcare partnerships.": headline and CTAs, illustration with policy-score UI, three numbered steps | three-column asymmetric | cream |
| 4c | "Supporting corporate India's growth": segment rows (Enterprise, Tech startups, SMB, MNC) with "KNOW MORE" | ruled table-list | near-white |
| 5 | Testimonial carousel: giant ghost company wordmark, portrait, quote, 1/3 pager | carousel | aubergine |
| 6 | "A letter from the founders": paper card over painterly illustration, two signatures | centred document on image | illustration |
| 7 | "Future-forward workplace wellbeing": four report covers | four-up card row | cream |
| 8 | Closing: title-case serif over sunset illustration with empty chair, "START NOW", then footer with IRDAI and ISO text | centred CTA band, then five-column footer | illustration, dark |

- Alignment [captured in screenshots]: centred for hero, section titles, proof and close; left for split cards,
  steps and segment rows.
- Imagery [captured]: painterly digital illustration of people at work in dreamlike landscapes, with real product UI
  cards placed on top. Real faces appear only in the testimonial portrait.
- Two audiences [captured]: (1) a two-state toggle labelled for HR and for talent inside one section; (2) section
  pairs that alternate buyer and user (proof for the buyer, "Complete protection" listing who is covered for the
  employee); (3) a nav menu that routes by experience (Admin, Employee, Plum Care, per footer links). The employee is
  addressed in third person ("your team", "talent") because the reader is always the buyer.

### Motion

- Libraries [captured]: **GSAP with ScrollTrigger**, **Webflow Interactions**, **Swiper**. No Lenis smooth scroll.
- Transitions [captured]: `all 0.2s ease` on 40 elements (link and button hover); `all 0.8s cubic-bezier(0.19, 1,
  0.22, 1)` on 34 elements (an ease-out-expo: fast start, long soft landing); `all 0.2s` and `0.4s cubic-bezier(0.77,
  0, 0.175, 1)` on 14 elements (ease-in-out-quart, used for toggles and menus [inferred]); `all 0.25s ease` on 7.
- Keyframes [captured]: `fadeInOpacity`, `spin`.
- Reveal on scroll [captured]: `preReveal` is **empty**: no element was hidden or offset below the fold before
  scrolling. Either reveals are set by JavaScript after the snapshot or the page does not hide content before
  scroll [inferred]. Content was fully visible in the full-page screenshot.
- Carousel [captured]: testimonial carousel with arrows and a "1/3" counter (Swiper). Purpose: three proofs in one
  viewport height.
- The 0.8s expo transitions [inferred]: most likely hover and state changes on the large split cards, list rows and
  arrows. Purpose: a slow, expensive-feeling settle that matches the serif's calm.
- Reduced motion [captured]: **0** `prefers-reduced-motion` rules found, with 1 stylesheet blocked from inspection.
  Not confirmed either way; no evidence of support.
- Counters: stats were already at final values (100,000, 600,000, 6000) in the full-page screenshot [captured];
  no counter animation detected.

### Copy, line by line

| Line (verbatim) | Role | Words | Punctuation and syntax | Buyer state targeted | Principle | Transferable rule |
|---|---|---|---|---|---|---|
| "Employee benefits your team deserves" | H1 | 5 | No end stop: reads as a title, not a claim. "deserves" in italic carries the emotion; second person possessive "your team" makes the buyer the giver. | HR lead who wants to be the good employer | Identity and ownership framing; emphasis by posture | Put the emotional word last and set it apart by style, not weight. |
| "Comprehensive insurance and care, built for growing companies." | Hero sub-line | 8 | One comma splits what it is from who it is for. Full stop gives closure the H1 withheld. | Buyer qualifying fit | Specificity; self-selection | Sub-line formula: what it is, comma, who it is for. |
| "YOUR WORK EMAIL" | Input placeholder | 3 | Uppercase, possessive, qualifies the lead ("work") at the field. | Buyer ready to act | Fogg ability (one field) | If a form sits in the hero, ask for one field and state which kind. |
| "GET A QUOTE" | Primary CTA (hero and nav) | 3 | Imperative, uppercase. Names a low-commitment output, not a sale. | Buyer at evaluation | Commitment ladder (Cialdini); Hick | Name the first deliverable the reader receives, not the purchase. |
| "The Standard Of Employee Benefits 2026 -27" | Floating report card | 7 | Title Case, a year range as freshness proof. | Researcher buyer | Authority; recency | A content asset can sit in the hero as a softer second door, if it is visually smaller. |
| "We’re setting the standard" | H2 (proof section) | 4 | First person plural, present continuous. No end stop. | Sceptical buyer | Authority | Introduce proof with a short claim the proof below must justify. |
| "We've sustained high standards. We've set new benchmarks. We're here to stay." | Sub-line | 12 | Tricolon of full-stopped sentences; anaphora on "We've". | Buyer worried about vendor longevity | Rule of three; durability signalling | A tricolon of short sentences can carry stability, but each beat needs evidence beside it. |
| "Insurtech of the year 2023-2024" | Award label | 5 | Lower-case "of the year", year range. | Buyer needing defensible choice | Authority (third-party award) | Third-party marks only, each with its issuer named beneath. |
| "100,000" / "Claims Processed" | Stat and label | 3 | Big numeral, Title Case label below, no qualifier. | Finance buyer | Social proof; numbers large, labels small | Numeral first at display size, plain label under it, source on hover or in a note. |
| "600,000" / "Lives Insured" | Stat and label | 3 | Same pattern; "Lives" humanises the count. | Same | Social proof | Count the unit the reader cares about (people, not policies) when the evidence allows. |
| "Full spectrum healthcare for the full spectrum of your talent’s needs" | H2 | 11 | Repetition ("full spectrum") as wordplay; possessive "your talent's". 11 words, long for a heading. | HR lead mapping coverage | Processing fluency (repetition) | Wordplay is allowed once per page; never at the cost of a heading over eight words. |
| "Our employee benefits suite covers preventive, primary, and crisis care." | Section sub-line | 10 | Serial comma, three-stage list ordered by acuity. | Buyer checking breadth | Rule of three; specificity | Order a list by the reader's journey, from routine to serious. |
| "With Plum, you’ll never need another healthcare partner." | Section sub-line | 8 | Absolute claim ("never"), fronted clause. | Buyer tired of vendor sprawl | Consolidation appeal | Avoid absolutes you cannot evidence; state what the reader no longer has to do instead. |
| "Complete protection" | H3 | 2 | Two-word noun phrase, no verb. | Employee proxy concern | Chunking | Feature titles can be noun phrases if the body names the beneficiary. |
| "Our insurance plans ensure everyone is included" | Body opening | 7 | Followed by a list of family members including partners and in-laws. Inclusion named explicitly. | Buyer with a diverse workforce | Specificity; inclusion as proof | Name the people covered, not "family", so each reader finds themselves. |
| "True care goes beyond insurance, true care is transformative." | H3 lead | 9 | Comma splice with anaphora; abstract noun "transformative". | Buyer seeking differentiation | Repetition | Do not end on an abstraction; end on what the person can now do. |
| "Tech that turns benefits into breakthroughs" | H2 | 6 | Alliteration (benefits, breakthroughs). No end stop. | Tech-forward HR buyer | Processing fluency | One sound device per heading is enough; the claim must survive without it. |
| "MADE FOR THE MODERN HR" | Toggle label (buyer view) | 5 | Uppercase, audience named as a role. | HR buyer | Self-selection; Hick (two states) | Two-audience toggles name each audience by role, in parallel grammar. |
| "DESIGNED TO DELIGHT TALENT" | Toggle label (user view, active) | 4 | Alliteration; "talent" frames employees as an asset. Active state in coral. | Same buyer, imagining the employee | Perspective-taking | Let the buyer preview the user's experience in place, without leaving the page. |
| "Get instant access to all benefits - simple, smart, sorted." | Feature caption | 9 | Hyphen used as a dash, then a three-word alliterative tricolon. | Employee proxy | Rule of three | A tricolon of single words reads fast but carries no evidence; pair it with one specific. |
| "We've reimagined insurance and healthcare partnerships." | H2 | 6 | Full stop: the only H2 that closes with one, so it reads as a statement of intent. | Buyer burned by brokers | Contrast effect (implied) | A full stop on a heading signals a position, not a label; use it where the brand takes a stance. |
| "No misselling. No pressure. No jargon." | Body opening | 6 | Three negated fragments with full stops. Names category sins directly. | Sceptical buyer | Contrast effect; risk reversal | Name the category's known harms as things you refuse to do, in short negative fragments. |
| "TALK TO SALES" / "VIEW ADMIN JOURNEY" | CTA pair | 6 | Primary (filled coral) and secondary (outlined). Secondary routes to the buyer's own experience. | Buyer ready for a call, or not yet | Hick; choice architecture | Pair a high-commitment primary with a self-serve secondary that shows the product. |
| "Benchmarking" / "Customized plan" / "Smooth onboarding" | Step titles (STEP 1 to 3) | 5 | Nouns, parallel-ish, numbered by tag. | Buyer asking "what happens next" | Goal gradient; chunking | Three steps, each a short noun phrase, numbered visibly. |
| "Supporting corporate India's growth" | H2 | 4 | Local framing ("India's"), present participle. | Indian buyer | Similarity; national identity | Name the reader's market in the heading when the product is local. |
| "Trusted by 6000+ Indian businesses, from seed to IPO" | Proof tag | 9 | Number plus range ("seed to IPO") that covers every size. | Buyer of any size | Social proof; range framing | Use a range to say "people at your stage use this" without a segment page. |
| "KNOW MORE" | Row CTA (x4) | 2 | Repeated generic CTA in outline style. | Browsing buyer | Hick (low-salience repetition) | Repeated row links stay visually quiet so the primary CTA keeps its weight. |
| "Testimonial" | H2 | 1 | Single generic word, singular. | Proof seeker | None strong | Avoid category labels as headings; a heading should carry a claim. |
| "The difference is dramatic." | Quote opening | 4 | Short evaluative sentence before the detail (claims stuck for months, settled in a week). | Buyer with claim pain | Social proof; specificity | Lead a quote with the verdict, then the before and after in the customer's numbers. |
| "A letter from the founders" | H2 | 5 | Lower-case, plain. Sets a genre the reader knows. | Buyer deciding whom to trust | Authority; liking (Cialdini) | A named-person letter turns a company into people; keep it short and signed. |
| "Care is our universal language" | Letter sub-head (italic) | 5 | Italic, metaphor, no end stop. | Same | Brand value statement | Values statements need a proof behaviour beside them. |
| "Every company says they care. We set out to prove it." | Letter opening | 11 | Two sentences: category claim, then reversal. | Cynical buyer | Contrast effect; expectancy violation | Open trust copy by naming what everyone claims, then commit to evidence. |
| "Solving, not selling." | Letter value line | 3 | Antithesis with comma, two gerunds, full stop. | Buyer fearing upsell | Contrast; risk reversal | Short antithesis lines (do this, not that) state a boundary the reader can hold you to. |
| "Warmly," | Letter sign-off | 1 | One word, comma, then signatures. | Same | Liking | A human sign-off works only with real names beneath it. |
| "The New Standard of Health Benefits Is Waiting for Your Team" | Closing H2 | 11 | CSS capitalize forces Title Case; italic "of" and "for". 11 words. Echoes the H1 ("your team") and the proof H2 ("standard"). | Buyer at the end of the scroll | Echo and closure; consistency | Close by echoing the hero's key noun, so top and bottom form one frame. |
| "START NOW" | Closing CTA | 2 | Differs from the hero CTA ("GET A QUOTE"). | Same | Inconsistent with Hick and the same-words rule | Keep the primary CTA wording identical at top and bottom. |
| "IRDAI Registration No: 897, Direct Broker (Life & General)" | Footer compliance | 8 | Registry number and licence class; ampersand inside a legal label. | Diligent buyer | Authority (regulator) | Regulatory facts belong in the footer, verbatim and verifiable; never imply a licence you do not hold. |

### First-principles takeaways for Knowvia

- **A serif heading ramp at one weight, built by size alone.** Plum never bolds a heading; it steps 68, 52, 40 at
  -0.03em and leading 1.0. Newsreader can do the same: one weight, size steps, emphasis by italic on one word.
- **Uppercase is for actions, not headings.** Plum keeps every heading in sentence case and reserves 14px uppercase
  for buttons, toggles and nav. Knowvia can mark controls with Source Sans 3 and case, while Newsreader stays
  narrative.
- **A second audience can be a state, not a section.** The HR or talent toggle shows the same section through two
  eyes. Knowvia's partner block can show the household's view and the partner's view of the same brief, without
  adding a partner path to the hero.
- **Refusals build trust faster than promises.** "No misselling" style negations name the category's harm. Knowvia
  can name what it will never do (sell a policy, hide a condition) in short fragments, within truth rules.
- **Do not copy the accent contrast.** Coral at 3.1:1 under cream text fails AA; Harbour must clear 4.5:1 on its
  button text.

---

## 3. Thatch (health budgets for employers, US)

### Type system

Families [captured]: **v3Selecta** (a sans, 400 and 500) carries almost everything: display, headings, body,
buttons, eyebrows, footer. An older **Selecta** cut is used in the nav. **Soehne** appears only for the testimonial
name and title. Inter is loaded but computes only on nav `<li>` wrappers [captured; inferred to be an inheritance
artefact, not a design choice]. In practice this is a **one-family system**.

| Role | Family | Size px | Weight | Line-height (ratio) | Tracking | Case | Source |
|---|---|---|---|---|---|---|---|
| Display (H1) | v3Selecta | 63 | 500 | 1.00 | -0.63px (-0.01em) | Sentence, three deliberate lines | [captured] |
| Stat numerals | v3Selecta | 64 | 500 | 1.05 | -0.64px (-0.01em) | numerals, green | [captured]; marked up as `<h1>` three times |
| H2 | v3Selecta | 48 | 500 | 1.10 | -0.48px (-0.01em) | Sentence | [captured] |
| H3 (feature or closing statement) | v3Selecta | 36 | 500 | 1.14 | -0.36px (-0.01em) | Sentence | [captured] |
| H3 (card, step) | v3Selecta | 25 | 500 | 1.10 | -0.5px (-0.02em) | Sentence | [captured], 17 uses |
| Eyebrow | v3Selecta | 16 | 500 | 1.35 | +3.04px (+0.19em) | UPPERCASE, red or warm grey | [captured] |
| Body | v3Selecta | 20 | 400 | 1.30 | normal | Sentence, ink at 80% | [captured], 40 uses |
| Small / UI | v3Selecta | 16 | 400 | 1.50 | normal | Sentence | [captured] |
| Fine print | v3Selecta | 12 | 400 | 1.30 | normal | Sentence | [captured] |
| Button | v3Selecta | 18 | 400 | line box 12.375px (0.69; height comes from 14px padding) | -0.48px (-0.027em) | Sentence | [captured] |

- Hierarchy [captured]: one family, two weights. Headings are 500, text is 400; size steps 63, 48, 36, 25, 20, 16.
  Tracking tightens slightly on large sizes (-0.01em) and opens hard on eyebrows (+0.19em uppercase), so the
  eyebrow is the only place case and tracking do the work. Inactive tab copy drops to 40% to 70% opacity instead of
  changing size [captured].
- Display to body ratio: 63 / 20 = **3.15** [captured]. Body at 20px is unusually large, which lowers the ratio and
  makes reading effortless.
- Mobile H1: **45.5px** [captured, see capture note], line-height 1.0. Desktop to mobile ratio 63 / 45.5 = **1.38**:
  the headline shrinks little, so it stays the loudest thing on a phone.
- Pairing logic [inferred]: a warm, slightly humanist sans used for everything says "one voice, plain speech". The
  promise is predictability and simplicity, and the single family is that promise made visible.
- Semantic flaw [captured]: four `<h1>` elements (the hero plus three stat numerals). Screen-reader outline
  suffers; Knowvia should keep numerals out of heading elements.

### Colour and ground

| Token (captured) | Value | Role | Rough share of page height |
|---|---|---|---|
| Off-white | #FCFBF8 | Proof and how-it-works sheet | about 25% |
| Warm cream | #F8F4EE | Feature, segments, comparison | about 25% |
| Near-black warm | #151312 (sampled from screenshot) | Support band, closing and footer | about 40% |
| Ink | #261703 (warm brown-black) | Headings and body on light | text |
| Red | display-p3 (0.953, 0.086, 0.086), about #F31616 | Primary buttons, eyebrows, comparison logo, active step rule, wordmark | under 2% |
| Green | #66985C | Support metric numerals only | one row |
| Hero photo | sky blue, green hills | Hero | about 10% |

- Accent discipline [captured]: red only on actions, eyebrows and the brand's own name in the comparison table.
  Green appears once, on the metrics, as a "good" signal.
- Contrast [computed]: white on red is about **4.1:1** in sRGB (fails AA at 18px regular; display-p3 screens show a
  more saturated red, which does not change the luminance problem much). Ink on off-white about 16.8:1. Inactive tab
  body at 40% is about **2.3:1**, which fails AA; the active state carries the content.
- Ground shapes [captured in screenshot]: each new ground rises as a sheet with large rounded top corners over the
  previous one, so the page reads as stacked cards rather than stripes.

### Layout and rhythm

Max width [measured from screenshot]: about 1,280px (content x 80 to 1,360 at 1,440px). Section padding
[captured]: hero bottom 35px; then 80/120, 80/120, 80/80, 80/120, 80/80 (top/bottom). The pattern: 80px in, 120px
out where a new ground follows.

| # | Section | Layout family | Ground |
|---|---|---|---|
| 1 | Hero: announcement pill, three-line H1, sub-line, ghost "Get started" plus red "Book a demo", full-bleed photo of a person stretching | left text over full-bleed photo | photo |
| 2 | "TRUSTED BY 5,000+ COMPANIES" logo marquee | rounded sheet, centred eyebrow, marquee | #FCFBF8 |
| 3 | "You set the budget, your team picks the benefits": product UI card left, three-step tab list right, "See how it works" | split, UI plus tab list | #FCFBF8 |
| 4 | "Healthcare that goes beyond insurance": Thatch Market and Thatch Card, alternating text and animated demo | zig-zag | #F8F4EE |
| 5 | "Human-first support": bento grid (one wide card with portrait, one narrow, three equal), metrics row with industry averages, large testimonial quote | bento grid then stat row then quote | near-black |
| 6 | Carrier logos, then "Better benefits for businesses of all sizes": four segment cards, then two wide cards for brokers and payroll platforms | logo row, four-up plus two-up | #F8F4EE |
| 7 | "How Thatch compares to the status quo": two-column comparison table, red "See how it works" | centred table | #F8F4EE |
| 8 | Closing: red eyebrow, 36px statement, two CTAs, line-art arc, then footer with compliance text | left-aligned CTA panel, footer grid | near-black |

- Alignment [captured]: left for hero, steps, features and closing; centred for eyebrows, section H2s in the proof
  and comparison zones, and the support heading.
- Imagery [captured]: one real person in the hero, one real support-team portrait, product UI cards, and animated
  product demos (blank in the static capture). No illustration.
- Two audiences [captured]: the **pronoun split** separates them inside single lines: the employer is "you", the
  employee is "your team", "employees" or "they". Support cards alternate between employee benefit and HR benefit
  ("One fewer job for HR"). Partners (brokers, payroll platforms) get their own lower row of wider cards in the
  segment grid, each with one line framed as the partner's own win.

### Motion

- Logo marquee [captured]: `v3-marquee 125s linear infinite`. Very slow; purpose is presence without distraction.
- Scroll-driven parallax [captured: `parallax auto linear 1` on 8 elements]. A duration of `auto` is the signature
  of a CSS scroll-timeline animation [inferred]. Purpose: depth on images as the sheets slide over each other.
- Pop-in reveals [captured]: `preReveal` found 5 images at opacity 0 and scale 0.8 before scrolling, and 5 elements
  carry `transform, opacity 0.5s cubic-bezier(0.34, 1.56, 0.64, 1)`, an overshoot ("back out") curve. The count
  matches the five carrier logos [inferred]. Purpose: a small celebratory beat on proof.
- Softer reveals [captured]: 3 elements with `transform, opacity 0.6s cubic-bezier(0, 0, 0.2, 1)` (ease-out)
  [inferred: the three support metrics].
- Product demos [captured keyframe names]: `cardOrderVirtualIn`, `cardOrderPhysicalIn`, `cardCheckoutSheetUp`,
  `cardCheckoutTapPulse`, `cardCheckoutRingFill`, `cardCheckoutDoneIn` and more. These script a card order and a tap
  to pay sequence [inferred]. Purpose: show the outcome (spending the budget) instead of describing it.
- Auto-advancing steps [inferred]: the three steps are `<button>`s with one at full opacity and a red left rule,
  the others at 70% (title) and 40% (body). Purpose: guide the eye one step at a time.
- Ambient [captured keyframes]: `cloudDrift`, `easeDown`, `bounceIn`, `navScrollFade`, `wave-animation`, `pulse`.
- Hover [captured]: colour changes in 0.15s `cubic-bezier(0.4, 0, 0.2, 1)` on 39 elements; card lift with
  `transform, box-shadow 0.15s cubic-bezier(0.33, 1, 0.68, 1)` on 6; arrow icons with `transform 0.25s
  cubic-bezier(0.65, 0, 0.35, 1)`; a stroke-draw (`stroke-dashoffset 0.25s`).
- Reduced motion [captured]: **12** `prefers-reduced-motion` rules, the most of the three sites.
- No GSAP, Lenis, Swiper or AOS [captured]: Thatch's motion is CSS-native.

### Copy, line by line

| Line (verbatim) | Role | Words | Punctuation and syntax | Buyer state targeted | Principle | Transferable rule |
|---|---|---|---|---|---|---|
| "Announcing our Series C fundraise at a $1B valuation" | Announcement pill | 9 | Dark pill with chevron, sits above the H1. | Buyer worried about vendor risk | Authority; stability signal | A single news pill above the H1 can carry stability proof, if it is real and dated. |
| "Upgrade from health benefits to health budgets" | H1 | 7 | "from X to Y" structure; repeats "health" to make the swap obvious. No end stop. Three lines with a planned break before each "health". | Buyer who knows the old model | Contrast effect; processing fluency | Name the old thing and the new thing in one line, with a repeated word so only the changed word is new. |
| "Give every employee a health budget to choose care that fits their life, and get predictable costs that you can plan around." | Hero sub-line | 22 | Two clauses joined by ", and": first the employee's gain, then the buyer's. 22 words, long for a sub-line. | Buyer weighing both sides | Two-audience framing; reciprocity | Give each audience one clause of the sub-line, the user's first, the buyer's second. |
| "Get started" | Ghost CTA (hero) and nav CTA | 2 | Two-word imperative, translucent in the hero, red in the nav. | Self-serve buyer | Fogg ability | The low-commitment route can be the quieter button when the demo is the business's main ask. |
| "Book a demo" | Primary CTA (hero) | 3 | Imperative with article; red filled pill. | Buyer ready to talk | Commitment; Hick | Name the next step, and make only one button the coloured one. |
| "TRUSTED BY 5,000+ COMPANIES" | Eyebrow over logos | 4 | Uppercase, wide tracking, red, number with "+". | Sceptical buyer | Social proof | A proof eyebrow should hold the number; the logos below confirm it. |
| "You set the budget, your team picks the benefits" | H2 | 9 | Comma splits two clauses with two subjects; no end stop. Parallel verbs (set, picks). | Buyer imagining roles | Role clarity; pronoun mapping | Assign one verb to each audience in the same sentence, so roles are clear without a diagram. |
| "You set a health budget" | Step 1 title | 5 | Second person, present tense, active. | Buyer | Goal gradient | Step titles are full clauses with an actor and a verb. |
| "Employees choose their insurance" | Step 2 title | 4 | Switches actor to employees, third person. | Buyer imagining staff | Perspective-taking | Change the grammatical subject when the actor changes. |
| "They spend what’s left on what matters" | Step 3 title | 7 | Pronoun "They", ends on values phrase. | Same | Endowment and ownership framing | End the sequence on the user's freedom, not on the product's function. |
| "See how it works" | Secondary CTA | 4 | Outline pill after the steps; red pill after the comparison table. | Curious buyer | Hick; curiosity | A neutral "show me" link after explanation is a safe secondary action. |
| "Healthcare that goes beyond insurance" | H2 | 5 | Relative clause; "beyond" signals expansion. | Buyer seeking more value | Category expansion | Frame extras as what the reader gets beyond the category, then itemise. |
| "We include Thatch Market for every employer; there's no additional cost, contracts, or administration required." | Feature body | 15 | Semicolon joins promise and its three removed frictions. | Buyer fearing hidden cost | Risk reversal; specificity | State what is included, then list the costs that do not apply. |
| "No reimbursement forms or waiting periods" | Feature body fragment | 6 | Negation of two familiar frictions. | Employee proxy concern | Contrast effect | Name the paperwork the reader dreads and say plainly that it is gone. |
| "Human-first support" | H2 (dark band) | 2 | Compound adjective with hyphen; noun last. No end stop. | Buyer fearing call-centre service | Value framing | A two-word heading can carry a stance if the section proves it with numbers. |
| "Healthcare has some of the worst customer service ratings of any industry." | Sub-line, sentence 1 | 12 | Names the category's failure as a fact. | Buyer with past bad service | Contrast effect; pain naming | Name the category's operational failure (service, clarity), never the reader's fear. |
| "We built Thatch differently, with support designed around the moments employees and HR teams need us most." | Sub-line, sentence 2 | 17 | Both audiences named in one phrase ("employees and HR teams"). | Same | Two-audience framing | When a promise serves both audiences, name both once in the same clause. |
| "One fewer job for HR" | Support card title | 5 | Fragment; quantified relief ("one fewer"). | HR lead overloaded | Fogg ability; loss of effort | Frame a benefit as work removed from the buyer's list. |
| "Support metrics in real time." | Metric intro (H3) | 5 | Full stop on a heading-sized line: a statement of policy. | Diligent buyer | Authority; transparency | When you publish a metric, say why you publish it. |
| "We publish our live support metrics because we believe in transparency and accountability." | Metric intro, line 2 | 13 | "because" gives the reason (Langer's "because" effect). | Same | Reason-giving; transparency | Give the reason for a disclosure in one "because" clause. |
| "1.5h" / "Average response time" / "vs industry avg: 8 hours" | Stat, label, comparator | 9 | Numeral, plain label, then a comparator line in grey. | Finance and HR buyer | Contrast effect; anchoring | Every number gets a reference point the reader can judge it against. |
| "“The majority of our employees were seeing a cost decrease. Better coverage at a lower cost.”" | Testimonial (36px) | 16 | Two sentences; the second is a verbless summary of the gain. Set at heading size. | Finance buyer | Social proof; specificity | Set one short customer quote large; the summary sentence should be quotable alone. |
| "Director of People Operations, Crossroads" | Attribution | 5 | Role and company in a separate face (Soehne). | Buyer checking peers | Authority; similarity | Attribute with role and organisation type; for consumers, initial, age and city are enough. |
| "Read case study" | Quote CTA | 3 | Imperative, translucent pill. | Buyer wanting depth | Curiosity | Offer depth after proof, never instead of it. |
| "INSURANCE PLANS FROM TOP CARRIERS" | Eyebrow over carrier logos | 5 | Uppercase, warm grey, not red: proof of supply, not a call to act. | Buyer checking plan quality | Authority by association | Keep the accent for calls to act; informational eyebrows take a neutral colour. |
| "Better benefits for businesses of all sizes" | H2 | 7 | Alliteration ("Better benefits", "businesses"). | Buyer checking fit | Self-selection | A segment grid heading promises fit for all, then each card names a specific pain. |
| "Great benefits, no HR hire required." | Segment card (startups) | 6 | Gain, comma, removed cost. | Startup founder | Fogg ability | Each segment line pairs a gain with the cost it removes for that segment. |
| "Costs that don't swing wildly at renewal." | Segment card (SMB) | 7 | Negated volatility; a moment named ("at renewal"). | SMB owner fearing renewal | Loss aversion (named moment) | Tie a promise to the calendar moment when the pain bites. |
| "Brokers" / "Be the hero when the renewal hits." | Partner card | 8 | Partner addressed by role; second-person imperative about their own status. | Broker (partner) | Identity framing; self-interest | Speak to a partner about their win with their own clients, in one line. |
| "Payroll Platforms" / "Add benefits and grow your business." | Partner card | 8 | Two imperatives joined by "and": action then reward. | Platform partner | Reciprocity; commercial logic | A partner line names what they add and what they gain, nothing more. |
| "How Thatch compares to the status quo" | H2 (comparison) | 7 | Names the alternative as "the status quo". | Buyer comparing | Contrast effect | Name the incumbent as a model, not a competitor. |
| "Traditional group benefits don't meet the needs of employees and employers today." | Comparison sub-line | 12 | Names both audiences; "today" dates the old model. | Same | Contrast; temporal framing | The comparison intro says who the old way fails, then the table shows how. |
| "Each employee gets benefits that fit their life." | Table row (Thatch side) | 8 | Full sentence with full stop, check icon, dark ink. | Buyer | Contrast effect | In comparisons, give your side full sentences in dark ink and the old side muted ink. |
| "One plan chosen for everyone." | Table row (status quo side) | 5 | Fragment, grey, prohibition icon. | Same | Contrast effect | Describe the old way neutrally and briefly; the layout does the judging. |
| "One bad claim and your costs jump." | Table row (status quo) | 7 | Conditional with "and"; second person makes it personal. | Finance buyer | Loss aversion | Name the old way's risk as a concrete cause and effect. |
| "GET STARTED" | Closing eyebrow (red) | 2 | Uppercase eyebrow repeating the CTA verb. | Buyer at the end | Consistency | The closing eyebrow can restate the primary action as a label. |
| "A health budget for every employee. Set your budget, invite your team, and we handle the rest." | Closing statement (36px) | 17 | Fragment then a three-step imperative tricolon; "we handle the rest" closes on relief. | Buyer ready to act | Goal gradient; Fogg ability | Close with the whole journey in three verbs, ending on what you take off their hands. |
| "Building a healthcare system people love" | Footer tagline | 6 | Present participle, mission-sized. | Any reader | Mission framing | A footer line can carry the mission; the hero should carry the offer. |

### First-principles takeaways for Knowvia

- **One family, many roles, done with weight and space.** Thatch runs the whole page on one sans at two weights,
  with body at 20px. Knowvia's Source Sans 3 can carry every functional role at 18px and up, with Newsreader kept
  to display only, exactly as the non-negotiables require.
- **Pronouns separate audiences without separate pages.** "You" is the buyer, "your team" the user. Knowvia's
  household story can keep "you" for the household operator throughout, and the partner block can switch to
  addressing "your users" so the shift itself marks the audience change.
- **Partners get a smaller, wider card and one self-interested line.** Thatch's broker and payroll cards sit below
  the main segments, wider and shorter. This is a direct model for Knowvia's single partner block: one line on the
  partner's own gain, one low-commitment CTA.
- **Every number has a comparator, and motion lands on proof.** Metrics carry "vs industry avg"; the overshoot
  reveal is used only on proof logos. Knowvia's research-backed figures should carry their evidence ID and a reference
  point, and any reveal should be brief and optional.
- **Accessibility gaps to avoid:** 40% inactive text (2.3:1) and white on red (4.1:1) both fail AA, and the stats
  are `<h1>`s.

---

## 4. Cross-site synthesis (benefits insurtech group)

### Shared type moves

| Move | Onsurity | Plum | Thatch | Rule for Knowvia |
|---|---|---|---|---|
| Display family | Geometric sans (Space Grotesk) | Book serif (GT Alpina) | Humanist sans (v3Selecta) | Serif (Newsreader) suits a calm, trust-first household promise; keep it to display. |
| Heading weight | 500 [research doc] | 400 everywhere | 500 everywhere | Use one heading weight; build hierarchy with size steps. |
| Display tracking | not captured | -0.03em | -0.01em | Tighten display slightly (around -0.01em to -0.02em for a serif with tall x-height); never track body. |
| Display leading | not captured | 1.00 | 1.00 to 1.14 | Solid leading (1.0 to 1.1) on display; 1.4 to 1.6 on body. |
| Display to body | 3.6 (inferred) | 4.25 | 3.15 | A ratio of about 3 to 3.5 with an 18px body keeps calm; Plum's 4.25 is more theatrical. |
| Desktop to mobile H1 | not captured | 2.1 | 1.38 | Shrink display less than 2x on mobile so the headline stays dominant. |
| Uppercase | not captured | buttons, nav, toggles | eyebrows only, +0.19em | Reserve uppercase for one role (eyebrows) with open tracking; buttons stay sentence case. |
| Emphasis | Title Case | italic word | weight and colour in table | Emphasise by italic or by one bold claim, never both in one line. |

### Motion vocabulary

| Device | Where seen | Captured values | Knowvia stance (MOTION_INTENSITY 3) |
|---|---|---|---|
| Hover colour and lift | Plum, Thatch | 0.15s to 0.25s, ease or ease-out | Keep: 150 to 200ms, colour and 1 to 2px lift only. |
| Long settle | Plum | 0.8s ease-out-expo | Use sparingly for one large card state change; never on text. |
| Reveal on scroll | Thatch (5 images, overshoot), Onsurity counters | 0.5s back-out; counters from zero | If used, opacity plus small translate, ease-out, no overshoot; content visible without JS. |
| Marquee | Thatch | 125s linear infinite | Not needed: Knowvia has no logo wall (non-negotiable 4). |
| Scroll-driven parallax | Thatch | `animation-duration: auto` x8 | Avoid; adds motion without meaning. |
| Product demo animation | Thatch | scripted keyframe series | One short, real-UI demo of the brief is the strongest motion candidate; must pause and respect reduced motion. |
| Carousel | Plum | Swiper, 1/3 pager | Avoid for quotes; show two or three static quotes. |
| Reduced motion | 1 rule (Onsurity shell), 0 found (Plum), 12 (Thatch) | | Match Thatch: every animation has a reduced-motion off switch. |

### Copy cadence

- **Headlines are short, unpunctuated labels; full stops are reserved for stances.** Plum's one full-stopped H2 and
  Thatch's "Support metrics in real time." are the moments the brand takes a position.
- **Sub-lines carry the audience split.** Thatch's hero sub-line gives one clause to the employee and one to the
  buyer; Plum's names the segment after a comma.
- **Negation builds trust.** "No misselling. No pressure. No jargon." and "No reimbursement forms or waiting
  periods" both name the category's harm and refuse it.
- **Numbers arrive with a frame.** Plum puts numbers under awards; Thatch adds an industry comparator; Onsurity
  localises units. The comparator is the strongest of the three.
- **Weak spots to avoid:** generic headings ("Testimonial"), absolutes ("never need another"), abstract endings
  ("transformative"), and a closing CTA that changes wording from the hero (Plum).

### Two-audience patterns

| Pattern | Site | How it works | Fit for Knowvia (households first, one partner block) |
|---|---|---|---|
| Pronoun mapping | Thatch | "you" is the buyer, "your team" and "they" are users | Strong. Keep "you" for the household; the partner block addresses "your users" or "your clients". |
| In-section perspective toggle | Plum | Two labelled states show the same section through two eyes | Medium. Could show "what you see" and "what your adviser sees" for one brief, inside the partner block only. |
| Segment grid with a partner row | Thatch | Main segments first, then a wider, shorter row for brokers and platforms | Strong. Matches the single partner block lower on the page with its own CTA. |
| Buyer proof, user benefit alternation | Plum, Onsurity | Proof sections for the buyer, inclusion and ease for the user | Partial. Knowvia's buyer and user are the same household operator; the second reader is the parent, served by the permission promise. |
| Nav-level audience router | Plum | "+ EXPERIENCE" menu by role | Weak. Adds a choice to the first screen (Hick); keep the partner route out of the hero. |
