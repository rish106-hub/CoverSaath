# CP4 Information architecture and copy deck

Status: done, 13 October 2026. Every visible string for the landing page and onboarding, in order, with its reason.
Rules applied: requirements §7 (non-negotiables 11 to 17), CP1 §6 (copy principles) and CP3 (type roles). Evidence IDs
refer to the register in requirements §11 and CP2 §6. **Bold** in the copy column is the one emphasised claim for that
section. Text in [SQUARE BRACKETS] is a visible placeholder for a fact the team must supply.

## 1. Page map

| # | Section | Job | Layout family | Ground |
|---|---|---|---|---|
| 0 | Nav | Orient; repeat the one action | Single row | Mist |
| 1 | Hero | State the offer, show the product's job, take the email | Split 7/5 with the reading card | Mist |
| 2 | Provenance line | Say where the page's evidence comes from | One centred sentence | Mist |
| 3 | Contrast | Name the old way by situation, not by company | Two-column comparison table | Paper |
| 4 | How it works | Explain Known, Not confirmed, Next | Vertical route sequence with specimens, then one quote | Mist |
| 5 | Stories | Prove the stakes with sourced numbers | Asymmetric grid: one large, three small | Paper |
| 6 | Household control | Serve the second reader (parents); show permissions | Dark band, split, interactive panel | Deep Tide |
| 7 | What we will not do | Negation as trust | Two-column definition list | Mist |
| 8 | Partners | One block for the second audience | Split with outline CTA | Mist Deep |
| 9 | Questions | Answer objections | Heading left, accordion right | Mist |
| 10 | Closing | Repeat the action, full form | Centred form card | Paper |
| 11 | Footer | Legal, sources, links | Columns | Tide Deep |

Seven layout families; no family repeats in adjacent sections. One eyebrow on the page (section 8).

**Headlines alone, in order.** Know your cover. Before you need it. / Read your policy before the hospital does. /
Three answers for every person you cover. / Small details, found too late. / Each person decides what family sees. /
What we will not do / Fewer "what does my policy cover?" calls. / Questions families ask us / Your policy, read before
you need it. *The offer, the contrast, the method, the stakes, the privacy, the limits, the partner case and the close
all read in order (non-negotiable 16).*

## 2. Page metadata

