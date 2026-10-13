# CP1 Reference teardown: eleven sites, first principles

Status: done, 13 October 2026. All eleven home pages were re-opened in a headless browser (desktop 1440, mobile 390),
read-only. Computed type, colour, layout blocks, motion signals and ordered copy were captured for each. The
line-by-line detail lives in four group files:

| Group | File | Sites | Capture notes |
|---|---|---|---|
| Consumer fintech | [cp1/consumer-fintech.md](cp1/consumer-fintech.md) | EarnIn, Albert, Monarch, Kikoff | Kikoff needed one retry; Monarch videos and mobile hero did not render |
| Benefits insurtech | [cp1/benefits-insurtech.md](cp1/benefits-insurtech.md) | Onsurity, Plum, Thatch | Onsurity showed its own error page twice, so it rests on the research report; Thatch mobile loaded unstyled |
| Indian insurance | [cp1/indian-insurance.md](cp1/indian-insurance.md) | Loop Health, Acko | Both captured; some Acko copy read from screenshots |
| Wealth and B2B | [cp1/wealth-and-b2b.md](cp1/wealth-and-b2b.md) | Dezerv, Cardless | Both captured, plus read-only probes for Framer, Lenis and sticky behaviour |

**Verdict.** The calm, high-trust sites all win the same way. A display face at regular weight states the claim, a
plain sans explains it, and one colour is kept for action. Motion only answers what the reader does, and every
number carries its condition. Knowvia should be built from those four moves and spend its boldness in one place:
the Known, Unknown, Next device.

## 1. The working matrix

Values are [captured] unless marked. Ratio = display size divided by body size. Mobile = desktop H1 divided by
mobile H1.

| Site | Display type | Body | Ratio | Mobile | Ground and action colour | Layout signature | Motion signature | Copy signature | Buyer state served |
|---|---|---|---|---|---|---|---|---|---|
| EarnIn | earnInMori 800, 80px, lh 1.15, -0.005em | 20px | 4.0 | 1.90 | Off-white; black pill (was blue in the report) | Photo carousel hero, yellow promo band | Fast hover only, one slow ambient sweep; nothing hidden before scroll | Question headline, colloquial humour | Anxious, short of cash |
| Albert | seasonSerif 400, 58px, lh 1.30, -0.011em | 18px | 3.2 | 1.61 | White; royal blue pill | Product UI, tab switcher, closing dark block | One 60s orbit loop; no scroll hiding | Product named as a character; "Albert is not a bank." beside the CTA | Busy, wants a helper |
| Monarch | ABC Oracle Light 300, 60px, lh 1.15, -0.02em | 18px | 3.3 | 1.50 | Warm grey; coral (white text 2.96:1, fails AA) | Zig-zag feature rows | 23 elements hidden, 1.5 to 2s reveals (slows reading) | Outcome headlines, one clause per feature | Couples sharing money |
| Kikoff | DM Sans 600, 68px, lh 1.20, -0.059em | 20px | 3.4 | 1.55 | White; black action, lime only for proof | Bento of stats, bureau logos, steps | Webflow heading interactions | Number first, condition and asterisk directly under it | Shut out, wants a fast win |
| Onsurity | Space Grotesk 500, 58px [report] | 16px | 3.6 [inferred] | n/a | Pastel sky; periwinkle pill | Stat strip, four products | Counters from zero [report] | Title Case promise in two sentences | HR lead short of time |
| Plum | GT Alpina 400, 68px, lh 1.00, -0.03em | 16px | 4.25 | 2.1 | Now dark aubergine with painterly art, cream lower down; coral text 3.1:1 fails | Role router in nav, logo wall, founders' letter | 0.8s settle on one card state; carousel | One italic word for emphasis; "No misselling. No pressure. No jargon." | HR buyer wanting a humane brand |
| Thatch | v3Selecta 500, 63px, lh 1.00, -0.01em | 20px | 3.15 | 1.38 | Cream; red pill (white text 4.1:1, fails) | Comparison table centrepiece, partner row lower down | Scripted product demo, 12 reduced-motion rules | "Health benefits" to "health budgets" reframe; pronouns split audiences | Cost-control buyer |
| Loop Health | Work Sans 700, 69px, lh 1.10, -0.04em | 17.3px | 4.0 | 1.48 | Deep green; lime action; yellow close | Centred slogan, stat cards, HR dashboards | GSAP scroll scenes; scroll-scrubbed text sits at half opacity | Reframe by negation, repeated top, middle and close | HR lead buried in admin |
| Acko | Euclid Circular B 600, 42px, lh 1.125 | 17.5px | 2.4 | 1.95 | Grey; black buttons; violet only on the promise; green only on savings | Product grid with price anchors, claims in nav | Short once-only entrances (0.3 to 0.6s) | "Simple prices. Super fast claims." Asterisk and reference on each claim | Individual buyer distrusting insurers |
| Dezerv | Poppins 500, 92px, lh 1.11, -2px fixed | 20px (Inter) | 4.6 | 2.19 | Black about 67%; white inversion, no hue | Paired "us" vs "traditional firms" cards with a VS disc | Lenis, Framer appear, scroll-lit manifesto (1.66:1 before lit), Lottie | Title Case authority; incumbent criticised | Affluent, sceptical |
| Cardless | Söhne Buch 400, 80px, lh 1.10, -0.04em | 20px | 4.0 | 2.0 | White about 66%; almost no accent | Case-story ladder, sticky image with dimming text | Sticky reading cursor (dimmed 2.5:1), one video | Anaphora ("Credit..."), "X, not Y" clauses | Enterprise product lead |

