# Latest iteration: Knowvia landing and onboarding design, CP0 to CP7

Updated 13 October 2026.

**Objective.** Design the Knowvia landing page and onboarding in Claude Design, backed by an evidence-traced brief, before
any implementation.

**Classification.** S1, documentation and design only. No product code changed.

**Built.**
- Claude Design canvas "Knowvia landing and onboarding" (https://claude.ai/artifact/Ghw2c9rV2yhCDoekLTFFpS, private until
  shared). 14 artboards: landing desktop and mobile (interactive form states, FAQ, permission toggle, mobile menu, hero
  reading sequence), onboarding O1 to O7, an Extra states board, and Foundations, Components and Motion boards.
  Source mirrored in docs/design/claude-design/.
- docs/design/00 to 08, cp1/ (eleven-site teardown in four group files), tokens.json.

**Tools and agents.** repomap (MAP gate), design-taste-frontend and frontend-design skills (reviewed, installed at user
scope), Playwright capture script for the eleven sites, four parallel research agents for CP1, one independent review
agent for CP7.

**Verification.** Every evidence number checked against the transcripts. Token contrast computed with the WCAG formula.
All artboards pass format checks (JSON, holes, tag balance, no dashes). The independent review found 7 High, 16 Medium
and 18 Low; every High is fixed in the design, and the resolution table is in 08-review.md.

**Open.** Public re-consent for quotes and stories; sign-off on the generic permission example; a legal decision on the
optional "Planned treatment" field and all [LEGAL REVIEW] text; a rendered check of the hero headline break and the
`aria-disabled` behaviour; name clearance; real photography (placeholders P1 to P6).

**Landing rounds 2 and 3 (versions 22 to 24).** Iterated on user feedback; see docs/design/09-landing-v2.md. Round 3:
horizontal, user-scrollable industry statistics with auto-advance, a continuous clause band, a complete FAQ, typographic
source marks instead of government emblems (State Emblem Act), a pop-out "With Knowvia" card, and the partners email removed.
Round 4 (version 25): official source logos (Ministry of Finance, Lok Sabha, IRDAI, Ministry of Health, LocalCircles)
on each industry number, flagged [LEGAL REVIEW] under the State Emblem Act.
Figma export: docs/design/figma-plugin/ (and knowvia-figma-plugin.zip) is a development plugin that rebuilds every board,
state, token, text style and effect style on one Figma page. The Figma MCP Starter-plan call limit was reached mid-build, so the
boards are built by the user running the plugin in Figma desktop; File > Save local copy then gives the .fig.

**Round 6.** Section alignment fixed on one content edge, source plates restyled without white boxes, favicon added, research claim updated to 50+ conversations across Tier 1, 2 and 3 cities, and bracketed review notes moved off the page into docs/design/09-landing-v2.md. Changes are in docs/design/claude-design/ only; the canvas, HTML pack and Figma plugin are not yet resynced.

**Next action.** The user reviews the canvas and comments on it; then implementation planning in the landing-page repo.
