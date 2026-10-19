# Knowvia design import (Figma plugin)

This plugin draws every Knowvia board from the Claude Design canvas onto one Figma page, exactly as designed:

- the landing page, desktop 1440 and mobile 390;
- every landing state: six hero form states, six closing form states, both permission views, and the mobile menu;
- onboarding O1 to O7 (future state) and the extra states board;
- the design system: Foundations, Components and Motion.

It also creates the `Knowvia tokens` colour, spacing and radius variables, the text styles and the shadow and focus effect styles, and links matching colours to those variables.

## Run it (about two minutes)

1. Use the **Figma desktop app**. Development plugins do not run in the browser.
2. Open a design file. A new, empty file is best.
3. Go to Menu › Plugins › Development › **Import plugin from manifest…** and pick `manifest.json` from this folder.
4. Go to Menu › Plugins › Development › **Knowvia design import**. Wait until the message "Knowvia: … layers built" appears.
5. To get a .fig file, use File › **Save local copy…**.

The plugin works on the page that is open, so it fits within the Starter plan's 3-page limit. It needs no network access: all images are inside `code.js`.

## How it was made

`tools/` holds the pipeline:

1. `extract.mjs` with `inpage.js` renders each `.dc.html` artboard in Chromium, expands its template, lets every animation reach its resting state, and records each box, text run, colour, font, border, shadow, gradient, icon and image. It also saves raster crops for the few patterned backgrounds.
2. `gen_plugin.py` packs those trees and images into `code.js`.
3. `builder.js` is the Figma-side builder.

Text keeps the design's exact line breaks so that wrapping cannot drift. The Claude Design source in `../claude-design/` stays the source of truth.

To regenerate after a design change, run `node extract.mjs jobs.json <project dir> <blobs dir> <out dir>`, then `python3 gen_plugin.py`.