**Changed since the research report** (the report stays useful for strategy; these values supersede it): EarnIn's
and Kikoff's primary buttons are now black; Kikoff's headline stat is "+86pts"; Monarch's display face is ABC
Oracle and Otto, not Copernicus; Plum's ground is now mostly dark aubergine; Acko's hero now renders.

## 2. First principles: type

1. **Weight is not the hierarchy on calm pages.** Albert, Monarch, Plum and Cardless keep display at 300 to 400 and
   build hierarchy from size and family. Heavy display (EarnIn 800, Loop 700) reads as energy, not trust.
   *Knowvia: Newsreader at 400, never bold.*
2. **Serif states, sans explains.** Albert and Monarch put the claim in a serif and every explanation in a sans.
   The switch of family is itself the hierarchy. *Knowvia: Newsreader only for headlines and pull quotes; Source
   Sans 3 for everything that is read, filled in or calculated.*
3. **The calmer the brand, the lower the display-to-body ratio.** Calm sites sit at 3.15 to 3.3; theatrical ones at
   4.0 to 4.6; Acko's 2.4 is too flat to lead. *Knowvia: about 3.4 (64px over 19px).*
4. **Tracking tightens with size, in em, never in px.** Cardless steps -0.04em at 80px down to 0 at body; Dezerv's
   fixed -2px over-tightens on mobile. Serifs need less than sans. *Knowvia: -0.015em at display, -0.01em at H2,
   0 from H3 down.*
5. **Leading tightens with size.** Display 1.0 to 1.15, body 1.5 to 1.6. *Knowvia: display 1.05, H2 1.12, body 1.6
   (a little more than a sans page, because body copy for parents runs long).*
6. **The mobile headline shrinks by 1.4 to 1.6, not 2.** Sites that halve it (Plum, Dezerv, Cardless) lose
   dominance; Acko's 21.5px mobile H1 disappears. *Knowvia: 64px to 42px (1.52).*
7. **One case.** No calm site uses uppercase headlines. Uppercase eyebrows are a template tell (frontend-design
   skill). *Knowvia: sentence case everywhere, including the signature labels.*
