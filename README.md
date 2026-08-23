# Embolden – Reading Focus

Embolden is a Chrome extension that **bolds the first portion of each word** on
a page, giving your eyes fixation anchors that make reading easier — built
particularly with ADHD and other attention differences in mind.

Instead of your gaze wandering mid-line, the bolded prefixes give it a steady
place to land, and your brain autocompletes the rest of the word. Many people
find long articles noticeably easier to get through this way.

## Features

- **Works everywhere** — articles, docs, forums, and dynamic pages (infinite
  scroll and single-page apps are re-processed as content arrives).
- **Tune it to your eyes** — three dials, all with a live preview in the
  popup:
  - **Anchor** (10–90%) — how much of each word gets bolded.
  - **Ink** (Light → Black) — how heavy the bolded part looks.
  - **Variation** (Off → Wild) — nudges the anchor length up or down per
    word, so a page of identical 45% prefixes doesn't settle into a pattern
    your eye starts skimming.
- **Per-site toggle** — turn Embolden off for any site from the popup or with
  **Alt+B**; the choice sticks and syncs via your Chrome profile.
- **Careful about what it touches** — code blocks, text boxes, editors
  (Gmail compose etc.), icon fonts, and CJK/Thai text are left alone. The
  page's actual text is never altered, so copy/paste, find-in-page, and
  screen readers keep working. Site owners can opt an element out with a
  `data-embolden-skip` attribute.

## Privacy

**Embolden reads nothing and sends nothing.** No analytics, no network
requests, no remote code. The only stored data is your own settings (on/off,
anchor, ink, variation, and your disabled-sites list) in
`chrome.storage.sync`. The broad site access warning at install time is just
what any page-restyling extension requires — nothing about the pages you
visit is collected or transmitted.

## Install (unpacked, for development)

1. Clone this repository.
2. Open `chrome://extensions`, enable **Developer mode**.
3. Click **Load unpacked** and select the repository folder.

## Usage

- Click the toolbar icon for the master switch, per-site switch, and the
  three appearance dials. **Reset** in the footer restores the dials to
  their defaults and leaves your per-site choices alone.
- Press **Alt+B** to toggle Embolden on the current site.

## Known limitations

- **Google Docs** and other canvas-rendered apps can't be processed from a
  content script (there is no text in the DOM).
- **Chrome's PDF viewer** and `chrome://` pages don't allow extensions.
- Some **ligature icon fonts** that dodge our icon heuristic may render as
  broken glyph text — use the per-site toggle as the escape hatch.
- **Ink** can only use weights the page's font actually ships. A site with
  nothing but Regular and Bold will render Light/Semi the same as Regular
  and Extra/Black the same as Bold; variable fonts show all five. Inside
  text that is already heavy (headings, `<strong>`) the anchor never drops
  below the surrounding weight, so it can't read as the *lighter* part of
  the word.
- **Variation** is deterministic, not random: a word's anchor length is
  derived from the word itself, so identical words match and nothing
  reshuffles when a page re-renders.
- Frameworks that re-render aggressively may briefly flash unbolded text
  while Embolden reapplies; if a site misbehaves, disable Embolden there.
- Apps that update a text node in place while keeping a reference to it
  (some React/Vue patterns, e.g. a live counter) may show stale text for
  that node, because splitting a text node for bolding detaches the
  original. Full re-renders recover automatically; the per-site toggle is
  the escape hatch for pages built entirely around such updates.

## Development

Zero-build vanilla JavaScript — no bundler, no dependencies, no TypeScript.
Pure logic lives in `src/core.js` and is tested with Node's built-in runner:

```sh
node --test
```

Packaging a store-ready zip (written to `dist/`):

```sh
scripts/package.sh
```

Icons are generated (not hand-drawn) — regenerate with:

```sh
node scripts/make-icons.mjs
```

## Repository layout

```
manifest.json        MV3 manifest
src/core.js          pure functions: segmentation, bold lengths, settings
src/content.js       DOM pipeline: walk, wrap, revert, MutationObserver
src/content.css      weight rules for <emb-b> wrappers
src/background.js    service worker: install defaults, Alt+B command
popup/               toolbar popup (toggles, the three dials, live preview)
tests/               node:test suite for core.js
scripts/             packaging + icon generation
docs/                Chrome Web Store listing draft
```
