# CP6 Claude Design brief

This is the brief for continuing the Knowvia design in Claude Design. The first version of the canvas has already been
built from this brief: **[Knowvia landing and onboarding](https://claude.ai/artifact/Ghw2c9rV2yhCDoekLTFFpS)**. Use the
prompt below to iterate on it, or to hand it to a designer who will.

## Prompt

> You are refining the Knowvia landing page and onboarding on this canvas. Knowvia helps Indian households understand
> their health insurance before they need it. It reads a family's policies person by person and shows what is Known
> (with the page it comes from), what is Not confirmed, and the Next step. It is pre-launch; the only primary action is
> "Join the early list".
>
> Keep these fixed: the copy in `docs/design/04-ia-and-copy-deck.md` (change words only with a reason), the tokens in
> `docs/design/tokens.json`, the type pairing (Newsreader 400 for display, Source Sans 3 for everything read or filled
> in), Harbour `#176F69` as the only action colour, Signal Gold `#E0A02B` only for focus and the Next marker, sentence case
> everywhere, no em dashes, and one orchestrated motion moment (the reading card in the hero).
>
> Never add: stats, ratings, logos, partner names, testimonials beyond the evidence register, regulator marks, claims of
> claim approval or a live emergency line, scroll reveals, carousels, uppercase eyebrows, a trailing arrow on buttons, or
> three equal cards.
>
> Explore within the system: alternative hero compositions (reading card left or right, overlapping or contained), the
> balance of Mist and Paper sections, the stories grid, and the permission panel's interaction.

## What a designer should check before calling it done

- Read the headlines alone, in order. They must still make the offer.
- Count the Harbour uses: actions only. Count the gold uses: focus, the Next marker, and at most two highlights.
- Every number has a source line directly under it.
- Every text pair passes 4.5:1, using the contrast values in `tokens.json`.
- The mobile page has no horizontal scroll at 320 wide, and the CTA never wraps.
- Run the taste-skill pre-flight and the frontend-design self-critique. Log any deliberate override.
