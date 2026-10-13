# CP7 Independent review: Knowvia landing page and onboarding

Reviewer: independent CP7 agent (did not build any of the pack). Date: 13 October 2026. Scope: `docs/design/00` to `07`,
`tokens.json`, the 13 artboards and `canvas.json` in `docs/design/claude-design/`, checked against
`docs/evidence/coversaath-interview-transcripts.md`, the `design-taste-frontend` skill (sections 4.7, 9 and 14) and the
`frontend-design` skill. The published canvas was not opened or rendered. All findings come from reading the source.
Contrast was computed with the WCAG 2.2 formula (`python3 -I`). The format checks were run with `html.parser` and regex.
`Landing-Mobile.dc.html` is byte-identical to `Main.dc.html` except for line 5 (title) and line 504 (`$preview`), so every
`Main` line reference also applies to `Landing-Mobile` at the same line.

## Verdict

**CP7 is not closed. There are 7 open High findings, and acceptance criterion 9 ("no open high-severity finding")
fails.** The pack is strong where it matters most. The copy is disciplined: no em or en dashes, no exclamation marks,
ampersands or banned words, one CTA wording, and every story figure traces to a transcript line. The palette passes AA
for every text pair actually used. The artboards are well-formed: tags balance, every `{{ }}` hole is a plain lookup,
and all 13 `data-props` blocks parse as JSON. Three kinds of defect still block sign-off:

1. **Consent and truth.** The footer claims the quotes are "shared with consent", but the transcripts record consent
   for internal research only. The household-control section reproduces the particulars of Mrs. Ghosh's private
   request (the viewer is her son; the hidden item is a declared condition and its reason) on the same page as her
   son's own story. The optional "What is coming up" question collects health-adjacent data and states no purpose.
2. **Accessibility non-negotiables.** The gold focus ring is 2.11 to 2.27:1 on light grounds, and the specified Tide
   inner edge was never implemented. Selected early-list chips are told apart by colour alone. Consent and price text
   is below the NN22 size floor.
3. **Reduced motion is incomplete.** The FAQ caret and the O4 switch still animate under `prefers-reduced-motion`.

Every High finding is a small, local fix. None needs a change of direction.

## Findings

Severity follows the brief. **High** breaks a non-negotiable, misstates evidence, or breaks rendering or
accessibility. **Medium** is a material defect, a spec contradiction or a missing designed state. **Low** is polish or
drift.

