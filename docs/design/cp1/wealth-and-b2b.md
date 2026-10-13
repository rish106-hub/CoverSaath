# CP1 teardown: wealth and B2B restraint (Dezerv, Cardless)

Checkpoint CP1, reference teardown. Sites in this file: **Dezerv** (https://www.dezerv.in/, wealth management for affluent
Indian investors) and **Cardless** (https://www.cardless.com/, B2B embedded credit card platform). Both sit at the
"serious, premium, restraint" end of the reference set. This file reverse-engineers how they build authority and how
they set themselves against the old way, with weight on typography, design language, copy and motion.

## Method, evidence and labels

| Item | Dezerv | Cardless |
|---|---|---|
| Capture run | Pre-existing capture, 13 Oct 2026 05:37 UTC, status 200, 167 copy items, 40 type combos, page height 15,745px | Captured in this checkpoint with the unchanged `capture.mjs`, first attempt, status 200, 58 copy items, 9 type combos, page height 8,759px |
| Screenshots read | desktop hero (1440x900), desktop full page, mobile hero (390 CSS px at 2x) | same set |
| Extra read-only probes | Small Playwright probe (public page, no login, no form): builder meta, Lenis class, appear elements, Lottie count, video attributes, scroll-scrubbed text progression, header position, same page under emulated `prefers-reduced-motion: reduce` | Same probe shape: Lenis class, appear count, video attributes, sticky feature opacity at four scroll positions, same page under emulated reduce; plus the public HTML (Framer CSS variables for breakpoints, tracking, padding) |
| Not available | Public HTML by curl returned a CloudFront 403, so Dezerv CSS source was not read. Hover states not exercised. Transition durations and easing not exposed (see Motion) | Hero video did not play in headless Chromium (element present, `paused: true`), so the hero media shows only its sage poster ground |

Labels used below:

- **[captured]**: read from computed styles, the DOM, the page HTML or a probe result.
- **[measured]**: read from screenshot pixels with a script (positions, colours, sizes). Accurate to about 2px.
- **[inferred]**: my reading of intent or behaviour that the evidence supports but does not prove.
- Contrast ratios are computed with the WCAG 2.x formula from sampled colours [measured]. They are not a full audit.

Copy is quoted verbatim only inside the analysis. Nothing here proposes reusing their lines. Every suggestion for
Knowvia is written without em dashes or en dashes.

---

## 1. Dezerv

### 1.1 Type system

**Families and roles [captured].** Two families, split by job, not by hierarchy level:

- **Poppins 500** (geometric sans): hero, section headlines, the founder manifesto, Dezerv's side of the contrast cards, the closing footer line. It is the "voice of the house".
- **Inter 300 to 700** (neo-grotesque): everything else, including the old-way lines, service headlines, testimonials, names, body, buttons, legal.

The split is the point: the brand's promises are always Poppins, the incumbent's failings are always Inter. Typeface
itself carries "us" and "them".

**Ramp [captured unless marked].**

| Role | Family | Size px | Weight | Line-height (ratio) | Tracking | Case |
|---|---|---|---|---|---|---|
| Display (hero H1) | Poppins | 92 | 500 | 102 (1.11) | -2px (about -0.022em) | Title Case |
| H2 (section) | Poppins | 82 | 500 | 92 (1.12) | -2px (about -0.024em) | Sentence case |
| Manifesto (styled H1) | Poppins | 60 | 500 | 75 (1.25) | -2.4px (-0.04em) | Sentence case |
| H3, Dezerv claim in contrast card | Poppins | 42 | 500 | 52 (1.24) | -0.08px (near 0) | Sentence case |
| H3, old-way line in contrast card | Inter | 40 | 400 | 50 (1.25) | -0.08px | Sentence case |
| H3, service panel headline | Inter | 60 | 600 | 70 (1.17) | -0.62px (about -0.01em) | Sentence case |
| Testimonial quote | Inter | 54 | 500 | 67 (1.24) | normal | Sentence case |
| Eyebrow, hero | Inter | 16 | 500 | 19.2 (1.2) | -0.02px | Typed in capitals (`text-transform: none`) |
| Eyebrow, service panel | Inter | 24 | 500 | 35 (1.46) | normal | Typed in capitals, coloured (#4EB3A9, #4352D1) |
| Body (lists, trust card copy) | Inter | 20 | 400 | 30 to 32 (1.5 to 1.6) | -0.02px | Sentence case |
| Small (disclosure, legal) | Inter | 12 | 300 | 14.4 to 18 (1.2 to 1.5) | normal | Sentence case |
| Button label | Inter | 18 | 600 | 21.6 (1.2) | normal | Sentence case |
| Footer links | Inter | 16 | 500 | 28 (1.75) | normal | Title Case |

**How authority is built.**

- **Scale, not weight [captured].** The display is 500, never 700. The hero at 92px is the largest headline in the whole 11-site set (research doc). Authority comes from size and from the absence of any competing element: the hero has an H1, one pill and nothing else.
- **Fixed negative tracking at display sizes only [captured].** -2px from 82px up, -2.4px on the 60px manifesto, then effectively zero from 42px down. Tight tracking makes the big lines read as one solid shape; small text is left at default for legibility.
- **Fixed px tracking does not scale [captured, consequence inferred].** On mobile the H1 drops to 42px but keeps -2px, which becomes about -0.048em, twice as tight relative to size as desktop. The mobile hero looks denser and more "set" than desktop.
- **Inversion inside the contrast card [captured].** The old-way line (Inter 40px, 400) is almost as large as Dezerv's claim (Poppins 42px, 500). It is not made small; it is made dim (grey on near-black). Size says "this is a real problem", colour says "this is the past".

**Ratios.** Display to body: 92 / 20 = **4.6** [captured values]. Mobile hero H1: **42px**, line-height 50.4 (1.2), tracking -2px [captured]. Desktop to mobile: 92 / 42 = **2.19**. Line-height loosens on mobile (1.11 to 1.2) because the three-line wrap needs air [captured values, reason inferred].

### 1.2 Colour and ground

| Role | Value | Proportion of full page | Evidence |
|---|---|---|---|
| Ground | #000000 | about 67% near-black (<= #1A1A1A) | [captured] page ground; proportion [measured] at 1/8 scale |
| Raised dark surface (old-way cards, team rows, trust card, offices card) | #121212 to #141414 | part of the 7% dark grey band | [measured] |
| Timeline rail | #333333, 1px | trace | [measured] |
| Primary text on dark | #FFFFFF (21:1) | | [captured] |
| Secondary text on dark | rgba(255,255,255,0.7), #B3B3B3, #BFBFBF | | [captured] |
| Old-way text | rgba(169,169,169,0.8), renders #8A8A8A on #121212 (about 5.4:1) | | [captured] + [measured] |
| Light surfaces (Dezerv claim cards, service panels) | #F8F8F8 text half, #FFFFFF illustration half, full-bleed #FFFFFF panels | about 18% light grey and white | [measured] |
| Accents | Teal #4EB3A9 (eyebrow, product UI), indigo #4352D1 (eyebrow), coral and teal markers inside illustrations | about 3% chromatic, almost all inside product illustrations and photos | [captured] eyebrow colours, [measured] share |
| Primary action | White pill, black label on dark ground; black pill, white label on white panels | | [measured] |

**How the dark ground is handled.**

- Black is the default, and light is the exception that marks "Dezerv's product". Every white or near-white surface on the page is either Dezerv's own claim card, a product illustration or a service panel. The incumbent never gets a light surface [measured, intent inferred].
- The action colour is not a hue. It is the inversion of the ground (white on black, black on white). On a near-zero-accent page, the highest-contrast object is the button [measured].
- Hue appears only inside product mock-ups and two eyebrows, so colour reads as "data" rather than "brand" [inferred].
- Weak spots [measured]: the hero eyebrow #696969 on black is 3.8:1 at 16px (fails AA for normal text); the teal service eyebrow on white is 2.5:1 (fails); the manifesto's unlit text #333 on black is 1.66:1 until the scroll effect lights it.

### 1.3 Layout and rhythm

**Section sequence [captured order, layout family from screenshots].**

| # | Section | Layout family | y (px) |
|---|---|---|---|
| 1 | Hero: H1 and one pill CTA, no sub-line | Left-aligned, text only, on black | 160 to 484 |
| 2 | "HEAR FROM OUR CLIENTS": video testimonial carousel | Horizontal card carousel bleeding off the right edge; each card is video left, quote right on light grey | 544 to about 1190 |
| 3 | Founder manifesto with founder attribution (photo, name, role) | Single centred column, scroll-scrubbed text | 1383 to about 2150 |
| 4 | Radial grey halo forming a horizon arc | Decorative transition into the next section | about 2300 to 2860 |
| 5 | "How Dezerv does things differently": four-step us-versus-them timeline | Centred H2, then a narrow column (about 904px) with a left rail | 2863 to about 6500 |
| 6 | "How Dezerv can help you": two service panels | Full-bleed white panels with rounded top corners; left text with tab list, right illustration | 7051 to about 9400 |
| 7 | "Meet our team of experts" | Centred H2, accordion rows (avatar, name, role, plus icon) | 9737 to about 10650 |
| 8 | "Dedicated client partners you can trust" | Split: H2 left, three-step vertical stepper right; then a card carousel of greyscale portraits with "Managing portfolio for" lists | 10989 to about 12150 |
| 9 | "Insights for our clients" | Three content cards | 12311 to about 12850 |
| 10 | "Come visit us at any of our offices" | Dark card, dot-matrix India map with city pins, one pill | 13359 to about 13900 |
| 11 | Footer: closing line, app QR, link columns, newsletter, trust trio (ISO 27001, Secure and private, Regulated entity), statutory text | Multi-column | 14286 to 15745 |

**Grid and width [measured].** Hero text starts at x=60. Testimonial cards start at x=40. The contrast timeline is a
narrow reading column: rail at x=250, cards from x=317 to x=1220 (about 904px wide), so the comparison is read like a
document, not scanned like a grid. Footer content spans about x=76 to x=1364 (about 1288px).

**Section padding [captured + measured].** Framer stacks carry no CSS padding (computed `padding: 0` on all large
blocks), so spacing comes from stack gaps. Measured gaps: hero CTA to eyebrow 60px; eyebrow to carousel about 50px;
carousel to manifesto about 190px; manifesto to the next H2 about 700px (the halo fills it); centred H2 to first
timeline card about 270px; pitch between timeline steps about 810px (456px light card plus 256px dark card plus about
100px gap). The page is long (15,745px) because each idea gets a near full viewport.

**Alignment [measured].** Left alignment for the hero, service panels and footer. Centre alignment for every section H2
and for the manifesto. The comparison column is offset slightly right of centre by the rail.

**Imagery [captured + measured].**

- People: real clients on video (names and company roles), the co-founder beside the manifesto, three named leaders in the team accordion, seven named client partners with greyscale portraits and LinkedIn icons.
- Product: illustrative UI inside each Dezerv claim card ("Aman's Portfolio", "Rebalance Needed"), each captioned "For illustrative purposes only."
- No partner logos. Proof is people, regulators and offices, not brands.

**The contrast device, exact structure [captured copy and type, measured geometry].**

```
section H2, centred, Poppins 82: "How Dezerv does things differently"

rail (1px #333) with numbered badge "01" ... "04"
 ┌──────────────────────────────────────────────┐
 │ DEZERV wordmark                │ product UI  │  light card #F8F8F8 / #FFFFFF, about 904 x 456
 │ Poppins 42/500 black claim     │ illustration│  caption "For illustrative purposes only."
 └──(VS)────────────────────────────────────────┘  black "VS" disc overlaps the seam, left
 ┌──────────────────────────────────────────────┐
 │ "Traditional wealth firms"  Inter 32/500 white│  dark card #121212, about 904 x 256
 │ old-way line  Inter 40/400, #8A8A8A           │
 └──────────────────────────────────────────────┘
 x4, with about 100px between pairs
```

- Order: the new way always comes first and on top; the old way is the footnote under it.
- Light versus dark surface, Poppins versus Inter, black versus grey: three redundant signals for "us" and "them", so the contrast does not rely on colour alone.
- The label "Traditional wealth firms" names a **category**, not a company, and is repeated four times, so the criticism is about a practice.
- Each pair is a parallel predicate. The Dezerv line and the old-way line answer the same implied question (who watches my portfolio, how fast is action, who decides, how am I told).
- One pair carries a "View Disclosure" link: the claim is footnoted where it is made.

### 1.4 Motion

| What moves | How | Label |
|---|---|---|
| Whole page | Built on Framer (`<meta name="generator" content="Framer c142a8f">`). Smooth scrolling by Lenis: `<html class="lenis lenis-smooth">` | [captured] |
| Hero H1, hero CTA, hero eyebrow | Framer "appear" elements (16 `data-framer-appear-id` nodes on the page). After settling they still carry a `matrix3d` with a perspective term, so they enter with a 3D translate or scale and fade | [captured] element list and residual transform; entrance shape [inferred] |
| Founder manifesto | Scroll-scrubbed reading highlight. The full 216-character paragraph sits at #333 on black; a white span grows from the start as the block rises. Probe: 18 characters lit when the block top is 700px below the viewport top, 42 at 600px, 60 at 500px, 100 at 300px, 134 at 100px, 178 at 0px. About one character per 4px of scroll; fully lit after the top passes the viewport top | [captured] |
| Testimonials | Two `<video>` elements, `autoplay loop muted` with native controls; duration badges "00:58" and "00:47" visible. Carousel with arrow buttons | [captured] attributes; carousel behaviour [inferred] from arrows |
| Product illustrations, icons | Seven Lottie elements on the page | [captured] count; which illustrations animate [inferred] |
| Team rows | Accordion, plus icon expands a row (Framer variant "Desktop - IT / Collapsed") | [captured] variant name; animation [inferred] |
| Service panels | Tab list with a vertical rule marking the active item; the active item is black, others grey | [measured] states; switching motion [inferred] |
| Header | Navigation items report y = -64 at the top of the page and after a scroll up; the desktop hero screenshot shows no header | [captured]; hide-on-scroll intent [inferred] |
| CSS motion | Zero CSS transitions, zero CSS animations, zero `@keyframes` in readable sheets: all motion is driven by Framer's JavaScript runtime, so durations and easing are not exposed | [captured] |
| Reduced motion | Zero `prefers-reduced-motion` rules. With the preference emulated as `reduce`, Lenis stays on, the manifesto scrub behaves identically and the videos still autoplay | [captured] |

**Purpose [inferred].** Motion is used to **slow reading down** where Dezerv wants a decision to feel considered: smooth
scroll lengthens every gesture, and the manifesto makes the reader earn each clause. Video gives faces and voices to
proof. **Cost [captured]:** none of it respects reduced motion, the unlit manifesto is 1.66:1 until scrolled, and
autoplay video runs regardless of preference.

### 1.5 Copy, line by line

Word counts exclude standalone ampersands and numerals.

| # | Line (verbatim) | Role | Words | Punctuation and syntax | Buyer state targeted | Principle | Transferable rule |
|---|---|---|---|---|---|---|---|
| 1 | Your Trusted Investment Partner | Hero H1 | 4 | Title Case, no verb, no full stop. A noun phrase reads like a name or a title, not a sentence | Sceptical, comparing advisers | Authority by naming a role, not a feature | A hero can state the role you play in the buyer's life; keep it a noun phrase only if the next screen supplies the verb |
| 2 | Review my portfolio | Hero CTA | 3 | First person "my", sentence case, arrow glyph, no full stop | Ready to act on something they already own | Endowment: it is the buyer's asset being reviewed | Make the first action about the visitor's own thing, in their voice |
| 3 | HEAR FROM OUR CLIENTS | Eyebrow | 4 | Typed in capitals, imperative | Wants proof before trust | Social proof placed before the pain | An eyebrow can be an instruction to the reader, short and uppercase, in a dim colour |
| 4 | “Dezerv brought simplicity and clarity to my investments.” | Testimonial | 8 | Curly quotes, full stop inside, sentence case, 54px | Overwhelmed by complexity | Outcome in the customer's words (clarity) | Choose quotes that name the feeling the product replaces, not a feature |
| 5 | “I am sure Dezerv will invest my money better than I could.” | Testimonial | 12 | Comparative "better than I could" | Doubts own ability | Delegation framed as relief | A quote can concede the reader's limits so the product does not have to |
| 6 | Founder & CEO, EMoMee | Proof label | 3 | Ampersand to save width; comma before company | Checks that the voice is real | Authority by title | Attribute every quote with a role the reader respects; never leave it anonymous unless consent requires |
| 7 | Traditional wealth management is broken & you need a better way to manage your money. | Manifesto, sentence 1 | 14 | Ampersand joins verdict and need in one breath; full stop ends the verdict | Already suspicious of incumbents | Pain named as a system failure, not the reader's fault | Name the broken situation first, then the need, in one sentence the reader can agree with |
| 8 | Using unbiased data driven decisions, we ensure your investment journey is successful so you can focus on what matters most to you | Manifesto, sentence 2 | 22 | Fronted participle, no hyphen in "data driven", no closing full stop | Wants to stop worrying | Promise plus freed attention | Pair the verdict with what the reader gets back (time, attention), but avoid outcome guarantees ("ensure ... successful") |
| 9 | Co-Founder, Dezerv | Manifesto attribution | 2 | Title Case role | Wants a person accountable | A named founder signs the critique | Put a human name under the strongest claim |
| 10 | How Dezerv does things differently | Section H2 | 5 | "How" statement without question mark; brand name in the line | Comparing options | Contrast effect announced | Announce a comparison plainly before showing it |
| 11 | 01 / 02 / 03 / 04 | Step numerals | 0 | Two-digit, zero-padded | Wants a finite list | Closure: four items, numbered | Number a comparison so the reader knows its length |
| 12 | We track the market’s impact on your portfolio daily | Contrast, us (1) | 9 | "We" subject, time word last for weight, no full stop | Fears being ignored | Vigilance as service | End the line on the word that carries the difference (here a frequency) |
| 13 | VS | Contrast connector | 1 | Capitals, no full stop, inside a black disc | Scanning | A single glyph-like word joins the pair | The connector should be a mark, not a sentence |
| 14 | Traditional wealth firms | Contrast label, them | 3 | Category noun, Title-ish "Traditional" repeated 4 times | Recognises the old experience | Criticise a category, never a named firm | Label the old way as a situation everyone recognises |
| 15 | Your RM is busy searching for new clients & rarely tracks your portfolio | Contrast, them (1) | 12 | Jargon "RM" assumed; ampersand; no full stop | Has felt neglected | Motive exposed (the adviser is selling) | Describe the old way through the reader's lived moment, in plain words, without assigning bad intent you cannot prove |
| 16 | Instantly evaluates if your portfolio needs a change | Contrast, us (2) | 8 | Subject dropped, so the DEZERV wordmark above acts as subject | Wants speed | Speed as care | A dropped subject works when a label above the line supplies it |
| 17 | Delay action on your portfolio due to manual processes | Contrast, them (2) | 9 | Subject dropped; label "Traditional wealth firms" is the subject | Frustrated by slowness | Cause named (manual) | Name the mechanism of the failure, not just the failure |
| 18 | Automatically capitalises on opportunities | Contrast, us (3) | 4 | British spelling "capitalises"; four words | Fears missing out | Brevity against a longer old-way line | Let the new-way line be shorter than the old-way line |
| 19 | RMs need to reach out to you for every small decision | Contrast, them (3) | 11 | "every small decision" exaggerates the burden | Tired of being asked | Effort transferred to the customer | Show who carries the work in the old way |
| 20 | Transparently reports the changes and impact to you | Contrast, us (4) | 8 | Adverb first for emphasis | Distrusts opaque reporting | Transparency | Lead with the adverb when the manner is the difference |
| 21 | Send you long reports that have outdated insights | Contrast, them (4) | 8 | Two faults in one line (long, outdated) | Has received unreadable reports | Paired faults | One line, one or two concrete faults, no adjectives of outrage |
| 22 | For illustrative purposes only. / View Disclosure | Compliance label | 4 / 2 | Full stop on the caption; Title Case link | Regulated buyer, sceptical | Footnote the claim where it is made | Put the caveat beside the visual that needs it, small but legible |
| 23 | How Dezerv can help you | Section H2 | 5 | Mirrors line 10's "How Dezerv ..." | Moving from belief to fit | Parallelism between sections | Repeat a headline frame so sections read as a sequence |
| 24 | EXISTING INVESTMENTS | Eyebrow (teal) | 2 | Capitals, colour-coded per service | Self-sorting | Route by situation | Eyebrows can sort readers by their current situation |
| 25 | Analyse & improve your current portfolio | Service H3 | 5 | Two verbs joined by ampersand; British "Analyse" | Has a portfolio already | Start from what they have | Offer to improve what the reader already holds before selling new |
| 26 | Evaluate your portfolio v/s current market | Tab item | 6 | Indian shorthand "v/s" | Wants a benchmark | Local register | Local idiom is acceptable in secondary copy if the audience uses it |
| 27 | Get all your questions answered for free in a 1-1 call | Tab item | 11 | "for free" and "1-1" lower the cost | Hesitant to commit | Fogg: reduce effort and cost | State the cost of the next step (free, how long) next to it |
| 28 | Explore our actively managed strategies | Service H3 | 5 | Verb first | Browsing | Invitation, not a push | Secondary sections can invite exploration; keep one primary action |
| 29 | View all strategies / Talk with us | CTA pair | 3 / 3 | Black pill plus outlined pill with WhatsApp icon | Two readiness levels | Choice of commitment | If two actions appear, make one visibly secondary |
| 30 | Meet our team of experts | Section H2 | 5 | Imperative, warm | Wants to see who decides | Authority via people | Show the humans behind judgement calls |
| 31 | Dedicated client partners you can trust | Section H2 | 6 | "you can trust" closes the line | Afraid of being sold to | Trust stated, then evidenced by names | Never state trust without the evidence on the same screen |
| 32 | Understand your goals better / Craft solutions to your needs / Keep you updated at all times | Stepper | 4 / 5 / 6 | Three verb-first lines, growing in length, no full stops | Wants to know the process | Rule of three | List a process as three verb-first steps |
| 33 | Managing portfolio for | Proof label | 3 | Fragment, lower-weight heading | Wants peers like them | Similarity and status proof | Describe who is served by role, not by name, when names cannot be shown |
| 34 | Founder of one of the largest healthcare chains | Proof item | 8 | Anonymised superlative | Status-conscious | Authority by association, privacy kept | Anonymise proof by role and scale when consent is limited |
| 35 | Insights for our clients | Section H2 | 4 | "our clients" implies membership | Wants to learn | Reciprocity | Give useful reading before asking |
| 36 | Come visit us at any of our offices | Section H2 | 8 | Invitation; physical presence | Distrusts app-only firms | Physical proof of permanence | Show a real-world anchor (people, places) if you have one; never fake it |
| 37 | Get in touch | CTA | 3 | Sentence case, arrow | Ready to talk | Low-commitment ask | Name the next step, not the purchase |
| 38 | You are building India’s future, we would like to build yours. | Closing line | 11 | Comma splice; "yours" echoes "future"; full stop | Ambitious founder | Mirroring the buyer's identity | Close by reflecting the reader's own work back to them, one sentence |
| 39 | Regulated entity / With licenses from SEBI, APMI and AMFI | Trust label | 2 / 7 | Label in Title-ish case, line without full stop; no serial comma | Checks legitimacy | Authority by regulator | Only show a regulator line you can prove; put it in the footer trust band |
| 40 | Secure and private / Data encrypted with 256-bit AES encryption. | Trust label | 3 / 6 | Specific standard; full stop on the detail line | Worried about data | Specificity beats adjectives | Pair a plain promise with one verifiable detail |

### 1.6 First-principles takeaways for Knowvia

- **Let the brand's own typeface speak only for the brand [captured device].** Dezerv sets every promise in Poppins and every old-way line in Inter. Knowvia can do the same with its two families: Newsreader carries Knowvia's lines, Source Sans 3 carries the description of the old situation, so the contrast survives without colour (non-negotiable 20).
- **Criticise the moment, not a company.** Dezerv labels a category four times. Knowvia's label should be a situation the reader has lived, for example a label such as "At the hospital desk, today" over plain lines like "You learn the room rent limit when the bill is printed." with Knowvia's paired line such as "You see your limits in plain words before you need them." These are illustrative structures for CP4, not final copy, and they make no outcome claim.
- **Put the new way first and the old way second, smaller in contrast, not in size.** Keep the old-way line nearly as large as Knowvia's line (it is a real problem) but on a quieter surface. Check that the quieter text still passes 4.5:1, which Dezerv's 5.4:1 does and its eyebrows do not.
- **Use a reading-paced manifesto only if it stays readable.** The scroll-lit paragraph is memorable, but its unlit state fails contrast and ignores reduced motion. A Knowvia version would start fully legible and add only a light emphasis on scroll, switched off under `prefers-reduced-motion`.
- **Hero restraint.** One headline, one action, proof directly below, the pain one scroll later. For Knowvia, the research hero formula needs the old way in the hero, so borrow Dezerv's silence (no sub-line clutter, no second button), not its omission of the pain.

---

## 2. Cardless

### 2.1 Type system

**Families and roles [captured].** One superfamily, two cuts, one weight value:

- **Söhne Buch** (book weight, computed `font-weight: 400`): every heading, every paragraph, the legal text.
- **Söhne Kräftig** (medium cut, also reported as 400 because it is a separate family name): navigation and the text-link actions ("See how it works", "Learn more", "Get in touch") and footer column heads.
- OpenType feature `"cv11"` is switched on in the Framer text styles (a Söhne character variant) [captured in HTML].

Hierarchy is made entirely by **size and tracking**. There is no bold anywhere on the page.

**Ramp [captured].**

| Role | Family | Size px | Weight | Line-height (ratio) | Tracking | Case |
|---|---|---|---|---|---|---|
| Display (hero, platform statement, section H, closing) | Söhne Buch | 80 | 400 | 88 (1.10) | -3.2px (-0.04em) | Sentence case |
| H2-level (case headline) | Söhne Buch | 54 | 400 | 60 (1.11) | -1.35px (-0.025em) | Sentence case |
| H3 (feature item) | Söhne Buch | 32 | 400 | 42 (1.31) | -0.64px (-0.02em) | Sentence case |
| Lede (hero sub-line, statement sub-line) | Söhne Buch | 27 | 400 | 35 (1.30) | -0.405px (-0.015em) | Sentence case |
| Eyebrow (partner tag in a sage pill) | Söhne Buch | 23 | 400 | 32 (1.39) | -0.345px (-0.015em) | Proper noun as written |
| Body | Söhne Buch | 20 | 400 | 32 (1.60) | -0.4px (-0.02em) | Sentence case |
| Button and text link | Söhne Kräftig | 20 | 400 (medium cut) | 32 (1.60) | -0.4px (-0.02em) | Sentence case |
| Nav | Söhne Kräftig | 15 | 400 (medium cut) | 24 (1.60) | normal | Title Case |
| Small (legal) | Söhne Buch | 13 | 400 | 16.25 (1.25) | normal | Sentence case |

**How authority is built.**

- **Tracking scales with size as an em value [captured].** -0.04em at 80px, -0.025em at 54px, -0.02em at 20 to 32px, -0.015em at 23 to 27px, zero at 13 to 15px. Because the tracking is set in em, the mobile 40px display keeps the same relative tightness as desktop. This is the most disciplined ramp in the pair.
- **A book weight at 80px [captured].** Large, light, tightly set type reads as confident and unhurried: the page does not need weight to be heard. The research report's "restraint signals an enterprise seller who does not need to shout" is visible in the numbers.
- **Line-height tightens as size grows [captured].** 1.6 for body, 1.3 for leads and H3, 1.1 for display, 1.0 for mobile display. Big lines become dense blocks; small lines stay airy.
- **Actions are a type cut, not a colour [captured].** "See how it works" is the medium cut at body size with an arrow, set under the lede. The action is quieter than the headline but heavier than the paragraph.

**Ratios.** Display to body: 80 / 20 = **4.0** [captured]. Mobile display: **40px**, line-height 40 (1.0), tracking -0.04em
[captured from the Framer breakpoint style; confirmed by pixel measurement of the mobile screenshot, ascender-to-baseline
57 device px at 2x against 57px at 80px on desktop]. Desktop to mobile: **2.0**. Note: the page has no `h1`; the hero
headline is an `h2` [captured], which is also why the capture's mobile H1 field is empty.

### 2.2 Colour and ground

| Role | Value | Proportion of full page | Evidence |
|---|---|---|---|
| Ground | #FFFFFF | about 66% pure white | [captured] + [measured] |
| Text | #1E1E1E (16.7:1 on white) | | [captured] |
| Dimmed inactive feature text | #1E1E1E at opacity 0.4, renders about #A5A5A5 (about 2.5:1) | | [captured] opacity; ratio [measured] |
| Hero media ground (video poster) | Sage gradient #E7EDE2 to #D3DECA, left to right | about 12% light tints incl. pills and tags | [measured] |
| Partner tag pill | #E8EEE3 with #1E1E1E text (14.1:1) | | [measured] |
| Secondary pill ("Learn more", "Get in touch") | #EDEDED with #1E1E1E text (14.2:1) | | [measured] |
| Primary nav pill ("Sign in") | #1E1E1E with white text | | [captured] |
| Footer band | #1E1E1E inset card; heads #E8EEE3, links #B9BDB5 (8.7:1), legal #797979 (3.8:1 at 13px) | about 10% dark | [captured] + [measured] |
| Brand colour | None in the UI. Hue comes only from partner photography and card art (Coinbase blue, Alibaba orange, Qatar burgundy) | about 5% chromatic | [measured] |

**How the near-zero accent is handled.**

- The brand's only "colour" is a pale sage tint, used for the hero media ground, the partner tags and the footer heads. It is low-chroma, so it reads as paper rather than as an accent [measured, intent inferred].
- Partners supply the colour. Each case's photography carries the partner's own brand hue, so the page looks like a portfolio of clients rather than a brand shouting about itself [inferred].
- The only dark object above the fold is "Sign in" (for existing customers). The prospect's actions are grey pills and text links, which fits a sales-led motion where the CTA is a conversation [measured, intent inferred].
- Weak spots [measured]: inactive feature text at 2.5:1 and footer legal at 3.8:1 both fail AA.

### 2.3 Layout and rhythm

**Section sequence [captured order, layout family from screenshots].**

| # | Section | Layout family | y (px) |
|---|---|---|---|
| 1 | Header: wordmark left; Platform, Customers, Careers; dark "Sign in" pill | Sticky bar, container `max-width: 1600px` | 0 to about 80 |
| 2 | Hero: headline left (two lines), lede and text link right, top-aligned | Asymmetric two-column split: headline from x=72, lede from x=949 | 176 to 350 |
| 3 | Hero media: autoplay video on a sage poster, rounded corners | Full container width, 1296 x 472 | 464 to 935 |
| 4 | Partner wordmarks: coinbase, BILT, Qatar Airways, Alibaba.com, LATAM, lifemiles | One row of six, evenly spaced, monochrome, no caption | about 990 to 1020 |
| 5 | Platform statement: two-line display, three-fragment lede, grey "Learn more" pill | Centred | 1266 to 1620 |
| 6 | Three feature items with a sticky image | Scrollytelling: sticky media left, text column right with hairline dividers; active item at full opacity | about 1750 to 3700 |
| 7 | "Credit, only the way our customers can" | Centred display line | 3986 |
| 8 | Four partner cases (Coinbase, Qatar Airways, Alibaba.com, Bilt Card 2.0) | Zig-zag: text column (tag pill, 54px headline, body, "Learn more") against a media bento (one large tile over two small tiles), sides alternating | 4420 to about 7300, pitch about 790 |
| 9 | Closing: "Build credit, your way" and "Get in touch" pill | Centred | 7579 to 7750 |
| 10 | Footer: dark inset card with three link columns (Cards, Company, Have a card?), large wordmark, legal | Inset card inside the container | 7957 to 8759 |

**Grid and width [measured + captured].** Content runs from x=72 to x=1367 at a 1440 viewport: a 1296px container with
72px gutters. The hero lede column starts at x=949, roughly the last third. Framer breakpoints at 1440, 800 and 0
(`max-width: 1439px`, `max-width: 799px` media queries) [captured]. Stack gaps in the CSS: 8, 10, 12, 16, 20, 24, 32 and
60px; radii 8, 10 and 16px [captured].

**Section padding [captured].** Feature text column `padding: 200px 110px 200px 0`; a section with
`padding: 200px 0 100px`; case text blocks `padding: 50px 110px 50px 0` and `50px 57px 50px 0`; smaller tops of 60, 64,
80, 84 and 96px. Measured: logo row to the platform statement about 245px; closing CTA to footer about 210px.

**Alignment.** Left for the hero and the case ladder, centre for the three display statements (platform, customers,
closing). The centred lines act as chapter titles between left-aligned evidence [measured, reading inferred].

**Imagery [captured + measured].** Partner wordmarks; phone mock-ups of real partner apps inside soft photographic
grounds; lifestyle detail tiles (a plane wing, a teapot, parcels, a building facade); physical cards. No people's faces.
No illustrations.

**The contrast device, exact structure.** Cardless has **no explicit "us versus them" block** [captured: no comparison
copy or label anywhere]. The old way is implied in three places:

1. In the hero lede, "All from inside your experience." implies the alternative (sending customers out to a bank).
2. In body copy: "keep customers inside your experience", "built for crypto, not finance".
3. In the case headline pattern: every headline welds "Credit" to a partner's world ("crypto economy", "the journey", "checkout", "neighborhood"), which implies credit used to live somewhere else.

The structure is **contrast by negation inside a sentence** ("X, not Y") rather than a side-by-side table.

### 2.4 Motion

| What moves | How | Label |
|---|---|---|
| Whole page | Framer site (`<meta name="generator" content="Framer 8cfa921">`); Lenis smooth scrolling active (`<html class="lenis lenis-smooth">`; Lenis CSS present: `lenis-stopped`, `lenis-scrolling`, `lenis-prevent`) | [captured] |
| Header | `position: sticky; top: 0` container | [captured] |
| Hero media | One `<video src="...mp4" loop autoplay muted playsinline>`, no controls, `object-fit: scale-down` on the sage poster | [captured]; content of the video unknown because it did not play headless |
| Feature section | Scrollytelling. The image column is sticky (image top held at 176px while the page scrolls from 2000 to 2700). The text item nearest the reading line is opacity 1; the other two are 0.4 (four `opacity:0.4` styles in the HTML). Probe at scrollY 1500, 2000, 2700 and 3400 shows the active item move 1, 2, 3 | [captured] |
| Feature images | Three images stacked in the sticky frame, all opacity 1 at the probe moments | [captured]; swap or crossfade per active item [inferred] |
| Nav links | Each nav link has a "Bottom Border" element at `opacity: 0`: an underline revealed on hover or for the current page | [captured] element; hover behaviour [inferred] |
| Entrance reveals | Zero Framer appear elements, and no case headline carries a pre-reveal opacity or transform | [captured] |
| CSS motion | Zero CSS transitions, animations or keyframes in computed styles; Framer drives state changes in JS, so durations and easing are not exposed. `will-change: transform` on 18 nodes | [captured] |
| Reduced motion | Zero `prefers-reduced-motion` rules. Under emulated reduce, Lenis stays on and the sticky dimming behaves identically | [captured] |

**Purpose [inferred].** Motion is almost absent, which is itself the message. The one motion idea (sticky media with a
dimmed list) acts as a **reading cursor**: it tells the eye which of three claims is current. No element performs for
attention. **Cost [captured]:** dimmed text fails contrast, and smooth scroll ignores the reduced-motion preference.

### 2.5 Copy, line by line

| # | Line (verbatim) | Role | Words | Punctuation and syntax | Buyer state targeted | Principle | Transferable rule |
|---|---|---|---|---|---|---|---|
| 1 | Build credit in your world. | Hero headline | 5 | Imperative, sentence case, full stop on a five-word line makes it a verdict | Product lead imagining a feature | Ownership: "your world" | A short imperative with a full stop reads as settled; use the full stop only on lines meant as conclusions |
| 2 | Grow engagement, revenue, and brand loyalty. | Hero lede, sentence 1 | 6 | Serial comma on desktop; the mobile variant drops it ("revenue and") | Needs to justify to a CFO | Three outcomes in buyer metrics | Keep punctuation identical across breakpoints; style drift reads as carelessness |
| 3 | All from inside your experience. | Hero lede, sentence 2 | 5 | Verbless fragment with a full stop | Fears losing customers to a bank | Implicit contrast (inside versus outside) | A fragment after a full sentence can carry the twist |
| 4 | See how it works | Hero action | 4 | Text link with arrow, no full stop, medium cut | Curious, not ready to talk | Low-commitment, information-first | Offer understanding before a meeting |
| 5 | Sign in | Nav pill | 2 | The only dark pill above the fold | Existing customer | Serve the returning user without competing with the prospect | The returning-user action can be visually strong if it sits in the nav |
| 6 | [Partner wordmarks, no caption] | Proof row | 0 | No "Trusted by" label at all | Sceptical buyer scanning for peers | Social proof that does not announce itself | Proof can be silent when the names are known; never fake the names |
| 7 | The credit card platform built for flexibility and control. | Section statement | 9 | Definite article claims the category; full stop; two-noun ending | Evaluating vendors | Category ownership | Define what you are in one sentence before listing features |
| 8 | Modular tools. Full-stack infrastructure. End-to-end operations. | Lede | 6 | Three two-word fragments, each closed by a full stop | Technical evaluator | Tricolon, rhythm | Fragments with full stops set a measured pace; use three at most |
| 9 | Everything you need to run a credit card program your way. | Lede close | 11 | "your way" echoes the closing headline | Wants control | Autonomy | Repeat one ownership phrase across hero, middle and close |
| 10 | Learn more | Secondary pill | 2 | Grey pill, no arrow here, arrow on case links | Browsing | Low pressure | Secondary actions can be generic; primary ones should not be |
| 11 | Build a native credit card experience | Feature H3 | 6 | Imperative, no full stop | Builder | Native as a quality word | Feature heads: imperative verb plus the outcome object |
| 12 | Treat credit like any other product feature with our APIs and custom components. | Feature body 1 | 13 | Simile, "like any other" normalises a scary thing | Fears complexity of credit | Reframing a hard domain as ordinary | Make the frightening domain ordinary by comparing it to something the reader already does |
| 13 | Embed approvals, rewards, and card management directly in your app or website, and keep customers inside your experience. | Feature body 2 | 18 | Serial comma; list then consequence | Wants retention | Concrete nouns | Name the concrete parts, then the consequence |
| 14 | Make credit feel relevant and timely | Feature H3 | 6 | "feel" admits perception matters | Marketing lead | Timing as value | A heading can promise a feeling only if the body names the mechanism |
| 15 | Choose exactly when and where credit appears in your product flow. | Feature body 1 | 11 | "exactly" asserts control | Wants control | Autonomy | Give the reader the verb ("choose") |
| 16 | Tie it to high engagement moments like bookings, post-purchase, or loyalty milestones to make signups and engagement feel natural. | Feature body 2 | 19 | Three examples, serial comma | Needs ideas | Examples beat abstractions | Give three real moments, not a category |
| 17 | Build a feedback loop that grows your credit program | Feature H3 | 9 | Longest feature head; no full stop | Growth owner | Compounding value | Order features from build, to place, to improve |
| 18 | Blend customer behavior and credit program data to test offers, improve rewards, and stay in control of what drives engagement for your program. | Feature body | 24 | Over 20 words; three verbs | Analytical buyer | Control again | Split any body sentence over 20 words |
| 19 | Credit, only the way our customers can | Section display | 7 | Comma after the anchor noun; no full stop; elliptical ending ("can" with the verb missing) | Wants proof from peers | Social proof as a boast about customers | An elliptical line works once per page; it costs clarity |
| 20 | Coinbase / Qatar Airways / Alibaba.com / Bilt Card 2.0 | Case tags | 1 to 3 | Proper nouns in sage pills | Recognising names | Authority by association | Tag each proof block with its source, small and consistent |
| 21 | Credit for a crypto economy | Case headline 1 | 5 | Anchor noun "Credit" first | Fintech buyer | Anaphora across cases | Start every case headline with the same anchor word |
| 22 | Coinbase used Cardless APIs to imagine a credit experience built for crypto, not finance. | Case body | 14 | "X, not Y" contrast in the final clause | Wants differentiation | Contrast by negation | Put the "not the old way" clause last in the sentence, after a comma |
| 23 | The team built every part in-house, using their design and logic to give their customers the Coinbase experience. | Case body | 18 | Credits the partner, not Cardless | Product team that wants ownership | Partner as hero | Let the customer be the subject of the proof sentence |
| 24 | Credit as part of the journey | Case headline 2 | 6 | Anchor noun; no comma | Travel brand | Fit with the existing journey | Tie the product to a moment the reader's users already have |
| 25 | Qatar Airways integrated Cardless modules in their app, allowing Privilege Club members to apply, spend, and earn as part of their existing travel experience. | Case body | 24 | Over 20 words; three verbs in a row | Loyalty lead | Concrete verbs | Use three short verbs for what the end user does |
| 26 | Checkout, with credit built-in | Case headline 3 | 4 | Comma after the place noun; hyphenated "built-in" | Commerce buyer | Place first, then the product | Name the place in the journey before the feature |
| 27 | Alibaba chose to surface credit where it could make an impact. | Case body | 11 | "chose" gives the partner agency | Pragmatic buyer | Selectivity | Describe restraint as a choice |
| 28 | A targeted checkout integration helped reduce friction and drive conversions. | Case body | 10 | Hedged verb "helped"; no number | Wants outcomes | Honest claim without a figure | When no number can be cited, use a hedged verb, never a made-up figure |
| 29 | Credit, in your neighborhood | Case headline 4 | 4 | Comma pause; American spelling | Consumer brand | Locality | A comma before a place phrase slows the line into a scene |
| 30 | Bilt lauched a new suite of credit cards in partnership with Cardless. | Case body | 12 | Contains a typo ("lauched") | Any | Proofing failure undermines premium tone | Proofread every line; on a restrained page one typo is loud |
| 31 | Build credit, your way | Closing display | 4 | Echoes hero verb and line 9's "your way"; comma pause; no full stop | Ready to talk | Bookend | Close with a line that rhymes with the hero, using the same verb |
| 32 | Get in touch | Closing CTA | 3 | Grey pill, sentence case | Sales-ready | Low-commitment B2B ask | The closing action names the next step, not a purchase |
| 33 | Have a card? | Footer column head | 3 | Question routes end users away from the sales page | Cardholder who landed here by mistake | Route the wrong audience out quickly | Give the wrong audience a clear exit near the bottom |
| 34 | Cardless is a financial technology company, not a bank. | Legal | 8 | Plain declarative inside small legal text | Regulator, careful reader | Honest boundary statement | State what you are not, plainly, in the legal band |
| 35 | Cardless \| Embedded Credit Card Platform | Page title | 5 | Pipe separator, Title Case category | Search user | Category keyword | Put the category, in plain words, in the title |
| 36 | Build credit into your product experience. | Meta description, sentence 1 | 6 | Variant of the hero with "into" | Search user | Consistency with hero | The meta description restates the hero in literal terms |

### 2.6 First-principles takeaways for Knowvia

- **Scale tracking in em, tighten line-height as size grows.** Cardless's ramp (-0.04em at display down to 0 at small, line-height 1.0 to 1.6) is the transferable discipline. Newsreader is a serif with its own optical sizing, so its display tracking should be milder than a grotesque's; the exact value is a CP5 decision to test on screen [inferred].
- **One weight can carry a premium page.** Cardless never uses bold. Knowvia's rule of bold on one or two words per section (non-negotiable 13) works better when everything else is a single regular weight.
- **Use one reading-cursor motion, not many.** The sticky media with a dimmed list is the only motion idea on the page. A Knowvia equivalent (for example, a short sequence that highlights the current step of "what you have, what is uncertain, what to do next") needs inactive text at 4.5:1 or better and a static fallback under reduced motion.
- **Contrast by negation inside a sentence.** "X, not Y" placed last in a sentence criticises a situation without a table. For Knowvia this suits a situation, for example a structure like "Read your limits at home, not at the admission desk." (illustrative for CP4, not final copy).
- **Repeat an anchor word.** Every Cardless case headline starts with "Credit". Knowvia can anchor its section headlines on one word the reader cares about (for example "cover" or "your policy"), so the headlines read in order make the offer (non-negotiable 16).

---

## 3. Cross-site comparison

| Dimension | Dezerv | Cardless | Lesson for Knowvia |
|---|---|---|---|
| Ground | Black, about 67% of the page | White, about 66% of the page | Mist ground with at most two Deep Tide bands sits between the two: calm like Cardless, with Dezerv-style dark moments for emphasis |
| Accent | Inversion (white on black); hue only in product UI | None; partners supply hue | One action colour (Harbour) only on actions, as both sites keep hue off decoration |
| Display face | Poppins 500, 92px, -2px fixed | Söhne Buch 400, 80px, -0.04em | Newsreader display, regular or medium weight, em-based tracking, no bold |
| Display to body | 4.6 | 4.0 | Aim near 3.5 to 4 with 18px body (non-negotiable 22) [inferred] |
| Desktop to mobile display | 2.19 (92 to 42) | 2.0 (80 to 40) | Halve the display on mobile and keep tracking in em so it does not over-tighten |
| Old-way contrast | Explicit, four paired cards, "VS" disc, category label | Implicit, "X, not Y" clauses and headline anaphora | Use the explicit paired device once, labelled by a situation; use "not" clauses sparingly elsewhere |
| Proof | Named people, video, regulators, offices | Partner wordmarks and case stories | Knowvia has neither yet; use recorded, consented research quotes only (decision D6), never logos or ratings |
| Motion | Lenis, Framer appear, scroll-scrubbed manifesto, Lottie, autoplay video | Lenis, sticky reading cursor, one autoplay video | One purposeful motion idea, no smooth-scroll library, everything off under reduced motion (non-negotiable 23) |
| Reduced motion | Not handled | Not handled | A gap Knowvia must close; neither reference is a model here |
| Accessibility gaps | Eyebrows at 3.8:1 and 2.5:1; manifesto 1.66:1 before scroll | Dimmed text 2.5:1; legal 3.8:1 | Any dimmed or "inactive" state still meets 4.5:1 |
| Editorial slips | Missing hyphen ("data driven"), no closing full stop on the manifesto | Typo ("lauched"); serial comma differs between breakpoints | A restrained page magnifies small errors; proof every line at every breakpoint |
| Primary CTA | "Review my portfolio" (first person, own asset) | "See how it works" then "Get in touch" | Same words at top and bottom (non-negotiable 15); first person and own-asset framing suits Knowvia's household operator |