| Field | Copy | Reason |
|---|---|---|
| Title | Knowvia: know your cover before you need it | Brand first, then the promise; no pipe characters |
| Meta description | Understand your family's health insurance before you need it. Knowvia reads your policies person by person and shows what is known, what is not confirmed, and what to do next. | Uses the README descriptor (CP2 §4) plus the product line |
| Open Graph title | Know your cover. Before you need it. | The lockup |
| Open Graph image | [OG IMAGE: the reading card's final state on Mist, 1200x630] | Shows the product, not a slogan |

## 3. Landing page copy

### 0. Nav

| Element | Copy | Reason |
|---|---|---|
| Logo | Knowvia (K route mark plus wordmark), alt "Knowvia home" | Existing asset |
| Links | How it works / Privacy / For partners / Questions | Four entries at most (Hick); "Privacy" is the parent's first worry, so it gets a link |
| Button | Join the early list | Same words as every other primary CTA (non-negotiable 15). Desktop only; on mobile the nav shows the logo and a menu button, and the hero form sits in the first screen |
| Menu button (mobile) | Menu, `aria-label` "Open menu" | Plain label |

### 1. Hero

| Element | Copy | Reason |
|---|---|---|
| H1 | Know your cover. Before you need it. | The approved lockup (B6). Seven words in two sentences: the first is a stance, the second names timing, which implies the old way (finding out during a crisis) without fear words. Full stops make both feel settled (CP1 punctuation) |
| Lead | Knowvia reads your family's health insurance with you, one person at a time. See what is known, what is not confirmed, and what to do next. | Clause one says what it does and for whom ("with you": it is not an outside authority). Clause two is the product line, rewritten as three things you will see. The serial comma makes the triad feel complete. Under 20 words per sentence |
| Field label | Email | A visible label, not a placeholder |
| Button | Join the early list | The low-ability ask suits a calm-month visitor (Fogg). It names exactly what happens |
| Helper under field | Knowvia is not open yet. We will email you when it is. | States pre-launch status plainly, without a "BETA" eyebrow (non-negotiable 2). Two short sentences remove the fear of spam |

**Reading card (the hero component).** It is labelled as an example, and its numbers follow a real case (E3).

| Element | Copy | Reason |
|---|---|---|
| Card label | Example | Honesty first: this is an illustration, not a live result |
| Person tabs | You / Maa / Papa | Shows "person by person" at a glance. "Maa" and "Papa" are how the audience names parents; they are not stock names |
| Card title | A top-up quote, read before paying | Names the moment (buying) that T4 proved Knowvia changes |
| Meta | 2 documents read | Shows the input is the family's own documents |
| Known 1 | Your base cover is ₹8,00,000 | E3. Indian digit grouping, exact figure |
| Source | Base policy schedule | The citation device (CP3 §2) |
| Known 2 | The top-up pays only after ₹10,00,000 | E3. "only" carries the catch |
| Source | Top-up quote, deductible line | Where T4 actually read it |
| Known 3 | A bill between ₹8 and ₹10 lakh is yours to pay | E3, calculated. Plain consequence, second person |
| Source | Calculated from both documents | Shows the Calculated state without the word |
| Not confirmed | Room-rent limit in your base policy | A common unknown (E2's cause) |
| Source | That page is missing from your copy | The reason it is not confirmed; no blame |
| Next | Before you pay ₹9,400, ask the seller about the ₹2,00,000 gap. | E3's real premium. A question to ask, not product advice. The gold marker lands here |
| Caption under card (Source style) | Illustrative. Based on a top-up quote a family shared with us in September 2026. | Keeps the example honest (non-negotiable 4) |

### 2. Provenance line

| Element | Copy | Reason |
|---|---|---|
| Sentence | Built from recorded conversations with families and a hospital insurance desk, September 2026. | E1. Replaces a stat strip. "Recorded" and the date make it concrete. No survey language |

### 3. Contrast

| Element | Copy | Reason |
|---|---|---|
| H2 | Read your policy before the hospital does. | Seven words. The contrast effect, framed by situation (CP1 layout 2). It implies the desk and TPA read it first today, which is the problem |
| Lead | The same five moments, two ways. | Sets up the table in seven words |
| Column A heading | Finding out at the hospital desk | The old way, named as a situation, never a company |
| Column B heading | Knowing it with Knowvia | The new way, in the same grammatical shape |

| Row | Finding out at the hospital desk | Knowing it with Knowvia | Evidence |
|---|---|---|---|
| Room rent | You learn the room limit when the bill arrives. | You see the room limit, and its page, before you choose a room. | E2 |
| Who is covered | You are not sure your sister is still on the family policy. | Every person has a row: known, not confirmed, or missing. | T1 (researcher note), E9 |
| Cash | You look for an ATM while the admission waits. | You know how much cash to keep ready, and why. | E8 |
| Leaving a job | Your cover ends quietly. Nobody tells you. | The deadline to keep your cover is already on your page. | E6 |
| Buying more | A relative says the top-up is cheap. | You see what the top-up adds, and **what it does not**. | E3 |

*Each pair answers the same question (CP1 layout 2). Left sentences are short and passive in feeling; right sentences
start with "you" acting. The one bold phrase is the claim the whole page turns on: honesty about limits.*

### 4. How it works

| Element | Copy | Reason |
|---|---|---|
| H2 | Three answers for every person you cover. | Promises a fixed, small structure (processing fluency). "Every person" carries the household idea |
| Lead | Add the policies you already have: your employer's, your own, your parents'. Knowvia reads them person by person. | Names the three silos the research found (B9) in the reader's words |
| Step 1 label | Known | Signature chip, check icon |
| Step 1 H3 | What your documents prove | |
| Step 1 body | Sum insured, members, room limits, waiting periods. Each one shows the page it comes from. | "Page it comes from" is the product's evidence rule in plain words |
| Step 2 label | Not confirmed | Signature chip, question icon, dashed border |
| Step 2 H3 | What is missing or unclear | |
| Step 2 body | If a page is missing or two documents disagree, we mark it. **We never guess.** Then we tell you who can answer. | The bold claim is the product's core rule (fail closed) |
| Step 3 label | Next | Signature chip, arrow icon, gold marker |
| Step 3 H3 | One step to take now | |
| Step 3 body | Who does it, and by when. Not a lecture about what you should have done. | E7 in Knowvia's words: the next step, not the counterfactual |
| Quote | "I can't say 'an app told me.' I can say 'it says here, page fourteen.'" | E4, verbatim. Explains why sources matter, in a customer's voice |
| Attribution | M., 29, Bengaluru | Anonymised (non-negotiable 7) |
| Source | Recorded conversation, 5 September 2026. [CONSENT RE-CHECK BEFORE LAUNCH] | |

### 5. Stories

| Element | Copy | Reason |
|---|---|---|
| H2 | Small details, found too late. | Five words; the comma pivots from detail to timing. It describes, without fear words |
| Lead | Four things families told us. Each one was in a document they already had. | The second sentence is the turn: the information existed, it just was not read |

| Block | Figure | Story | Source line | Evidence |
|---|---|---|---|---|
| Large | ₹80,000 | A ₹1,200 room choice, made with no information, cost one family ₹80,000. | A., 26, Gurugram. Recorded conversation, September 2026. | E2 |
| Small | ₹2,00,000 | A gap neither policy would pay. She found it before paying ₹9,400 for the top-up. | M., 29, Bengaluru. Recorded conversation, September 2026. | E3 |
| Small | 7 hours | From 2 a.m. to 9 a.m., spent finding a brother's employer cover at the hospital. | S., 31, Kolkata. Recorded conversation, September 2026. | E5 |
| Small | 17 days | The window to keep cover after leaving a job. No one sent a reminder. It closed. | N., 33, Pune. Recorded conversation, September 2026. | E6 |
| Footnote line | 7 of 19 | 7 of the 19 policy documents families shared had a detail that did not match what the family believed. One schedule had a date of birth six years wrong. | Documents shared during the same conversations. | E9, E10 |

*Figure first, story second, source directly under it in body size (CP1 copy pattern). Numbers are exact and never
rounded up. The large block is E2 because it is the clearest cause and effect.* Each block carries [CONSENT RE-CHECK
BEFORE LAUNCH] in the design file's annotations, not on the page.

### 6. Household control (Deep Tide band)

| Element | Copy | Reason |
|---|---|---|
| H2 | Each person decides what family sees. | Six words. Speaks to the parent as much as the operator. Built on T8's principle in Knowvia's own words (non-negotiable 8) |
| Lead | Share the cover amount with your son. Keep the medical reason to yourself. Change it whenever you like. | Three short sentences: share, withhold, control. "the number yes, the reason no" without quoting it |
| Panel title | What your son sees | Updates with the viewer chosen |
| Viewer switch | You / Your son | Two states make the difference obvious (M4) |
| Row: Cover amount | ₹5,00,000 floater | Cover class (B11) |
| Row: Policy details | Policy number, TPA, hospital desk contact | Operational class |
| Row: Medical details | Declared condition: (value for You) / Not shared (for Your son), lock icon | Protected class |
| Panel footnote | You can also set emergency access in advance, for a moment you cannot speak for yourself. | Describes a permission setting, not a live emergency service (non-negotiable 3) |
| Body under panel | Every adult controls their own record. **Medical details are never shared by default.** | The bold sentence is the strongest privacy claim, and true by design (B11) |

### 7. What we will not do

| Element | Copy | Reason |
|---|---|---|
| H2 | What we will not do | A label, so no full stop. Negation as trust (CP1) |

| Term | Description | Reason |
|---|---|---|
| Promise a claim | Only your insurer decides a claim. We show which clauses apply and what is still open. | Non-negotiable 1 |
| Guess | A fact we cannot find stays marked Not confirmed until someone who knows confirms it. | Product's fail-closed rule |
| Push a policy | Sometimes the right answer is to buy nothing yet. We will say so. | T4: "not this, not now" |
| Show medical details | Not to anyone, unless that person chose to share them. | B11 |
| Replace your insurer | We are not your insurer, TPA or hospital desk. We help you ask them better questions. | README overview ("We help you ask better questions earlier") |

### 8. Partners (the one eyebrow)

| Element | Copy | Reason |
|---|---|---|
| Eyebrow | For HR platforms, insurance platforms and advisers | Routes the second audience without a nav router (CP1 layout 3) |
| H2 | Fewer "what does my policy cover?" calls. | Seven words. Names the partner's own cost in the end user's words (repo partner value: fewer avoidable "what does my policy cover?" handoffs) |
| Body | Knowvia can sit where your customers and employees already meet their cover. They get a clear view of every policy in their household. You keep your own support relationship. | Pronoun split (CP1): "your customers", not "you". Three sentences under 20 words |
| Point 1 | HR platforms: at joining or a benefits change, with the employee's permission. | The HRMS entry moment (round2 acquisition hypothesis) |
| Point 2 | Insurance platforms and advisers: after a purchase or renewal, linked to the issued policy. | The platform entry moment |
| Point 3 | No data moves without the person's consent, field by field. | Permission model applies to partners too |
| Outline button | Talk to us about a pilot | The second and only other CTA intent. "Pilot" is honest about the stage. Links to [PARTNERS EMAIL] |

No partner names, logos or "trusted by" (non-negotiable 5).

### 9. Questions

| Element | Copy | Reason |
|---|---|---|
| H2 | Questions families ask us | A label; no full stop |

| Question | Answer |
|---|---|
| Is Knowvia an insurance company? | No. Knowvia does not sell or underwrite insurance, and it does not decide claims. It reads the policies you already have and shows what they say. |
| Will you sell me a policy? | Not by default. Many questions end with a clear answer and nothing to buy. If buying something does make sense, we will explain why and what it costs. [LEGAL REVIEW: licensed partner disclosure] |
| Can Knowvia tell me if a claim will be approved? | No. Only your insurer decides that. We show which clauses apply, what is not confirmed, and which documents to have ready. |
| What should I do in an emergency? | Get treatment first. Insurance should never delay care. Call the hospital's insurance desk, your insurer or your TPA. Knowvia does not run an emergency line. |
| Who can see my family's information? | Each adult decides for their own record: the cover amount, the policy details and any medical details, separately. Medical details stay private unless that person shares them. |
| What documents do I need? | Whatever you have: the policy schedule, the full wording, your employer's benefits booklet, a renewal notice or a quote. If a page is missing, we tell you exactly which one to ask for. |
| When can I use it, and what will it cost? | Knowvia is not open yet, and pricing is not set. Join the early list and you will hear about both first. |

*Seven questions (CP1: five to seven). Questions use the reader's own words and question marks; answers open with the
direct answer ("No.", "Not by default.", "Get treatment first.") before any explanation.*

### 10. Closing

| Element | Copy | Reason |
|---|---|---|
| H2 | Your policy, read before you need it. | Seven words. Echoes the hero's "before you need it" (closings echo openings, CP1) |
| Lead | Join the early list. We will email you when Knowvia opens. | The action and its single consequence |
| Field label | Email | |
| Optional group label | What is coming up for your family? (optional) | Progressive: helps prioritise, never required |
| Options | A renewal / Planned treatment / A job change / Parents' cover / Nothing yet, just getting organised | Matches the onboarding event step (CP2 §8) |
| Button | Join the early list | Same words as the hero |
| Negation line | Not an insurer. Not selling your data. One email when we open. | Three short refusals beside the action (CP1 copy). [LEGAL REVIEW: data claim wording] |
| Consent line | We use your email only to tell you when Knowvia opens. Read the [privacy notice]. | Purpose next to the field (non-negotiable 10). No pre-ticked box |

### 11. Footer

| Element | Copy |
|---|---|
| Lockup | Knowvia. Know your cover. Before you need it. |
| Column: Knowvia | How it works / Privacy / For partners / Questions |
| Column: Contact | [CONTACT EMAIL] / [PARTNERS EMAIL] |
| Column: Legal | Privacy notice [LEGAL REVIEW] / Terms [LEGAL REVIEW] |
| Disclaimer | Knowvia is not an insurer, broker or TPA, and does not decide claims. [LEGAL REVIEW: registration and partner disclosure] |
| Sources | Where our numbers come from: recorded conversations with seven family members and one hospital insurance-desk executive, 5 to 8 September 2026, in Kolkata, Bengaluru, Pune, Mumbai and Delhi NCR. Names are withheld and shared with consent. Figures are what people told us and what their documents showed. They are examples, not averages. |
| Copyright | © 2026 Knowvia |

## 4. Early-list form states (hero and closing share one component)

| State | Copy |
|---|---|
| Default | Label "Email". Button "Join the early list". Helper "Knowvia is not open yet. We will email you when it is." |
| Empty submit | Error "Enter your email address." |
| Invalid | Error "Enter an email address like name@example.com." |
| Submitting | Button "Joining", disabled, loading line under it |
| Success | Heading "You are on the list." Body "We will email {email} when Knowvia opens. While you wait, find your policy schedule and your employer's benefits booklet." |
| Success, optional question (hero only) | "What is coming up for your family? (optional)" with the five options, button "Save", then "Saved." |
| Already on the list | "This email is already on the list. We will write when Knowvia opens." |
| Network error | "We could not add you. Check your connection and try again." Button "Try again" |
| Server error | "Something went wrong on our side, and your email was not saved. Try again in a minute." Button "Try again" |

*Errors say what happened and how to fix it, with no apology (frontend-design writing rules). "Join" in the button
returns as "Joining", and "Save" as "Saved".*

## 5. Onboarding copy (future state; assumption A1)

Shown as a phone flow (390) with a desktop frame for the first matrix. Progress: "Step N of 5" on steps 1 to 5.

| Screen | Element | Copy |
|---|---|---|
| O1 Start | H1 | Start with your own cover. |
| | Body | Use your email or phone. We will send a one-time code, so there is no password to remember. |
| | Field | Email or phone |
| | Button | Send code |
| | Errors | "Enter an email address or a 10-digit mobile number." / "That code did not match. Check the latest message and try again." |
| O2 What is coming up | H1 | What is coming up? |
| | Body | This tells us what to read first. |
| | Options | A renewal / Planned treatment / A job change / Parents' cover / Nothing yet, just getting organised |
| | Button | Continue |
| O3 People | H1 | Who is in your family's cover? |
| | Body | Add anyone whose policy you help with: a partner, children, parents or a sibling. |
| | Row (pre-filled) | You |
| | Add button | Add a person |
| | Add fields | Name or what you call them / Relationship / Age |
| | Button | Continue |
| | Note | Adults you add get an invite to confirm what they share. |
| O4 Sharing | H1 | Choose what each person shares. |
| | Body | Each adult decides for their own record. You can change this at any time. |
| | Rows per person | Cover amount: Shared with family / Policy details: Shared with family / Medical details: Only them |
| | Emergency access | Emergency access, set in advance. Let one person you choose see everything if you cannot speak for yourself. Off |
| | Button | Continue |
| O5 Add a policy | H1 | Add the policies you have. |
| | Upload zone | Drop a PDF or photo here, or choose a file |
| | Accepted | PDF, JPG or PNG, up to 15 MB each |
| | Document chips | Policy schedule / Policy wording / Employer benefits booklet / Renewal notice / Quote |
| | Skip | No policy to hand? Skip for now. We will tell you exactly what to ask for. |
| | Security note | Files are encrypted. Only people you allow can see them. |
| | Errors | "This file is over 15 MB. Try a PDF instead of photos." / "This file could not be read. Try the original PDF or a clearer photo." / "This file type is not supported. Use PDF, JPG or PNG." |
| | Button | Read my documents |
| O6 Reading | H1 | Reading your documents |
| | Live list | Found: policy schedule, 4 pages / Found: 3 members / Found: sum insured ₹5,00,000 / Not found: room-rent clause |
| | Body | You can leave this page. We will email you when it is ready. |
| O7 First matrix | H1 | Your family's cover |
| | Meta | Read from 3 documents, 13 October 2026 |
| | Column heads | Person / Policies / Known / Not confirmed / Next |
| | Row: You, 33 | Employer group policy / Sum insured ₹5,00,000 (Schedule, page 2) / Room-rent limit / Ask HR for the full benefits booklet |
| | Row: Maa, 58 | Covered on your employer policy / Enrolled as a dependant (Member list, page 4) / What happens if you change jobs / Note the date your cover would end |
| | Row: Sister, 19 | Covered on your father's policy / Enrolled (Schedule, page 1) / Two documents disagree: date of birth 2001 or 2007 / Ask the insurer to correct the date of birth |
| | Empty state | No policies yet. Add one to see your first row. Button "Add a policy" |
| | Waiting state | Waiting for a document. "Ask Papa for his renewal notice." |
| | Row action | Why? (opens the source page and the reasoning) |

*Names are roles ("Maa", "Sister"), never invented full names (taste skill 9.D). The example values are illustrative
and labelled "Example" in the design file. E10 appears only as a generic example.*

## 6. Microcopy

| Element | Copy |
|---|---|
| Reading card `aria-label` | Example of Knowvia reading a top-up quote |
| Signature chips (screen reader) | "Known:", "Not confirmed:", "Next step:" read before each line |
| Skip link | Skip to main content |
| FAQ button state | `aria-expanded` true or false; no visible "click to expand" text |
| Lock icon | `aria-label` "Not shared" |
| Placeholder photo alt (if used) | A folder of insurance papers on a shelf |

## 7. Copy rule check (self-audit before CP7)

| Rule | Result |
|---|---|
| Headlines under 8 words | Pass: longest is 7 |
| Body sentences under 20 words | Pass after this audit (the longest is the footer source line, which is metadata, not body) |
| Banned words (revolutionary, seamless, unlock, empower, elevate, unleash, next-gen, AI-powered, fear words) | None found |
| Em or en dashes in visible copy | None |
| Exclamation marks, ampersands, Title Case headlines, rhetorical questions in headlines | None (the partner H2 quotes a customer's question; it is not rhetorical) |
| One CTA wording | "Join the early list" in nav, hero and closing. The second intent is "Talk to us about a pilot", partner block only |
| Bold per section | At most one phrase per section |
| Every number has an evidence ID | Yes: E2, E3, E5, E6, E8, E9, E10; the hero card and onboarding are labelled examples |