| ID | Severity | Area | Evidence (file:line) | Recommended fix | Verification |
|---|---|---|---|---|---|
| H1 | High | Accessibility, focus | `Main.dc.html:16` and line 15 of every O1 to O7 file: `:focus-visible{outline:3px solid #E0A02B;outline-offset:3px}`. Gold against the grounds next to it: Paper 2.27, Mist 2.11, Mist Deep 1.94. This fails WCAG 2.2 SC 1.4.11 (3:1). The fix is already specified (`tokens.json` `focus.ring` "inner 1px tide"; `03-design-direction.md:114`) but not implemented. Only the Foundations specimen draws it (`Foundations.dc.html:77`) | Make the ring two-tone in every artboard, e.g. `outline:2px solid #163F42; outline-offset:2px; box-shadow:0 0 0 5px #E0A02B`. Tide is 10.66:1 on Mist and 11.51:1 on Paper, so it carries the 3:1, and gold stays the visible brand cue | Tab through every artboard on Mist, Paper and Mist Deep. Recompute the adjacent-colour ratio (at least 3:1) |
| H2 | High | Status by colour (NN20) | `Main.dc.html:571-577`: a selected early-list chip differs only by fill (Harbour Tint, 1.17:1 against Paper), border colour (1px to 1.5px) and text colour. There is no check icon, but `05-design-system-spec.md:125` requires "selected chips get ... a Harbour border and check" | Render a check icon inside the chip when it is on (as `O2-Event.dc.html:29` does). Optionally change the weight as well | Grayscale screenshot: selected and unselected chips are distinguishable. `aria-pressed` still toggles |
| H3 | High | Type floor (NN22) | Consent and purpose text at 15px: `Main.dc.html:453` (consent line), `:90` (hero helper, the NN10 purpose statement), `O1-Start.dc.html:37` (legal consent), `O4-Sharing.dc.html:49,53` (emergency access and sharing defaults). Coverage and price text at 17px on desktop, where NN22 requires 18: `Main.dc.html:131,138,145,152,159` (reading card), `:349,353,358` (permission panel), `O7-Matrix-Desktop.dc.html:34`. The spec causes part of this: `05-design-system-spec.md:71` sets "Body 17 on desktop inside the card". `03-design-direction.md` §4 assigns Body to "consent, conditions" | Set the consent, purpose and permission lines in Body (17 mobile, 19 desktop). Set reading-card statements, panel values and matrix cells to at least 18 on desktop. Update 05 §Reading card | grep `font-size` on the listed lines; check them at 390 and 1440 |
| H4 | High | Truth and consent (NN7) | `Main.dc.html:497`: "Names are withheld and shared with consent." The transcript header (`coversaath-interview-transcripts.md:8`) records consent "for product research only, not shared outside the team". Public re-consent is still open (`00-requirements-and-framework.md` §14, `06-page-specs.md` P6). The sentence states a consent that does not exist yet | Replace it with "Names are withheld." plus a visible `[CONSENT RE-CHECK BEFORE LAUNCH]` until re-consent is recorded. After re-consent, use "Quotes are shared with each person's permission." | The product owner confirms re-consent records for T1, T4, T5 and T6 before launch |
| H5 | High | Consent, T8 (NN8) | `Main.dc.html:336` "Share the cover amount with your son. Keep the medical reason to yourself."; `:343` viewer "Your son"; `:358` "Declared condition and its reason". This is T8's exact situation: a mother keeping a declared condition from her son, "the number yes, the reason no" (transcripts 1077-1110). She asked that Arnab not be told the contents of the call (transcripts 1062). The same page also carries Arnab's story (`:298-299`, "A., 26, Gurugram", T1), his sister's date-of-birth error (`:254-255`, T3) and "your sister ... family policy" (`:197`, T1). Onboarding reuses that family too: Sister, 19, on father's policy, DOB 2001 or 2007 (`O7-Matrix-Desktop.dc.html:60-63`, `O3-People.dc.html:40`). NN8 allows only the principle, in Knowvia's words. The page reproduces the particulars beside her son's own case, where he could recognise them | Change the viewer and the withheld item to particulars that are not hers (e.g. viewer "Your sister" or "Your brother", value "Medical details"). Drop "and its reason". Do not pair any Ghosh-family case (T1, T3) with the permission scenario. Update 04 §6 and the Components board (`Components.dc.html:88-93`) to match | The product owner and the researcher re-read section 6 against T8 and sign off |
| H6 | High | Consent, minimal data (NN10) | `Main.dc.html:437-444`: the optional "What is coming up for your family?" chips include "Planned treatment", which is health-adjacent. The only purpose text on the form is about email (`:453` "We use your email only to tell you when Knowvia opens"). NN10 requires the purpose next to the fields. The deck gives a reason for the field ("helps prioritise", `04-ia-and-copy-deck.md:214`) but no visible copy | Add one purpose line under the legend, e.g. "We use this only to decide what Knowvia reads first for you." Add a legal-review tag on retention. Decide with legal whether "Planned treatment" belongs on a pre-launch list form | The copy deck and artboard show the purpose line; the legal-review placeholder is present |
| H7 | High | Motion (NN23) | The reduced-motion block (`Main.dc.html:36`) covers only `.kv-m`, `.kv-btn`, `.kv-out` and `.kv-chip-opt`. Still animating under reduce: the FAQ caret rotation, 240ms, inline (`Main.dc.html:566`); the segment fade, inline (`:549`); the O4 switch knob slide (240ms) and track fade (`O4-Sharing.dc.html:68-69`). O4 has no reduced-motion rule at all (`O4-Sharing.dc.html:12-16`). The user impact is small, but NN23 says "all motion" | Add `@media (prefers-reduced-motion:reduce){*,*::before,*::after{transition:none!important;animation:none!important}}` to every artboard with motion, or move the inline transitions into covered classes | Emulate reduced motion in DevTools, then toggle the FAQ, the segment control and the O4 switch: each changes instantly |
| M1 | Medium | Accent discipline (NN18, brief 07) | 15 non-action Harbour uses on Main: Known chip text (`:130,137,144,236`), the comparison column header (`:186`), five 3px column rules and five mobile labels (`:192-216`), the partner eyebrow (`:388`). Also the Known check icons in onboarding (`O5:43`, `O6:32-34`, `O7-Matrix-Desktop:48,55,62`, `O7-Matrix-Mobile:32,40,47`). The spec itself assigns Harbour to Known (`03:55`, `05:50`) and to the column rule (`05:80`), so "Harbour only for actions" is contradicted inside the pack. Failure table, `00:262`: "Accent creep" | Known chip text and icons in Tide on Harbour Tint (9.85:1). Comparison rule and labels in Tide. Eyebrow in Slate or Tide. Or log the exception in 00 §3 with its reason | grep `#176F69` returns only buttons, links, selected controls and hover |
| M2 | Medium | State contrast (1.4.11) | `Main.dc.html:549-551`: the selected segment (white) sits on a Mist Deep track (1.17:1). Only the label colour (Slate to Tide) and a faint shadow change | Add a 1.5px Tide border or a Tide underline to the selected segment, matching the reading-card tabs (`:114`) | Grayscale check; the state indicator against its neighbour is at least 3:1 |
| M3 | Medium | Hit targets (44px rule) | Reading-card tabs 36px (`Main.dc.html:114-116`, written into the spec at `05:67`); O7 "Why?" buttons 32px (`O7-Matrix-Desktop.dc.html:50,57,64`); O4 switch 32px tall (`O4-Sharing.dc.html:68`) | Minimum 44px box, using padding or `min-height`. Update 05 §Reading card | Measure the boxes on the canvas |
| M4 | Medium | Fake control in the hero | `Main.dc.html:113-117`: You, Maa and Papa are `<button>` elements with hard-coded `aria-pressed` and no handler. The wrapper `div` has `aria-label="People"` but no role, so the label is ignored | Either wire them (three row sets in `renderVals`) or render them as static text, e.g. a "For: You" label, so nothing is clickable that does nothing | Click each tab; or confirm there is no `button` in the card header |
| M5 | Medium | Hero layout | `Main.dc.html:70` `max-width:11ch` on a 36-character H1. At 64px Newsreader, "Know your cover." is about 7.3em (about 465px), while 11ch is about 350 to 370px. The headline therefore sets on three lines ("Know your / cover. Before / you need it."), and the lockup breaks mid-sentence. `06-page-specs.md:12` specifies two lines, and taste 4.7 caps headlines at two. This is an estimate from typical Newsreader advance widths | Force the break: `<span style="display:block">Know your cover.</span> Before you need it.` with max-width around 17ch | Render at 1440 and 1024: two lines, and the break falls after "cover." |
| M6 | Medium | Pre-launch clarity (NN2) | The only status signals are the 15px helper (`Main.dc.html:90`) and FAQ item 7, which starts closed (`:559`). Everything else is in the live present tense: "Knowing it with Knowvia" column (`:192-216`), "Knowvia reads them person by person" (`:227`), "It reads the policies you already have" (`:553`) | Keep the present-tense headlines. Make the helper Body size (see H3). Add one status phrase to the How it works lead, e.g. "When Knowvia opens, add the policies you already have ...". Consider opening the "When can I use it" FAQ item by default | Cold read by someone new: "Can I use it today?" must be answered "no" within one scroll |
| M7 | Medium | Consent marking (NN7) | The deck puts `[CONSENT RE-CHECK BEFORE LAUNCH]` in the quote's source line (`04:125`). The artboard drops it (`Main.dc.html:277`). Story blocks rely on one canvas-level note (`canvas.json` landingNote) | Restore the visible placeholder on `:277`. Add the marker as an annotation on each story block | The placeholder is visible on the canvas |
| M8 | Medium | Privacy | The "Already on the list" state (`Main.dc.html:99-103,463-465`; `04:242`) tells anyone who types an address whether that person joined a health-insurance list | Show the same success state for new and existing emails. Put any "already joined" note in the email instead. Keep the state in the system board as a back-end case only | Copy deck §4 updated; the Tweaks "already" option shows the success copy |
| M9 | Medium | Unlabelled illustrative numbers (NN4) | `Main.dc.html:349` "₹5,00,000 floater", `:242` "page 4", `:255` "2001 ... 2007" are illustrations without the "Example" label the hero card has (`:112`) | Add the "Example" chip to the permission panel and the specimen column | Every number on the page has either a source line or an Example label |
| M10 | Medium | Evidence provenance | `Main.dc.html:325` "Documents shared during the same conversations." The transcript logs the mail as received 2026-09-02, before the first recorded conversation on 2026-09-05. The 7 of 19 count is for documents "collected" across the research (transcripts 508, 535, 1152). The transcript also contradicts itself: the 5 September call says "I'll look tonight", but the mail is dated 2 September | Change it to "Documents families shared with us during this research." Ask the researcher to confirm the date | The researcher confirms the count window and the date |
| M11 | Medium | Missing designed states (cold read) | No designed state for: the hero success with the optional question and "Save" / "Saved." (`04:241`); the O1 error (`06:30` says it is drawn; `O1-Start.dc.html` has the default only); the one-time-code entry screen (O1 "Send code" goes straight to O2, `O1:36`, yet the deck has a "code did not match" error, `04:261`); the mobile menu sheet (`05:44`; the button at `Main.dc.html:57` is inert and mobile has no route to Privacy, Partners or Questions); the empty matrix (`04:296`; the O5 skip link goes to a filled matrix, `O5-Upload.dc.html:57`) | Draw these five states, or mark them out of scope in 06 §2 | A cold reader finds every state named in 04 §4 and §5 on the canvas |
| M12 | Medium | Consent logic in onboarding (NN9) | `O4-Sharing.dc.html:24` "Choose what each person shares." has the operator setting Maa's medical-details setting (`:42`), while the landing page promises "Each person decides what family sees" (`Main.dc.html:335`) and the FAQ says "Each adult decides for their own record" | O4 sets your own record. For other adults, show "Maa decides. Suggested: ..." with the invite status. Change the H1 to "Choose what you share." Update 04 §5 | Re-read O4 against NN9 and the landing section 6 |
| M13 | Medium | Rendering risk | `Main.dc.html:79,446`: `disabled="{{ hero.busy }}"` binds a boolean to a boolean attribute. If the runtime serialises `false` as the string "false", the attribute is present and the primary CTA is disabled in every state. `support.js` is not in the repo, so this could not be verified | Render the busy button in its own `sc-if` branch, or bind `aria-disabled` plus a guarded handler | In the canvas: default state, focus the button, `button.disabled === false`; submitting state, `true` |
| M14 | Medium | Headline rule (NN12) | No main-clause active verb in: "Three answers for every person you cover." (`Main:226`), "Small details, found too late." (`:287`), "Fewer "what does my policy cover?" calls." (`:389`), "Your policy, read before you need it." (`:423`). "found too late" also leans on the lateness framing NN14 bans. The deck self-audit (`04:319`) did not test the active-verb clause. This is rated Medium rather than High only because CP4 was a user-approval gate | Log an override in 00 §3 or rewrite. Options: "See three answers for every person." / "Families found these details at the desk." / "Cut "what does my policy cover?" calls." / "Read your policy before you need it." | Every headline has a finite active verb, or the override is logged |
| M15 | Medium | Taste pre-flight, unlogged | Hero lead is 26 words (`Main:71`; cap 20, taste 4.7). Helper line under the CTA (`:90`; hero stack discipline; it is a truth requirement but no override is logged). H1 starts 120px below the nav (`:66` 96px plus `:69` 24px; cap 96). Icons are hand-drawn paths, not Phosphor geometry (e.g. `:130`; `03:149` claims "same geometry"). Sections 7 and 9 share one layout family (`:372`, `:404`). Success metric `00:196` requires zero unlogged failures | Log each one in 03 §10 with its reason (the helper and the icons are defensible), or fix it (trim the lead; drop the inner 24px) | 03 §10 lists every failed box with its reason |
| M16 | Medium | Accessibility, skip link | `Main.dc.html:41`: the skip link sits at `left:-9999px` and has no `:focus` style, so it is focused but never visible (WCAG 2.4.7) | Add `a[href="#main"]:focus{left:16px;top:16px;...}` with a Paper ground | Press Tab once on the artboard: the link appears |
| L1 | Low | Copy vs deck | Strings on Main that are not in the deck, or differ from it: "Moment" (`:184`); "At the hospital desk" and "With Knowvia" (`:191-216`, from 05 not 04); specimens "Maa is enrolled as a dependant", "Employer member list, page 4", "Two documents disagree on your sister's date of birth", "Schedule says 2001. You told us 2007.", "You, before the renewal" (`:241-268`); "Policy number, TPA, hospital desk" vs deck "... hospital desk contact" (`:353`); "Declared condition and its reason" vs deck "Declared condition" (`:358`); "What you see" (`:587`, no deck line); the menu button has no visible "Menu" text (`:57` vs `04:51`); "your address" fallback (`:532`); P1 brief text inside the slot (`:295`). Onboarding: "Only her" vs "Only them" (`O4:34-42`); "Invite sent, waiting to confirm" (`O4:30`); O4 footnote (`O4:53`); "Choose a file" (`O5:30`); "Drop to add" (`Components:134`) | Add each string to 04 with a rationale, or align the artboard | `copydiff` re-run shows no unexplained strings |
| L2 | Low | Copy logic | `Main.dc.html:254-255`: the heading says "Two documents disagree", but the detail compares one document with what the user said | "Your schedule says 2001. You told us 2007." with the heading "Your schedule and your answer disagree", or name the second document | Re-read |
| L3 | Low | Heading order | `Main.dc.html:121`: the reading-card title is an `h2` inside the hero, ahead of the first section `h2`. The spec says H3 (`05:69`) | Make it `h3` or a `p` | Heading outline: h1, then the section h2s |
| L4 | Low | ARIA detail | No `aria-describedby` from the inputs to the error text (`Main:78` points at the helper only; `:432` has none), although `05:128` requires it. No `aria-controls` on the FAQ (`:409`; `05:117`). The lock icon has `role="img"` "Not shared" and the visible text repeats it (`:361`). A `dd` inside `sc-if` inside a `dl > div` (`:357-362`). On mobile the `role="table"` column headers are removed by `display:none` (`:183`) | Link error ids. Add answer ids and `aria-controls`. Make the lock icon `aria-hidden`. Keep the dd as a direct child with conditional content. Keep visually hidden headers on mobile | Screen-reader pass on the form, the FAQ and the panel |
| L5 | Low | Mobile form spec | `Main.dc.html:77-79`: on mobile the button wraps at its natural width and stays 52px tall. `05:23,123` say full width and 56px | Add `.kv-mobile` rules: field and button 100%, button 56px | View at 390 |
| L6 | Low | Hero overhang | `Main.dc.html:108` overhang is `clamp(-140px,-6vw,-40px)`, which gives -86px at 1440 against 64 in `06:12`. At 390 it is -40px against 40px provenance padding (`:170`), so by estimate the provenance rule crosses the card caption | Use -64px on desktop. On mobile, set the overhang to 0 or raise the provenance padding to 64 | View at 390 and 1440 |
| L7 | Low | Sentence length | `Main.dc.html:497` footer sources sentence is 29 words. `04:320` exempts it as "metadata", which NN12 does not allow for | Split it after "executive," | Count |
| L8 | Low | Gold count | Gold outside the focus ring: Next markers `Main:157,260` (two highlights, within NN18) plus the brand mark (`:47,477`, two fills each) | Log the brand mark as exempt in 00 §7 | Count again after the logo exemption |
| L9 | Low | Serif rule | `Main.dc.html:480`: footer lockup in Newsreader at 22px. `03:100` says Newsreader is never used under 24px except the quote | 24px, or Source Sans 3 | n/a |
| L10 | Low | Motion spec drift | `03:129-132` M1 describes two Known lines, the route line at 1400 to 2000ms and a drawn dashed border. The artboard has three rows, the line at 200 to 1900ms (`Main:126`) and the marker ending at 2270ms (`:157`), beyond the 2200 token. The Motion board shows the marker at 350ms (`Motion:156`) while Main uses 420. `Motion:91` and `03:132` say "without JavaScript, the final state shows immediately", but these are CSS animations that run without JS. M3 in 03 is a grid-rows expand; the build fades in and closes instantly | Make 03 §6, the Motion board and Main agree on one timeline that ends at or before 2200ms. Correct the no-JS sentence | The three sources agree |
| L11 | Low | Doc consistency | `03:40` "two eyebrows (hero, partner)" vs `04:25` "one eyebrow". `03:72` places the partner outline button on a dark band, but it sits on Mist Deep. `03:135` M4 has three viewers, the artboard two. `README.md:261-268` still shows CP1 to CP7 "Not started". `tokens.json` `layout.margin` 80 vs `06:5` "margins 120" (both hold at 1440 only because content is capped at 1200) | Reconcile in 03 and the README (README edit is outside this reviewer's remit) | n/a |
| L12 | Low | Onboarding data continuity | O3 adds four people (`O3:27-42`); O6 finds "3 members" (`O6:33`); O7 says "Read from 3 documents" (`O7D:32`) after O5 shows one valid upload and one rejected (`O5:42-54`). O6 shows "See what we found" while still reading (`O6:40`, deck: "when reading ends"). The O1 sample email invents a name, "meera.k" (`O1:31`, `Components:49,61`), although `04:301` says roles only. Onboarding H1s are 34px, which is not a token (`O1:27` etc.) | Align the counts. Draw the button disabled mid-read. Use "you@example.in". Set H1 to the H2 mobile token (32) or add a token | Walk O1 to O7 in order |
| L13 | Low | Real inputs | `O5-Upload.dc.html:30`: "Choose a file" is a `<button>` with no `<input type="file">` and label (format rule) | Use a visually styled `<label for>` with an `<input type="file" accept=".pdf,.jpg,.png">` | n/a |
| L14 | Low | Next contract | The page promises "Who does it, and by when" (`Main:264`). The O7 Next cells have neither an owner nor a date, and no Next chip or gold marker (`O7D:50,57,64`; `05:147`) | Add owner and timing ("You, this week") and the Next chip | n/a |
| L15 | Low | Script logic | `formModel` lets local state override the Tweaks prop forever after the first interaction (`Main:512`; the viewer, likewise, at `:548`). The error and red border persist while the user retypes (`:534`). The submit `setTimeout` is never cleared (`:542`). "Already", "network" and "server" are reachable only through Tweaks | Reset local state when the prop changes. Clear the error state in `setEmail`. Note the Tweaks-only states in the canvas note | Toggle Tweaks after interacting |
| L16 | Low | Contrast, system board | `Foundations.dc.html:113,122`: the "Aa" sample is white on Rule (3.34:1) at 22px weight 600. It passes only if 600 counts as bold | Use Ink on Rule, or label the sample "non-text only" | n/a |
| L17 | Low | Copy precision | `Main.dc.html:209` "Your cover ends quietly. Nobody tells you." T6 did get the end date by email (transcripts 851). What nobody told him was the 17-day window to keep cover (871, 911) | "You get an end date. Nobody tells you how to keep your cover." | n/a |
| L18 | Low | Spec drift | Hero card "Not confirmed" row has no dashed box around the statement (`Main:152`; `05:72`). Error text is 16px (`Main:85,434`), below body size | Add the box, or update the spec. Errors at Body size | n/a |

**Counts:** High 7, Medium 16, Low 18.

## Checks requested in the brief

### 1. Copy (non-negotiables 11 to 17)

- **Mismatches with 04:** listed in L1. Every other visible string on Main matches 04 verbatim, including all 7 FAQ
  answers, the form-state copy and the footer.
- **Headlines under 8 words:** pass. The longest is 7.
- **Present tense, active verb:** fail on four headlines (M14).
- **Body sentences under 20 words:** pass, except the footer sources sentence (L7). Concatenation artefacts were
  checked by hand.
- **Banned words:** none. "found too late" is close to the banned lateness framing (M14). "covered" appears only as a
  row label ("Who is covered") and in onboarding examples; it is never a claim of approval.
- **Em or en dashes, exclamation marks, ampersands, middle dots:** none in visible copy. This was checked by script
  across all 13 artboards, including the strings in the scripts.
- **One CTA wording:** pass. "Join the early list" appears in the nav, the hero and the closing; "Try again" appears
  only in error states; "Talk to us about a pilot" appears only in the partner block.
- **Bold:** pass. There is one `strong` per section, in 3 sections (`Main:216,251,337`).
- **Headlines-only read:** pass. It makes the offer, contrast, method, stakes, privacy, limits, partner case and close.

### 2. Truth, consent and evidence

| Page item | Transcript evidence | Result |
|---|---|---|
| ₹1,200 room, ₹80,000 loss, A., 26, Gurugram (`Main:297-299`) | T1, lines 14, 149-154 (₹11,200 room vs ₹10,000 cap, "twelve hundred ki galti, assi hazaar ka nuksaan") | Correct. "₹1,200 room choice" means ₹1,200 over the cap; the wording is acceptable |
| ₹8 lakh base, ₹10 lakh deductible, ₹2,00,000 gap, ₹9,400, M., 29, Bengaluru (`Main:131-159,304-306`) | T4, lines 556, 570, 587-596, 1156, 1176 | Correct |
| "it says here, page fourteen" quote, 5 September 2026 (`Main:274-277`) | T4, line 669, verbatim; dated 2026-09-05 | Correct; consent marker dropped (M7) |
| 7 hours, 2 a.m. to 9 a.m., S., 31, Kolkata (`Main:309-311`) | T5, lines 691, 756, 763, 1158 | Correct |
| 17 days, N., 33, Pune (`Main:314-316`) | T6, lines 842, 851-855, 871, 911 | Correct |
| 7 of 19, DOB "six years wrong" (`Main:322-325`) | Lines 508, 535, 1152 (2001 vs 2007) | Figure correct; provenance line wrong (M10) |
| ATM and cash (`Main:203-204`) | T2, lines 415-416 | Correct |
| Sister on family policy (`Main:197`) | T1, lines 47-54 | Correct, but the same family as T8 (H5) |
| Footer: 7 family members and 1 desk executive, 5 to 8 Sept, five cities (`Main:497`) | Headers of T1 to T8 | Correct, except "shared with consent" (H4) |
| ₹5,00,000 floater, page numbers (`Main:349,242,255`) | None (illustrative) | Needs the Example label (M9) |
| Quotes from Mrs. Ghosh (T8) | None quoted verbatim | Pass on quoting; fail on particulars (H5) |
| Claim approval, emergency line, partner names, regulator marks, ratings, logos | None found. FAQ says "Knowvia does not run an emergency line" (`Main:556`); footer disclaimer present | Pass |
| Product works today | Present tense throughout; status signal is weak | M6 |

### 3. Visual system counts

- **Harbour `#176F69` on Main:** 28 property uses. Actions and controls: links, nav hover, chip hover, three primary
  buttons, the outline button, the selected chip and two loading lines. Non-action: 15 (M1).
- **Signal Gold `#E0A02B` on Main:** the focus ring, 2 Next markers, and the brand mark twice. That is 2 highlights,
  within NN18, plus the logo, which should be logged as exempt (L8). Onboarding artboards use gold only in the focus
  ring and the logo.
- **Status by colour alone:** fails for the early-list chips (H2) and the segment control (M2). Known, Not confirmed
  and Next each have an icon, plus a border or a marker: pass.
- **Type sizes:** body is 17 to 19 (pass), lead is 19 to 21 (pass), labels and sources are 15 (pass as Source type).
  Consent and price text fails NN22 (H3). Onboarding H1s are 34px, which is off-token (L12).

### 4. Motion inventory

| Motion | Where | Reduced-motion end state | Loops | Hides content? |
|---|---|---|---|---|
| Route line draw, `kvLine` 1700ms | `Main:126`, `Motion:100` | Yes (`.kv-m`) | No | No |
| Five row settles, `kvIn` 420ms at 300 to 1500ms | `Main:128-156`, `Motion:101-105` | Yes | No | Rows start at opacity 0 for up to 1.5s, in the hero card only |
| Three source fades, `kvFade` 300ms | `Main:132,139,146` | Yes | No | Briefly |
| Gold marker drop, `kvDrop` 420ms at 1850ms | `Main:157`, `Motion:105` | Yes | No | Briefly |
| Loading line, `kvLoad` 1.2s | `Main:82,448`, `O6:30`, `Components:32` | Yes | Yes (allowed) | No |
| Success card settle, `kvIn` 420ms | `Main:94,458` | Yes | No | No |
| FAQ answer, `kvIn` 240ms | `Main:411` | Yes | No | No |
| Permission value fade, `kvFade` 180ms | `Main:358,361` | Yes | No | No |
| FAQ caret rotate, 240ms (inline transition) | `Main:566` | **No** | No | No |
| Segment background, 180ms (inline) | `Main:549` | **No** (colour only) | No | No |
| Button hover and press, chip and outline hover | `Main:17-28` | Yes | No | No |
| O4 switch knob and track, 240 and 180ms | `O4:68-69` | **No** | No | No |
| Onboarding reading list, `kvIn` at 200 to 2300ms | `O6:32-35` | Yes | No | Briefly |

No scroll reveals, nothing gated on scroll, and nothing hidden without JS: everything is CSS with `fill-mode: both`.
The only loop is the loading line.

### 5. Format and accessibility

The format script checked all 13 artboards for: `support.js` in the head, `<x-dc>`, every non-void element closed,
every attribute quoted, every `{{ }}` a plain dotted lookup or literal, single-quoted `data-props` that parse as JSON,
`class Component extends DCLogic` with `renderVals()`, `sc-if` and `sc-for` with their hint attributes, no iframes,
and no network access other than Google Fonts css2. **All pass.** There is exactly one `h1` per artboard. Accessibility
issues are H1, H2, M2 to M4, M16, L3, L4 and L13. Note that `support.js` is not in the repo, so the artboards cannot be
previewed from the repo alone.

### 6. Script logic

- Form state precedence, error persistence and the uncleared timeout are in L15.
- The boolean `disabled` binding is M13.
- The reading-card tabs are inert (M4).
- The hero has no optional-question success step (M11).
- FAQ toggling is correct: one item open at a time, the first open by default, and clicking an open item closes it.
- The Motion replay remounts correctly through `sc-if`.
- The O2 and O4 toggles are correct.

## Taste-skill pre-flight (section 14) and frontend-design calibration

| Box | Result | Note |
|---|---|---|
| Brief inference declared | Pass | `00:68-70` |
| Dial values explicit | Pass | 4 / 3 / 3 |
| Design system or honest aesthetic | Pass | Custom tokens, labelled |
| Redesign audit | N/A | New page; 02 audits the product |
| Zero em dashes | Pass | Script check, all artboards |
| Page Theme Lock | Pass (logged override) | Deep Tide band, `00:55` |
| Color Consistency Lock | **Fail** | Harbour carries action and status (M1) |
| Shape Consistency Lock | Pass | 6 / 10 / 16 / 24 / pill by hierarchy; the segment uses 12/9 and the slot 12 (minor) |
| Button contrast | Pass | 5.98:1 |
| CTA wrap | Pass | `nowrap`; fits at 320 |
| Form contrast | **Fail** | Focus ring 2.11 to 2.27 (H1) |
| Serif discipline | Pass | Newsreader |
| Premium palette check | N/A | Not a premium-consumer brief |
| Italic descender clearance | Pass | Quote line-height 1.3 |
| Hero fits viewport | **Fail** | H1 sets on 3 lines by estimate (M5); lead 26 words (M15) |
| Hero top padding at most 96 | **Fail** | 120 effective (M15) |
| Hero stack, at most 4 elements, no line under the CTA | **Fail, not logged** | The helper line is a truth requirement; log it (M15) |
| Eyebrow count | Pass | 1 of 12 sections, sentence case |
| Split-header ban | Pass | Right columns carry real content |
| Zigzag cap | Pass | Splits are not consecutive |
| No duplicate CTA intent | Pass | 2 intents |
| Logo wall, bento background, Used-by | N/A | None |
| Copy self-audit | **Fail** | L2, M14 |
| Motion motivated | Pass | Motion board table |
| Marquee | Pass | None |
| Nav on one line, at most 80px | Pass | 72px |
| Section-layout repetition | **Fail (minor)** | Sections 7 and 9 share a family (M15) |
| Bento rhythm and cell count | Pass | 4 stories, 4 cells |
| Long lists | Pass | Accordion for 7 FAQs |
| Real images or placeholder slots; no fake UI | Pass, with note | The reading card is a real component specimen, labelled Example |
| No pills on images, photo credits, version footers, micro-meta, decoration strips, floating sub-text, progress bars, locale strips, scroll cues, version labels, section numbers | Pass | |
| No decorative dots | Pass | Route nodes encode state |
| No border-top and bottom on every row | Pass | |
| Content density | **Fail (minor)** | Footer sources paragraph, 46 words (L7) |
| Quotes at most 3 lines, clean attribution | Pass | Initials by design (NN7) |
| Motion claimed = shown; GSAP; scroll listeners | N/A or Pass | |
| Reduced motion | **Fail** | H7 |
| Dark mode tested | Pass (logged override) | A4: tokens only |
| Mobile collapse explicit | Pass | `flex-wrap` and a 760px media query |
| Empty, loading, error states | **Fail** | O1 error, empty matrix, hero optional step (M11) |
| Cards omitted where possible | Pass | |
| Icons from an allowed library | **Fail, partly logged** | Hand-drawn paths (M15) |
| No AI tells (Inter, purple, three equal cards, Jane Doe) | Pass, with note | "meera.k" sample (L12) |
| Core Web Vitals plausible | Pass | The LCP element (H1) is not animated |
| One design system | Pass | |
| **frontend-design calibration** | Pass | No cream and clay, no near-black acid accent, no zero-radius broadsheet, no uppercase eyebrows, no middle-dot meta, no arrow on buttons, no single accented headline word. One bold place (the reading card) |

## Contrast table (pairs actually used)

| Text | Ground | Ratio | AA (normal text) | Where |
|---|---|---|---|---|
| Ink #1A3034 | Mist #F3F7F6 | 12.82 | Pass | Main:71,227,375-379,411 |
| Ink #1A3034 | Paper #FFFFFF | 13.85 | Pass | Main:131,192,298,460 |
| Ink #1A3034 | Mist Deep #E6EFEC | 11.82 | Pass | Main:390,395-397 |
| Tide #163F42 | Mist #F3F7F6 | 10.66 | Pass | Main:70,226,373 |
| Tide #163F42 | Paper #FFFFFF | 11.51 | Pass | Main:178,287,297 |
| Tide #163F42 | Mist Deep #E6EFEC | 9.83 | Pass | Main:112,389; O7D:37 |
| Tide #163F42 | Harbour Tint #E3F0EE | 9.85 | Pass | O2:50; Components:134 |
| Slate #55696D | Mist #F3F7F6 | 5.36 | Pass | Main:90,171,277; O7D:68 |
| Slate #55696D | Paper #FFFFFF | 5.79 | Pass | Main:191,299 |
| Slate #55696D | Mist Deep #E6EFEC | 4.94 | Pass | Main:392,551 |
| White | Harbour #176F69 | 5.98 | Pass | Main:56,79,446 |
| White | Harbour Hover #125A55 | 8.02 | Pass | Main:18 |
| Harbour #176F69 | Paper #FFFFFF | 5.98 | Pass | Main:186,453; O5:30; O7D:50 |
| Harbour #176F69 | Mist #F3F7F6 | 5.53 | Pass | O3:44; O7D:26; O7M:55 |
| Harbour #176F69 | Mist Deep #E6EFEC | 5.10 | Pass | Main:388,391 |
| Harbour #176F69 | Harbour Tint #E3F0EE | 5.11 | Pass | Main:130,576 |
| Gold Ink #7A5207 | Gold Tint #FBF1DD | 6.17 | Pass | Main:151; O6:35; O7D:49 |
| White | Tide #163F42 | 11.51 | Pass | Main:158,335,337 |
| Tide Soft #C9DDD9 | Tide #163F42 | 8.13 | Pass | Main:336 |
| Tide Soft #C9DDD9 | Tide Deep #0B383B | 9.02 | Pass | Main:472-497 |
| White | Tide Deep #0B383B | 12.78 | Pass | Main:480,483 |
| Brick #A74335 | Paper #FFFFFF | 6.00 | Pass | Main:434; O5:53 |
| Brick #A74335 | Mist #F3F7F6 | 5.56 | Pass | Main:85 |
| White ("Aa" sample) | Rule #7B918E | 3.34 | Large text only (22px/600) | Foundations:113 (L16) |

**Non-text (3:1 required):**

| Element | Ratio | Result |
|---|---|---|
| Gold focus ring on Paper | 2.27 | **Fail** (H1) |
| Gold focus ring on Mist | 2.11 | **Fail** (H1) |
| Gold focus ring on Mist Deep | 1.94 | **Fail** (H1) |
| Rule input border on Paper | 3.34 | Pass |
| Rule input border on Mist | 3.10 | Pass |
| Rule on Mist Deep | 2.85 | Not used as a control edge |
| Selected segment or chip fill vs Paper | 1.17 | **Fail** as a sole indicator (H2, M2) |
| Fog dividers | 1.41 | Decorative only |

All text pairs pass. Every recorded value in `tokens.json` and `03` §3 reproduced exactly.

## Cold read: questions a Claude Design user would have to ask

Blocking:

1. What happens after "Send code"? There is no code-entry screen (M11).
2. What does the mobile menu sheet look like, and how does a mobile reader reach Privacy, Partners and Questions? (M11)
3. What does the matrix look like with no policies? O5 "Skip for now" goes to a filled matrix (M11).
4. What does the hero success state look like with the optional question, "Save" and "Saved."? (M11)
5. Which wins when 04 and the artboard differ? Examples: "Declared condition and its reason" vs "Declared condition";
   the specimen copy; "Only her" vs "Only them" (L1). The brief says to keep the 04 copy fixed, but the artboard
   already departs from it.

Non-blocking, for the owner:

6. Does the canvas render each board in its own viewport? `Landing-Mobile` depends on `@media (max-width:760px)`
   (`Main:35`). If the board is not rendered at a 390px viewport, the mobile board shows the desktop nav.
7. Is the CP4 copy formally approved? `README.md` still lists every CP as "Not started". If it is approved, M14 needs a
   logged override; if not, rewrite.
8. Re-consent status for T1, T4, T5 and T6, and the 2 September vs 5 September date anomaly in T3 (H4, M10).
9. Should "Planned treatment" stay on a pre-launch form at all (H6)?

Once H1 to H7 are fixed and M11 is either drawn or explicitly scoped out, the pack meets the cold-read bar.

## Resolution (central owner, 13 October 2026)

All 41 findings were checked against the source before acting. Fixes are published to the canvas (version 18) and the
artboard source in `claude-design/` is updated. All 14 artboards pass the format checks again: `data-props` JSON
parses, every `{{ }}` is a plain lookup, tags balance, the `support.js` line is present, and there are zero em or en dashes.

| ID | Disposition | What changed |
|---|---|---|
| H1 | Fixed | Two-tone focus ring on every artboard: 2px Tide outline at 2px offset plus a 5px gold halo |
| H2 | Fixed | Selected early-list chips show a check icon and a 2px border |
| H3 | Fixed | Helper, consent and purpose lines at Body size (17 to 19); reading-card statements, panel values and the desktop matrix at 18; O1 and O4 consent text at 17 |
| H4 | Fixed in the design; **open for the owner** | The footer says "Names are withheld." plus a visible [CONSENT RE-CHECK BEFORE LAUNCH]. Public re-consent for T1, T4, T5 and T6 is still needed |
| H5 | Fixed in the design; **open for sign-off** | The permission scenario is now generic (share with family; viewer "Your brother"; "Declared conditions, as on your proposal form"). The comparison row no longer names a sister. Specimen years are illustrative (1996 vs 1999). The onboarding sibling is now Brother, 24, with illustrative years. The product owner and researcher should re-read section 6 against T8 |
| H6 | Fixed; **open for legal** | Purpose line under the legend, plus [LEGAL REVIEW: retention and whether to ask this before launch]. Whether "Planned treatment" stays is a legal call |
| H7 | Fixed | A universal reduced-motion rule (`transition` and `animation` off) in every artboard |
| M1 | Fixed | Known chips and onboarding checks in Tide; the comparison rule, column header, mobile labels and eyebrow in Tide. Harbour is now buttons, links and selected controls only |
| M2 | Fixed | The selected segment has a 2px Tide ring |
| M3 | Fixed | Reading-card tabs removed; "Why?" at least 44px; the O4 switch sits in a 60 by 44 button |
| M4 | Fixed | Tabs replaced by a context line, "Showing: You" |
| M5 | Fixed, **verify on render** | Forced break after "Know your cover." with `max-width:17ch` |
| M6 | Fixed | How it works lead starts "When Knowvia opens"; the "When can I use it" question is first and open by default; the helper is Body size |
| M7 | Fixed | Visible consent markers on the quote and on every story source line |
| M8 | Fixed | "Already on the list" shows the success state; the Tweaks option is removed; the Components board documents it as back-end only |
| M9 | Fixed | "Example" on the permission panel and on each specimen source line |
| M10 | Fixed; **open for the researcher** | "Documents families shared with us during this research." The researcher should confirm the 2 September versus 5 September date |
| M11 | Fixed | A new Extra states board (O1 error, O1b code entry, empty matrix, post-signup question, mobile menu); the mobile menu also works on the landing artboards (Tweak or the Menu button) |
| M12 | Fixed | O4 is now "Choose what you share." Other adults decide for themselves, with a suggested default |
| M13 | Fixed | `disabled` binding replaced with `aria-disabled` plus a guarded submit handler |
| M14 | Fixed and logged | Four headlines rewritten with active verbs; the two navigational labels are logged as an override in 03 §10 |
| M15 | Fixed and logged | Hero lead cut to 20 words; the extra 24px above the H1 removed; the helper line, inline icons and shared split family logged in 03 §10 |
| M16 | Fixed | The skip link becomes visible on focus |
| L1 | Fixed | Deck synced with every artboard string, including the specimens, labels, menu and extra states |
| L2 | Fixed | "Your schedule and your answer disagree" wording |
| L3 | Fixed | Reading-card title is a paragraph, not an `h2` |
| L4 | Mostly fixed | Error ids linked with `aria-describedby`; FAQ `aria-controls`; lock icon `aria-hidden`; `dd` is a direct child. **Open:** mobile column headers of the contrast table are still hidden with `display:none` (rows keep visible cell labels) |
| L5 | Fixed | Mobile hero button is full width and 56px |
| L6 | Fixed | Overhang is 64px on desktop and 0 on mobile |
| L7 | Fixed | Footer source sentence split |
| L8 | Logged | The brand mark is exempt from the gold count (NN18 updated) |
| L9 | Fixed | Footer lockup at 24px |
| L10 | Fixed | One timeline in 03, Main and the Motion board (marker 1800 to 2200ms); the no-JS sentence corrected |
| L11 | Fixed | 03 says one eyebrow, places the partner button on Mist Deep and describes two viewers; README updated |
| L12 | Fixed | Counts agree (two documents, four members); "See what we found" appears when reading ends; sample email you@example.in; onboarding H1 at 32 |
| L13 | Fixed | A real `<input type="file">` with a styled label |
| L14 | Fixed | Every Next in O7 has an owner and a time, plus the gold marker on desktop |
| L15 | Fixed | Tweak changes reset local state; errors clear while typing; timers are tracked and cleared |
| L16 | Fixed | Ink sample on the Rule swatch, labelled non-text |
| L17 | Fixed | "You get an end date. Nobody tells you how to keep your cover." |
| L18 | Fixed | Dashed box around the hero's Not confirmed statement; error text at 17 |

**CP7 state.** No High finding is open in the design. Three items wait on people, not on design: public re-consent
(H4), sign-off on the generic permission example (H5), and a legal call on the optional "Planned treatment" field (H6).
Two items need a look on the rendered canvas: the headline break (M5) and the runtime behaviour of `aria-disabled`
(M13). One Low remains open (L4, mobile table headers).