8. **Emphasis is rationed to one device.** Plum uses one italic word; Kikoff uses bold on the claim. Mixing both in a
   line, or accenting one headline word in colour, reads as a template. *Knowvia: bold on the one claim per section
   in body text; headlines carry no in-line accent.*

## 3. First principles: colour and ground

1. **One colour means act; a rarer one means notice.** Kikoff (black acts, lime proves), Acko (black acts, violet
   promises, green saves). *Knowvia: Harbour acts. Signal Gold notices (focus ring, the Next marker). Nothing else is
   saturated.*
2. **The action colour must pass AA as a button.** Monarch's coral (2.96:1), Plum's coral (3.1:1) and Thatch's red
   (4.1:1) all fail with white text. *Knowvia: Harbour with white text is 5.98:1, hover `#125A55` 8.02:1.*
3. **Dark bands are emphasis, not the theme.** Dezerv's 67% black is exclusivity; Albert and Thatch use one dark
   block for the moment that matters. *Knowvia: at most two Deep Tide bands (household control, footer).*
4. **Dimmed text is still text.** Dezerv's manifesto (1.66:1) and Cardless's sticky list (2.5:1) hide copy from
   anyone who does not scroll the right way. *Knowvia: no state below 4.5:1.*

## 4. First principles: layout

