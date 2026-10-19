# CP2 Product audit: what to borrow and what to leave behind

Status: done, 13 October 2026. Inputs: `src/ui/styles.css`, `src/ui/app.js`, `src/ui/components/household-workspace.js`,
`README.md`, `docs/strategy/round2-answers.md`, `working/working.md`, `building/insurance.md`,
`research/01-product.md` section 9, `research/04-market-and-sources.md`, `docs/evidence/coversaath-interview-transcripts.md`,
`docs/assets/knowvia-*`.

**Verdict.** The repo gives the landing page its strongest material: a real brand system, a signature idea (Known,
Unknown, Next) and real customer stories. What the landing page must leave behind is the prototype's language. Internal
terms, all-caps prototype banners, monospace tags and the red emergency banner all belong to a test build, not to
a household's first impression.

## 1. What the product is, in words the landing page can use

Knowvia reads a household's health-insurance documents, person by person, and shows what each policy confirms, what is
still uncertain, and the next step. It works across employer cover, personal policies and parents' policies. It does
not sell a policy by default, promise claim approval, or replace the insurer, TPA or hospital desk. [repo:README.md],
[repo:docs/strategy/round2-answers.md]

It is pre-launch. The shipped build runs synthetic data only and states that real document upload is disabled.
[repo:src/ui/app.js `policyBreakdownPanel`, README "Do not put real policy or medical documents into this build"]

## 2. Borrow

| # | What | Source | How the landing and onboarding use it |
|---|---|---|---|
| B1 | Brand palette: Deep Tide `#163F42`, Harbour `#176F69`, Signal Gold `#E0A02B`, Mist `#F3F7F6`, Paper `#FFFFFF`, Ink `#1A3034`, Slate `#5C7074`, Fog `#CFDCDA`, Brick `#A74335`, with verified contrast pairs | `research/01-product.md` §9 Colour system | Base tokens, unchanged. Extended at CP3 only where a role is missing |
| B2 | Type: Source Sans 3 (UI and body), Newsreader (large editorial headlines only), Noto Sans Devanagari (Hindi) | §9 Typography; `04-market-and-sources.md` typography review | Exactly this pairing. Newsreader never touches forms, prices or conditions |
| B3 | Reading sizes: 17px mobile and 18 to 19px desktop for coverage, consent and price text; 14px only for metadata | §9 Typography | Minimum body sizes in the type scale |
| B4 | Signature: the decision line Known, Unknown, Next | §9 Visual signature; README "`Known / Unknown / Next`" | The page's one memorable device: the hero component and the how-it-works structure. Set in sentence case, not all caps (see A4) |
| B5 | Product line: "Know what you have. Know what could go wrong. Know what to do next." | README; round2 §7 | Basis for the three-part how-it-works copy |
| B6 | Lockup: "Knowvia. Know your cover. Before you need it." | `docs/assets/knowvia-brand-note.md`; `knowvia-wordmark.svg` | Hero headline and brand lockup |
| B7 | The K route mark: vertical line, branch, gold destination marker | `knowvia-brand-note.md`; `knowvia-linkedin-logo.svg` | Logo; its route geometry inspires the hero's single motion moment (CP3) |
| B8 | Evidence states: Proven, Calculated, Reported, Dynamic, Unknown, Conflicting | `household-workspace.js` `EVIDENCE_STATES`; round2 §3 | The landing page compresses them to Known and Unknown. Onboarding's first matrix uses all six with plain labels |
| B9 | Household matrix as the first screen: Person, Policies found, Immediate issue, Evidence status, Next action | round2 §6; `app.js` `matrixPanel` | The end state of onboarding, and the hero component's content model |
| B10 | Decision first, proof on demand: Decision, Financial, Evidence, Research | `working/working.md` "concise answer first"; round2 §6 | A landing-page promise ("the answer first, the page number when you ask") and the matrix row's expand behaviour |
| B11 | Permission model: three classes (Cover, Operational, Protected), per member, per viewer, with an advance emergency override | `building/insurance.md` §C | The household-control section and the onboarding permission step |
| B12 | "Admit first. Optimise later." | `app.js` `emergencyBanner`; round2 §6 | One honest FAQ answer about emergencies. Never a promise of a live line |
| B13 | Focus: 3px Signal Gold outline, 3px offset | `styles.css` `:focus-visible` | The focus style, unchanged |
| B14 | Radii: cards 16px, controls 10px | `styles.css` `--radius-card`, `--radius-control` | Onboarding forms and cards. The landing page's primary CTA becomes a pill (CP3) |
| B15 | Tinted shadow `0 18px 50px rgba(22,62,54,.09)` | `styles.css` `--shadow` | Used on at most one floating element per screen (the hero component) |
| B16 | Dark-mode token set and `prefers-reduced-motion` handling | `styles.css` | Dark tokens carried forward. Every motion has a reduced-motion fallback |
| B17 | Loading line (moving gradient bar, stops under reduced motion) | `styles.css` `.loading-line` | Concept for the onboarding "reading your policy" state |
| B18 | Customer evidence and quotes | transcripts; register E1 to E10 below | Proof sections, under the consent rules in requirements §7 |
| B19 | Banner headline: "Insurance should feel clear before it becomes urgent." | `docs/assets/linkedin-company-banner-brandkit.png`; §9 | A candidate line for the closing section (CP4 decides) |

## 3. Avoid

