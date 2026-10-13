# Knowvia landing and onboarding: requirements and working framework

Status: **CERT = READY for CP1 to CP4 (research, audit, direction, copy). Hand-off format confirmed: Claude Design, no Figma connector.**
Written 13 October 2026. Classification: **S1** (product and design work, no code, no production change).

This file fixes the requirements before any design work starts. Every later checkpoint is checked against it.
If a later decision contradicts this file, this file is updated first, with the reason, before the work continues.

---

## 1. Objective

Produce a complete, evidence-backed design brief for the Knowvia landing page and onboarding experience. It must
be complete enough that Claude Design can build the visual design (and later Figma) without re-deriving anything.

The brief covers four things, in this order of importance:

1. **Text copy.** Every visible line, with the reasoning behind it.
2. **Layout.** Section order, grid, spacing and the job of each section.
3. **Design language.** Colour, type, shape, imagery and motion.
4. **Dependencies.** Fonts, icons and anything else the build needs.

## 2. Inputs and their authority

| Input | Where | What it is authoritative for |
|---|---|---|
| Fintech landing page design language report (11 sites, framework, addendum) | [Claude Doc](https://claude.ai/code/artifact/34ee80e8-42e5-4f90-ab0c-3e873a062ec2), read in full on 13 Oct 2026 | Copy rules (hero formula, section order, sentence rules, banned words), layout patterns, CTA logic, design principles |
| Product truth and boundaries | `README.md`, `docs/strategy/round2-answers.md`, `working/working.md`, `building/insurance.md` | What Knowvia does, what it must never claim, what is live and what is not |
| Brand system | `research/01-product.md` section 9, `research/04-market-and-sources.md` "Brand evidence review", `docs/assets/knowvia-*` | Name, lockup, palette, type, voice, visual signature |
| Customer evidence | `docs/evidence/coversaath-interview-transcripts.md` (8 transcripts, 5 to 8 Sep 2026) | Proof content, customer language, pain points |
| Current product UI | `src/ui/styles.css`, `src/ui/app.js` | Tokens and components already in use; what onboarding must hand off to |
| Anti-template review gate | `design-taste-frontend` skill (taste-skill, MIT, commit `d237dd3`) | Pre-flight checks and banned "AI tells". Advisory only |

`research/01-product.md` is marked superseded for product claims. Its **brand system section (9) is still the
live brand spec**: `research/04-market-and-sources.md` confirms it, and the shipped UI and wordmark follow it.
Product claims are taken only from the live files listed above.

## 3. Rule precedence

Where two inputs disagree, the higher rule wins and the conflict is logged in the checkpoint's output.

1. **Truth, safety and consent.** Product boundaries, evidence status, consent and publication rules from the repo.
2. **User decisions** recorded in section 5.
3. **The research report's copy and layout rules.** The user requires these to be followed.
4. **The Knowvia brand system** (palette, type, voice, signature).
5. **The taste skill pre-flight.** Advisory; it never overrides 1 to 4.

Conflicts already identified and resolved:

| Conflict | Resolution | Reason |
|---|---|---|
| Research: "name the buyer's pain in the headline". Brand: "never use death, illness or family guilt to force a purchase" | Name the **operational** pain (not knowing, finding out at the desk, 2 a.m. phone calls), never the medical fear | Rule 1 beats rule 3; T5 and T1 already supply operational pain |
| Research: proof is stat strips, logos, ratings. Reality: no users, partners or ratings exist | Research-backed proof only (user decision D6): recorded conversations, anonymised quotes, real rupee amounts from those cases | Rule 1 |
| Research: "two audiences on one page" (Plum, Loop). Brand: households are the wedge | Households own the hero and the first five sections; partners get one dedicated block lower down with its own CTA | User decision D2 plus research Step 4 |
| Taste skill: "Page Theme Lock, no inverted sections". User chose Deep Tide bands | Deep Tide bands are allowed: at most 2 (one mid-page, plus the closing CTA and footer) | Rule 2 beats rule 5; Albert and Thatch use the same device |
| Taste skill: no three equal feature cards. Research Step 4: "three steps" | The three steps are kept but laid out asymmetrically or as a sequence, never as three identical cards | Both satisfied |
| Research: pill buttons (7 of 9 sites). Product UI: 10px control radius | Pill for marketing CTAs on the landing page; onboarding forms keep the product's 10px controls, buttons stay pill. Final call at CP3 | Continuity with the product on handover |
| Taste skill bans Lucide by default; README shows none chosen | Icons from Phosphor (MIT). Confirmed at CP3 | Rule 5, no conflict above it |

## 4. Users

| Audience | Who | State of mind | What the page must do |
|---|---|---|---|
| **Primary: household operator** | Adult, roughly 26 to 45, managing their own employer cover plus parents' or a partner's policy | Busy, mildly anxious, sceptical of insurance sellers, has never read the policy | Show in one screen that Knowvia tells them what they have, what is uncertain and what to do next, without selling them a policy |
| **Secondary reader: parent or senior** | Roughly 46 to 60, may approve sharing or read a shared brief | Wary of apps and of children seeing private details | Stay legible and respectful; make the per-person permission promise visible |
| **Partner** | HRMS providers, insurance platforms, advisers | Professional, evaluating fit | One block naming the value for their users and a low-commitment pilot conversation |

Design-taste read for this brief: **trust-first consumer landing for Indian household insurance operators, calm
editorial language, serif display over humanist sans, restrained motion.** Target dials: DESIGN_VARIANCE 4,
MOTION_INTENSITY 3, VISUAL_DENSITY 3 (the skill's "trust-first / regulated" band, eased toward "editorial").

## 5. Decisions log (user, 13 October 2026)

| ID | Decision | Consequence |
|---|---|---|
| D1 | Brand name is **Knowvia**. Lockup: "Know your cover. Before you need it." | CoverSaath and Waymark appear nowhere in the design |
| D2 | Audience: **households first, plus a partner block** | Two-audience pattern, with households dominant |
| D3 | Scope: **landing page plus onboarding** (desktop and mobile), ending at the first household-matrix screen | Full product screens are out of scope |
| D4 | Primary CTA: **Join the early list** | No copy may imply the product analyses real policies today |
| D5 | Direction: **Calm editorial.** Mist and Paper ground, Deep Tide bands, Newsreader display, Source Sans 3 body, Harbour pill CTA, Signal Gold only for focus and one highlight | Section 9 tokens are the base palette |
| D6 | Proof: **research-backed.** Real conversations and anonymised quotes, no fake stats | Placeholder stats, ratings and logos are banned |
| D7 | Output: **Claude Design hand-off**, no Figma connector | CP5 and CP6 produce specs and a design brief, not Figma files |
| D8 | Location: this repo, `docs/design/`, branch `claude/happy-turing-omsfrt` | Moves to the landing-page repo once that exists |

Defaults I have set. Each can be changed at the CP3 gate:

| ID | Default | Why |
|---|---|---|
| A1 | Onboarding is designed as the **future-state** flow (sign-up, consent, add people, add a policy, first matrix). It is reached only after launch; until then the CTA leads to the early-list form | D3 plus D4: the flow must be designed, but the page must not pretend it is live |
| A2 | English only. Type stack includes Noto Sans Devanagari so Hindi can follow without redesign | No Hindi copy has been reviewed |
| A3 | Frames: desktop 1440, mobile 390. Tablet is described in notes, not drawn | Research audited desktop only; mobile is a hard requirement of the brief |
| A4 | Light theme is primary. A dark theme gets token values, but no separate page design | The product UI already supports `prefers-color-scheme` |
| A5 | CP1 re-opens the 11 public home pages, read-only, to capture full copy | The report quotes only a few lines per site; line-by-line analysis needs the full text |

## 6. Scope

**In scope**

- Landing page: navigation, hero, proof, contrast block, how it works, stories from the research, household
  control and permissions, partner block, what Knowvia will not do, FAQ, closing CTA, footer.
- Early-list form with all of its states: empty, typing, validation error, submitting, success, already on the
  list, network error.
- Onboarding (future state): account, consent, add household members, per-person permission defaults, add a
  first policy (upload or forward), processing, first household matrix (Known, Unknown, Next).
- Design system for these surfaces: tokens, type scale, grid, spacing, radius, elevation, motion, icons, components.
- Copy deck with a rationale for every line.
- Placeholder register: every image or asset not yet available, with its brief.

**Non-goals**

- Figma files (D7). Code or a live site. Redesigning product screens beyond the first matrix (D3).
- Legal text (privacy policy, terms, disclaimers). Slots are designed and marked "legal review required".
- Analytics tool choice. Event names are proposed; tools are not.
- Name or trademark clearance (`research/04-market-and-sources.md` says it is still pending).
- Hindi copy (A2).

## 7. Non-negotiables

A design that breaks any of these fails, however good it looks.

**Truth**

1. No claim of claim approval, guaranteed savings, faster settlement or insurer control. Knowvia is not an
   insurer and does not promise outcomes (README, round2 answers).
2. No claim that the product works on real policies today. Pre-launch status must be clear without a "BETA" eyebrow.
3. No 24x7 human or emergency line promised. Round 2 says the emergency route cannot launch without a measured
   rota. Emergency can appear only as a stated principle ("admit first, optimise later") or as a future
   capability labelled as such.
4. No invented numbers, users, ratings, partner logos, regulator marks, awards or press. Every number on the page
   cites an evidence ID (section 11).
5. No naming of proposed partners (Ditto, HRMS vendors, Gnani, Sarvam, Pine Labs) as if they had agreed to anything.
6. No licence or IRDAI claim. The licensed distribution partner is a design assumption, not a fact.

**Consent and privacy**

7. Quotes are anonymised (first initial, age and city at most) and marked "consent re-check before launch", per
   the transcripts' publication rule.
8. Nothing from Mrs. Ghosh's session (T8) is quoted. Her permission principle may appear only in Knowvia's own words.
9. Permissions are shown as per person, per viewer and per information class, never as one household switch.
10. The early-list form collects the minimum: email required; phone and "what's coming up" optional. The purpose is
    stated next to the fields, and there is no pre-ticked consent.

**Copy (from the research report, binding)**

11. Hero formula: pain or old way, plus a reframe in under eight words, plus proof within one scroll, plus one CTA.
12. Headlines under eight words, present tense, active verb. Sub-lines are one clause. Body sentences are under 20
    words, in the second person.
13. Bold on one or two words per section, only on the claim that matters most.
14. Banned words: revolutionary, seamless, unlock, empower. Also banned, from the brand and the taste skill:
    elevate, unleash, next-gen, AI-powered as a headline, and fear words used to sell (death, tragedy, "before
    it's too late").
15. One primary CTA per screen, with the same words at the top and bottom of the page. The partner CTA is the only
    second intent, and it appears only in the partner block.
16. Reading the headlines alone, in order, must make the offer.
17. No em dashes or en dashes in visible copy. Middle dots at most one per line.

**Visual**

18. One action colour (Harbour) carries every primary action. Signal Gold is limited to the focus ring and at most
    two highlights on the whole page.
19. Two type families on a page: Newsreader for display only, Source Sans 3 for everything else. Newsreader is
    never used for forms, prices, conditions or dense content.
20. All text meets WCAG 2.2 AA (4.5:1 normal, 3:1 large). Colour never carries status alone.
21. Banned imagery: shields, hospital crosses, heart-rate lines, smiling-family stock photos, generic AI
    gradients, fake product UI built from boxes.
22. Body text is at least 17px on mobile and 18px on desktop for coverage, consent and price text.
23. Every motion has a one-sentence reason, and all motion is disabled under `prefers-reduced-motion`.

## 8. Acceptance criteria

The brief is accepted when every box below can be honestly ticked.

- [ ] CP1 matrix covers all 11 sites, line by line: words, punctuation, buyer state, principle, transferable rule.
- [ ] CP2 lists everything borrowed from and avoided in the product repo, each with a file reference.
- [ ] Every design decision in CP3 cites a CP1 principle, a brand rule or a user decision.
- [ ] Every visible string in CP4 has a rationale and passes non-negotiables 11 to 17.
- [ ] Every number and quote in CP4 has an evidence ID from section 11.
- [ ] Token contrast pairs are computed and recorded; none fails AA.
- [ ] Landing and onboarding are specified at 1440 and 390, including every form state.
- [ ] A placeholder register lists each missing asset with size, subject and a "do not use" note.
- [ ] The independent review (CP7) reports no open high-severity finding.
- [ ] Claude Design can build from the pack without asking for missing information (checked by a cold-read review).

## 9. Success metrics

**For the design work (checked at CP7)**

| Metric | Target |
|---|---|
| Copy lines failing a copy rule | 0 |
| Unsupported claims (no evidence ID) | 0 |
| Text colour pairs below WCAG AA | 0 |
| Signal Gold uses outside the focus ring | 2 or fewer |
| Distinct CTA intents on the page | 2 (early list, partner pilot) |
| Em or en dashes in visible copy | 0 |
| Taste-skill pre-flight boxes failed without a logged override | 0 |
| Questions Claude Design must ask back after the cold read | 0 blocking |

**For the live page (proposed; to be instrumented by whoever builds it)**

| Event | Measures |
|---|---|
| `early_list_signup_submitted` | Primary conversion: households joining the list |
| `early_list_signup_failed` | Validation and network failure rate |
| `partner_pilot_request_submitted` | Partner interest |
| `faq_item_opened` | Which objections need stronger copy |

There are no targets for these yet. A baseline comes after launch. They follow the event template in `CLAUDE.md`,
are privacy class INTERNAL, and carry no free-text personal data.

## 10. Working style and procedure

**Roles.** One central owner (this session) holds the requirements, decisions, integration and the final call.
Specialist agents may run CP1 (one per site group: consumer, insurance and benefits, wealth and B2B) and CP7
(an independent reviewer with fresh context). Agents never edit the same file. Each returns: work done, files,
decisions, evidence, risks, next dependency.

**Checkpoint loop.** Every checkpoint runs:
`entry check → work → self-check against this file → output file in docs/design/ → commit → status update`.
CP3 and CP4 also stop for user approval before the next checkpoint starts.

| CP | Output file | Entry gate | Exit gate | User approval |
|---|---|---|---|---|
| CP0 | this file | Map built, inputs read | Decisions logged, CERT state set | Done (questions answered) |
| CP1 | `01-reference-teardown.md` | CP0 | All 11 sites at line level; principles extracted | No |
| CP2 | `02-product-audit.md` | CP0 | Borrow/avoid table with file references | No |
| CP3 | `03-design-direction.md` | CP1, CP2 | Tokens, type, grid, motion, dependencies; conflicts logged | **Yes** |
| CP4 | `04-ia-and-copy-deck.md` | CP3 approved | Every string, rationale, evidence ID; headlines-only test passes | **Yes** |
| CP5 | `05-design-system-spec.md` + `tokens.json` | CP4 approved | Components with all states; contrast table | No |
| CP6 | `06-page-specs.md` + `07-claude-design-brief.md` | CP5 | Desktop and mobile specs for landing and onboarding; placeholder register | No |
| CP7 | `08-review.md`, handoff in `README.md` | CP6 | Independent review closed; cold-read test passed | **Yes** (final) |

**Evidence tagging.** Every claim in the docs is tagged as one of: `[report]` (research doc), `[repo:path]`,
`[T#]` (transcript), `[decision D#]` or `[inference]`. Inferences are never presented as facts.

## 11. Evidence register (proof content allowed on the page)

These come from `docs/evidence/coversaath-interview-transcripts.md`. They are user-reported and directional, not
prevalence data, and the page copy must not imply otherwise.

| ID | Fact | Allowed use |
|---|---|---|
| E1 | Eight recorded conversations, 5 to 8 September 2026. Seven are with family members in Kolkata, Bengaluru, Pune, Mumbai and Delhi NCR; one is with a hospital insurance-desk executive. Recruited mostly through friends and family | "Built from conversations with families and a hospital insurance desk". Never "families across India" or any wording that implies a survey |
| E2 | T1: a ₹1,200 room decision led to an ₹80,000 loss | Story card, anonymised |
| E3 | T4: 8L base plus a 10L-deductible top-up left a 2L gap the buyer did not know about; she was about to spend ₹9,400 a year | Story card; the "not this, not now" proof |
| E4 | T4: "it says here, page fourteen" beats "an app told me" | Quote; source-citation promise |
| E5 | T5: seven hours lost between 2 a.m. and 9 a.m. finding a brother's employer cover | Story card; emergency principle only (non-negotiable 3) |
| E6 | T6: a 17-day window after leaving a job, missed; no notification came | Story card; continuity |
| E7 | T7: "Everyone gives me the counterfactual. I want the next step." | Quote; the "Next" promise |
| E8 | T2 (desk employee): families arrive without knowing how much cash to bring | Supporting line |
| E9 | 7 of 19 collected documents had a schedule field that did not match the family's own account | Supporting number with its denominator shown |
| E10 | A sister's date of birth was recorded as 2001 instead of 2007 on a family policy schedule (T3) | Example of a wrong detail on a real schedule; anonymised. Added at CP2 |

## 12. Failure points and controls

| Failure | Early sign | Control |
|---|---|---|
| Copy implies approval or a live service | Words like "covered", "approved", "guaranteed", "24x7" | Non-negotiables 1 to 3; CP7 search for the banned list |
| Fear marketing creeps in | Illness or death imagery, urgency countdowns | Non-negotiable 14; operational-pain rule in section 3 |
| Reference copy is copied rather than learned | A Knowvia line matches a reference line | CP4 transfers principles only; CP7 compares lines with the CP1 corpus |
| Partner block dilutes the household story | Partner content above the fold, or two equal CTAs | Section 3 resolution; one partner block only |
| Accent creep | Gold or Harbour used decoratively | Non-negotiable 18; counted at CP7 |
| Serif in the wrong place | Newsreader in forms or fine print | Non-negotiable 19 |
| Template look | Three equal cards, eyebrows on every section, fake UI boxes | Taste-skill pre-flight at CP5 to CP7 |
| Onboarding looks live before launch | Upload CTA on the landing page | Assumption A1; the CTA goes to the early list |
| Parents excluded by small type | Body under 17px, low-contrast muted text | Non-negotiable 22; Slate only at 5.22:1 or better |
| Scope creep into the product | Matrix, expense planner or emergency screens get redesigned | Decision D3; stop at the first matrix |
| Stale input | A doc marked superseded is quoted | Section 2 authority table |

## 13. Capabilities (CERT matrix)

| Capability | Reason | Install / source | Check | Status |
|---|---|---|---|---|
| repomap (`@sylphx/repomap` via `npx -y`) | Required MAP gate | Not added to the app; run through npx | `map . --json` gave 161 files and 963 call edges; `context src/ui/app.js` and `impact --changed` succeeded | VERIFIED |
| design-taste-frontend skill | Landing-page quality gate named in `CLAUDE.md` | Source read in full, then installed at user scope (`~/.claude/skills/`), not in the repo | Name and frontmatter verified; skill listed as callable. MIT. Prose only, no scripts | VERIFIED (advisory) |
| Claude Docs connector | Read the research report | Session connector | Full document read (34k characters of text) | VERIFIED |
| Figma connector | Not used (D7) | n/a | Account seen: Starter plan, View seat, 20 read calls a month | NOT_APPLICABLE |
| Newsreader, Source Sans 3, Noto Sans Devanagari | Brand type | Google Fonts, SIL OFL | Licence confirmed in the repo's brand review | REQUIRED (spec only) |
| Phosphor Icons | Icon set | MIT, npm or CDN at build time | To be confirmed at CP3 | REQUIRED (spec only) |
| Animation library | Not needed at MOTION_INTENSITY 3 | CSS transitions plus IntersectionObserver | n/a | NOT_APPLICABLE |
| Application packages | No code is written here | n/a | n/a | NOT_APPLICABLE |

`CLAUDE.md` refers to `docs/CERT.md` and `docs/agent-tooling.md`, but neither file exists in the repo. This
intake follows the procedure written inline in `CLAUDE.md` instead.

The installed skill lives in an ephemeral container. To reinstall: clone `Leonxlnx/taste-skill` at `d237dd3` and
copy `skills/taste-skill/SKILL.md` to `~/.claude/skills/design-taste-frontend/`. To remove it, delete that folder.

## 14. Risks and open questions

| Item | Owner | Default if unanswered |
|---|---|---|
| Consent re-check for quoting T1, T4, T5, T6, T7 in public | Product team | Quotes stay in the design marked "consent re-check before launch" |
| Legal text for footer, disclaimer, privacy and early-list consent | Legal review | Designed slots with "legal review required" |
| Name clearance for Knowvia (trademark, domain) | Founders | Design proceeds; the name is a token that can be swapped |
| Hindi version | Product team | A2: English only, Devanagari-ready |
| Real photography or illustration | Design | Placeholders with written briefs |
| Landing-page repo name | User | Stays in `docs/design/` here (D8) |

## 15. Rollback

Everything here is documentation in `docs/design/`, `docs/iterations/` and `docs/exec-plans/`. Reverting the
commits removes it completely. No application code, dependency or configuration changes.