1. **Proof sits within one scroll of the claim.** Every site; strongest when the proof is concrete (Kikoff's stat
   with its condition, Thatch's floating product card).
2. **The contrast device works when each pair answers the same question.** Dezerv pairs each "us" card with a
   "traditional firm" card on one theme. *Knowvia: one comparison, labelled by a situation ("Finding out at the
   hospital desk"), never a company.*
3. **Second audiences get a smaller, wider row lower down.** Thatch's broker and payroll row is the model; Plum's
   nav router adds a choice to the first screen (Hick). *Knowvia: one partner block after the household story.*
4. **Variety of layout families keeps a long page readable.** The best pages use four to six families (split,
   table, sequence, quote, band, accordion) and never repeat one three times in a row.
5. **Text is left-aligned; only a single decision moment is centred** (stat strips, the closing CTA).

## 5. First principles: motion

1. **Response, not decoration.** Every site answers hover and press in 0.15 to 0.3s. That is the whole budget for
   most of the page.
2. **Nothing is hidden before scroll on content-first sites.** EarnIn and Albert hide nothing; Monarch, Loop and
   Dezerv make the reader wait or leave text at partial opacity. *Knowvia: content is fully visible without motion
   and without JavaScript.*
3. **One orchestrated moment beats many reveals** (frontend-design skill; Thatch's scripted product demo is the most
   meaningful motion in the set). *Knowvia: one hero sequence that shows the product's actual job: a policy's
   lines settling into Known, Unknown and Next.*
4. **One easing curve gives a page one personality.** Loop uses `cubic-bezier(0.165, 0.84, 0.44, 1)` throughout.
   *Knowvia: one "settle" curve for everything that moves into place.*
5. **Play once.** Acko's entrances run once in 0.3 to 0.6s. Loops are allowed only if slow enough to be atmosphere
   (Albert's 60s orbit); Knowvia needs none.
6. **Reduced motion is where references fail.** Dezerv and Cardless have no handling; Plum none found; Thatch has
   12 rules. *Knowvia: every motion has an explicit reduced-motion end state.*

## 6. First principles: copy, word by word

**The hero.** Four to seven words, each site picking one syntax: a question that voices what the reader already
thinks (EarnIn), two fragments that name and define (Albert), a noun phrase that offers a place (Monarch), an
imperative with a verb of motion (Kikoff). The sub-line does the listing so the headline can stay abstract.

**Punctuation, and the reasoning behind it**

| Mark | What it does to the reader | Seen in | Knowvia rule |
|---|---|---|---|
| Full stop on a headline | Turns a label into a stance. It says "this is settled", and lowers anxiety by sounding final | Albert's claim H2s, Plum's one stance, Thatch's "Support metrics in real time." | Full stops on claims and promises; none on navigational labels ("How it works") |
| Two short sentences | Rhythm of certainty: problem, then answer; or promise, then proof | Acko "Simple prices. Super fast claims.", Kikoff "One tap. Score big." | The hero lockup already does this: "Know your cover. Before you need it." |
| Question mark | Surfaces a doubt the reader holds, so the page feels like it listened | EarnIn "Why wait for money you've already earned?" | Only in the FAQ, where the reader's own questions belong. No rhetorical questions in headlines |
| Comma before a contrast | Pivots from the old way to the new one inside one breath | Cardless "..., not finance" | "X, not Y" at most twice on the page |
| Serial comma in a triad | Makes a list feel complete and considered | Albert and Monarch sub-lines | Used in the "Know what you have..." triad |
| Ampersand | Compresses two nouns into one brand idea; reads as logo-speak | Loop "Healthcare & insurance", Dezerv "& you need" | Not used. Knowvia writes "and" |
| Exclamation mark | Enthusiasm and reassurance at once; can sound like a sales floor | Loop "Not just for sick days!" | Never. Calm voice, and the topic is a hospital |
| Asterisk | Admits a condition exists and promises to show it | Kikoff, Acko | Replaced by a visible source marker beside each number (an honest asterisk) |
| Title Case | Institutional distance, a brochure voice | Dezerv, Onsurity | Sentence case everywhere: the voice of a capable case worker, not a brochure |
| Numerals with units | Specificity creates belief; a round number reads invented | Kikoff "+86pts", Thatch "1.5h average response time" | Exact rupee figures from the evidence register (₹1,200, ₹80,000, ₹9,400), never rounded up |

**Copy patterns that transfer**

- **Negation next to the action.** "Albert is not a bank." "No misselling. No pressure. No jargon." Every site puts
  a "not" line close to the decision. *Knowvia: "Not an insurer. Not selling you a policy." beside the form.*
- **Reframe by renaming the category.** Thatch turns "health benefits" into "health budgets"; Loop repeats its
  reframe at the top, middle and close. *Knowvia: one operational reframe bookends the page.*
- **Figure first, condition directly under it, in body size.** Kikoff. *Knowvia: every story figure has its source
  line underneath.*
- **Pronouns split audiences.** Thatch: "you" is the buyer, "your team" the user. *Knowvia: "you" is the household;
  the partner block says "your customers" or "your employees".*
- **Closings echo openings.** EarnIn returns to waiting; Kikoff to its number. *Knowvia: the closing returns to
  "before you need it".*
- **The CTA keeps its words top and bottom.** Plum and Loop drift; it costs recognition. *Knowvia: "Join the early
  list" in both places.*

**Faults seen in the references, to avoid:** typos beside numbers and in trust headings (Loop, Acko, Cardless),
unsourced percentages (Loop), a best-case figure shown as typical (Acko), generic section names ("Testimonial"),
absolutes ("never need another"), abstract endings ("transformative").

## 7. What Knowvia takes into CP3 and CP4

| Decision | From |
|---|---|
| Newsreader 400 display at 64px desktop, 42px mobile; ratio about 3.4 over a 19px body | Type principles 1, 3, 6 |
| Em-based tracking, tightening with size; display leading 1.05 | Type principles 4, 5 |
| Sentence case everywhere; no uppercase eyebrows; one emphasis device | Type principles 7, 8 |
| Harbour is the only action colour; Signal Gold only marks "notice" and focus | Colour 1, 2 |
| At most two Deep Tide bands; no dimmed text below 4.5:1 | Colour 3, 4 |
| One situation-labelled contrast block; one partner row lower down; four or more layout families | Layout 2, 3, 4 |
| One orchestrated hero sequence; all else is response motion; one settle curve; play once; full reduced-motion end states | Motion 1 to 6 |
| Two-sentence hero lockup; negation beside the form; figure-then-source; fixed CTA wording; no exclamation, ampersand, Title Case or rhetorical question | Copy section 6 |