| # | What | Where it appears | Why it stays out |
|---|---|---|---|
| A1 | Prototype banner: "LOCAL PERSISTENT PROTOTYPE. Synthetic fixture analysis only..." | `app.js` `render` | All caps, internal, alarming. Pre-launch status is said once, plainly, near the CTA |
| A2 | Internal vocabulary: deterministic, fixture, release gate, route, case, worker, orchestration, A-J breakdown, Household Health Treasury, bounded specialist, agent contract | `app.js`, README | The buyer does not think in these words. See the vocabulary map in §5 |
| A3 | Monospace tags and letters (`.tag`, `.breakdown-letter`, `.mono`) | `styles.css` | A monospace face for small labels is a known template tell (frontend-design skill). Status chips use Source Sans 3 at 600 |
| A4 | All-caps eyebrow on every section (`.section-label`) | `app.js` throughout | Eyebrows are rationed (taste skill: at most ceil(sections / 3)). Sentence case only |
| A5 | Red emergency banner at the top of the page | `app.js` `emergencyBanner` | Leads with fear, and the staffed line does not exist (round2 §6). Emergencies are handled in the FAQ |
| A6 | Drifted product tokens: `#0f6a5a`, `#094d42`, `#123d35`, `#eef4f2` and the Avenir Next stack | `styles.css` `:root` | They differ from the approved brand spec (B1, B2). The landing page uses the spec; the drift is logged for the product team |
| A7 | Six evidence-state colours (teal, blue, purple, olive, amber, red) shown at once | `styles.css` `.tag.*` | Too many hues for a landing page. Known and Unknown are carried by label and icon first, colour second |
| A8 | Feature claims for rails that are not built: Gnani voice, WhatsApp companion, Pine Labs payments, Delhivery, Sarvam OCR, HRMS sync | round2 §4; `working/working.md` | Proposed, not live. None appears as a feature. Requirements non-negotiable 5 |
| A9 | Statements that a person reviews every answer | `research/01-product.md` (superseded) | The licensed-adviser gate is a design assumption, not an operating fact |
| A10 | The old descriptor "Know what you have. Buy what you need. Plan what it costs." | `research/01-product.md` | Superseded. It also leads with buying, which the evidence says to avoid (T4) |
| A11 | Long hedged paragraphs (production-readiness footers) | `app.js` footer | Honesty is kept but said in one short sentence where it matters |

## 4. Brand-line hierarchy (resolves three competing descriptors)

| Line | Role on the page |
|---|---|
| Know your cover. Before you need it. | Hero headline and lockup (7 words, the approved tagline) |
| Understand your insurance before you need it. | Meta description and social card only (README descriptor) |
| Know what you have. Know what could go wrong. Know what to do next. | Structure for the three-part how-it-works section (product line) |

## 5. Vocabulary map: product term to customer word

| Product term | Landing and onboarding wording |
|---|---|
| Household matrix | Your family's cover, person by person |
| Proven / Calculated | Known, with the page it comes from |
| Unknown / Conflicting | Not confirmed yet / Two documents disagree |
| Dynamic | Needs a fresh answer from the insurer or hospital |
| Reported | Someone told us; not checked yet |
| Next action | Next step |
| Case, route, run | (not used) |
| Source pack | Your policy documents |
| Principal, viewer, grant | You, people you share with, what they can see |
| Cover / Operational / Protected classes | Cover amount / Policy details / Medical details |
| Emergency override | Emergency access you set in advance |
| Sum insured, room-rent cap, deductible, co-pay, TPA, cashless, portability | Kept, because Indian buyers meet these words on their documents. Each gets a plain definition on first use |

## 6. Evidence register additions

The requirements file (section 11) lists E1 to E9. This audit adds:

| ID | Fact | Source | Allowed use |
|---|---|---|---|
| E10 | A sister's date of birth was recorded as 2001 instead of 2007 on a family policy schedule | T3 researcher note (transcript lines 508, 535) | Example of a "Known, but wrong" detail on the page; anonymised, no names |

Mrs. Ghosh (T8) asked that her session's contents not reach her son. E10 comes from her husband's policy (T3) and
is a document fact, not her words. It is still used only anonymised. Her quotes remain excluded (non-negotiable 8).

## 7. Customer language bank (tone reference, not for publication)

These phrases show how the buyers actually talk. They tune the copy's voice. They are not to be quoted unless they
are already in the evidence register.

- "when there's no problem you don't remember it" (T1): calm-month inertia; the page must earn attention without fear.
- "it says here, page fourteen" (T4): citations win family arguments.
- "Everyone gives me the counterfactual. I want the next step." (T7): every section ends on an action.
- "nothing happens, that's the thing" (T6): silent failures; continuity must already be there.
- "I will not open an app" (T5): in a crisis the product cannot be the interface; preparation is.

## 8. Implications for onboarding (future state, assumption A1)

The order follows round2 §3 (Case open, then Evidence intake) and `building/insurance.md` §C:

1. Create account (email or phone, with no password-strength theatre).
2. Say what is coming up: renewal, planned treatment, job change, parents' cover, or just getting organised (the "event").
3. Add people: you first, then family members, each a row.
4. Set what each person shares: Cover amount, Policy details, Medical details, per viewer. Defaults are private;
   medical details are never shared by default. Optional emergency access set in advance.
5. Add a policy: upload a PDF or photo, with WhatsApp forwarding shown as "coming later" only if the team confirms.
6. Reading: progress shown honestly. It names what was found and what is missing; no fake percentage.
7. First matrix: one row per person with Known, Unknown and Next, and the page reference behind each Known.

Each step needs empty, error and partial states. The product's own fail-closed rule applies: a field that cannot be
read is shown as Not confirmed yet, never guessed.

## 9. Drift and repo issues found (reported, not fixed)

- Product UI tokens and font stack differ from the approved brand spec (A6).
- `AGENTS.md` and `CLAUDE.md` are now the same generic agent contract, so `research/01-product.md`'s pointer
  ("Read AGENTS.md for the current position") no longer leads to product truth.
- `CLAUDE.md` references `docs/CERT.md` and `docs/agent-tooling.md`, which do not exist.
