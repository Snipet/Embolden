"use strict";

// Embolden core — pure functions only. No DOM, no chrome.* APIs.
// Loaded as a classic script by the content script and popup (via
// globalThis.EmboldenCore), by the service worker (importScripts), and by
// Node's test runner (module.exports).

// Settings schema v1 shipped three named strengths. They now only exist as
// migration targets: v2 stores `coverage` as a percentage so the slider can
// land anywhere between them.
const STRENGTH_RATIOS = Object.freeze({
  low: 0.3,
  medium: 0.45,
  high: 0.6,
});

// Every numeric setting is described by one range: the popup builds its
// controls from these, and normalizeSettings snaps stored values onto the
// same grid, so a hand-edited or future-version value can never produce a
// slider position that doesn't exist.
const LIMITS = Object.freeze({
  // Share of each word that gets bolded, in percent.
  coverage: Object.freeze({ min: 10, max: 90, step: 5, default: 45 }),
  // font-weight applied to the bolded prefix. Starts at 500: 400 would mean
  // "no bolding at all", which reads as a broken extension.
  weight: Object.freeze({ min: 500, max: 900, step: 100, default: 700 }),
  // Max ± variation, in grapheme clusters, applied per word.
  jitter: Object.freeze({ min: 0, max: 3, step: 1, default: 0 }),
});

const DEFAULT_SETTINGS = Object.freeze({
  v: 2,
  enabled: true,
  coverage: LIMITS.coverage.default,
  weight: LIMITS.weight.default,
  jitter: LIMITS.jitter.default,
  disabledSites: Object.freeze([]),
});

const HAS_LETTER_RE = /\p{L}/u;

// Scripts where prefix-bolding is meaningless or harmful: no per-word
// boundaries (CJK, Thai) or syllable blocks that shouldn't be split visually.
const SKIP_SCRIPT_RE =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u;

// Intl.Segmenter construction is expensive; cache per locale.
const segmenterCache = new Map();

function defaultLocale() {
  if (typeof navigator !== "undefined" && navigator.language) {
    return navigator.language;
  }
  return "en";
}

function getSegmenters(locale) {
  const requested = locale || defaultLocale();
  let entry = segmenterCache.get(requested);
  if (!entry) {
    try {
      entry = {
        word: new Intl.Segmenter(requested, { granularity: "word" }),
        grapheme: new Intl.Segmenter(requested, { granularity: "grapheme" }),
      };
    } catch {
      entry = {
        word: new Intl.Segmenter("en", { granularity: "word" }),
        grapheme: new Intl.Segmenter("en", { granularity: "grapheme" }),
      };
    }
    segmenterCache.set(requested, entry);
  }
  return entry;
}

// Own-property check, not a plain lookup: stored strength could be any
// string, and inherited keys like "toString" must not pass validation.
function isValidStrength(strength) {
  return (
    typeof strength === "string" &&
    Object.prototype.hasOwnProperty.call(STRENGTH_RATIOS, strength)
  );
}

// Snap a value onto a range's step grid, or null if it isn't a usable number.
// Callers decide the fallback, which keeps migration logic out of here.
function quantize(value, range) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const steps = Math.round((value - range.min) / range.step);
  const snapped = range.min + steps * range.step;
  return Math.min(range.max, Math.max(range.min, snapped));
}

function quantizeOr(value, range) {
  const snapped = quantize(value, range);
  return snapped === null ? range.default : snapped;
}

// FNV-1a over UTF-16 code units. The point is determinism, not crypto: the
// same word must get the same jitter every time, so a word keeps its shape
// when a subtree is reprocessed after a page mutation. Anything seeded by
// position or Math.random would make text visibly twitch on re-render.
function hashWord(word) {
  let h = 0x811c9dc5;
  for (let i = 0; i < word.length; i++) {
    h ^= word.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Per-word bold-length offset in [-jitter, +jitter]. Identical words share an
// offset (that's the price of stability); across a sentence the lengths still
// read as irregular, which is the point — a perfectly uniform 45% prefix can
// itself become a pattern the eye starts to skim.
function jitterOffset(word, jitter) {
  if (!jitter || jitter <= 0 || !word) return 0;
  const span = 2 * jitter + 1;
  return (hashWord(word) % span) - jitter;
}

// Number of grapheme clusters to bold for a word of n clusters.
// Always >= 1 bold; always >= 1 unbolded for n >= 2 — the offset is applied
// before that clamp, so jitter can never bold a whole word or none of it.
function boldLength(n, ratio, offset) {
  if (n <= 0) return 0;
  if (n === 1) return 1;
  const base = Math.round(n * ratio) + (offset || 0);
  return Math.min(n - 1, Math.max(1, base));
}

function isBoldableWord(segment) {
  return HAS_LETTER_RE.test(segment) && !SKIP_SCRIPT_RE.test(segment);
}

// Diagnostic/test helper: how the text splits into segments, and which
// segments would be prefix-bolded.
function segmentWords(text, locale) {
  const out = [];
  if (!text) return out;
  const { word } = getSegmenters(locale);
  for (const seg of word.segment(text)) {
    out.push({
      text: seg.segment,
      isWord: Boolean(seg.isWordLike) && isBoldableWord(seg.segment),
    });
  }
  return out;
}

function pushPart(parts, key, text) {
  if (!text) return;
  const last = parts[parts.length - 1];
  if (last !== undefined && last[key] !== undefined) {
    last[key] += text;
    return;
  }
  parts.push({ [key]: text });
}

// The two knobs processText actually needs, derived from settings. Weight is
// deliberately absent: it's applied in CSS, so changing it never re-walks the
// DOM. Accepts a partial/garbage object and fills in defaults.
function renderOptions(settings) {
  const s = settings !== null && typeof settings === "object" ? settings : {};
  return {
    ratio: quantizeOr(s.coverage, LIMITS.coverage) / 100,
    jitter: quantizeOr(s.jitter, LIMITS.jitter),
  };
}

function normalizeRenderOptions(options) {
  const o = options !== null && typeof options === "object" ? options : {};
  const ratio =
    typeof o.ratio === "number" && Number.isFinite(o.ratio) && o.ratio > 0
      ? o.ratio
      : LIMITS.coverage.default / 100;
  return { ratio, jitter: quantizeOr(o.jitter, LIMITS.jitter) };
}

// processText("reading helps", {ratio: 0.45}) →
//   [{bold:"rea"},{plain:"ding "},{bold:"he"},{plain:"lps"}]
//   ("helps" is 5 clusters; round(5 × 0.45) = 2 bold)
// Concatenating all parts always reproduces the input exactly.
// Adjacent same-type runs are merged so callers create fewer nodes.
function processText(text, options, locale) {
  if (!text) return [];
  const { ratio, jitter } = normalizeRenderOptions(options);
  const { word, grapheme } = getSegmenters(locale);
  const parts = [];
  for (const seg of word.segment(text)) {
    const s = seg.segment;
    if (seg.isWordLike && isBoldableWord(s)) {
      const clusters = [];
      for (const g of grapheme.segment(s)) clusters.push(g.segment);
      const b = boldLength(clusters.length, ratio, jitterOffset(s, jitter));
      pushPart(parts, "bold", clusters.slice(0, b).join(""));
      pushPart(parts, "plain", clusters.slice(b).join(""));
    } else {
      pushPart(parts, "plain", s);
    }
  }
  return parts;
}

// Settings live in chrome.storage.sync under the single key "settings".
// Every reader runs raw values through this so a missing key, a partial
// object, or a bad value from a future/past version degrades to defaults.
function normalizeSettings(raw) {
  const s = raw !== null && typeof raw === "object" ? raw : {};
  let coverage = quantize(s.coverage, LIMITS.coverage);
  if (coverage === null) {
    // v1 → v2: the old three-way `strength` becomes a point on the slider.
    coverage = isValidStrength(s.strength)
      ? Math.round(STRENGTH_RATIOS[s.strength] * 100)
      : LIMITS.coverage.default;
  }
  return {
    v: 2,
    enabled: typeof s.enabled === "boolean" ? s.enabled : DEFAULT_SETTINGS.enabled,
    coverage,
    weight: quantizeOr(s.weight, LIMITS.weight),
    jitter: quantizeOr(s.jitter, LIMITS.jitter),
    disabledSites: Array.isArray(s.disabledSites)
      ? s.disabledSites.filter((h) => typeof h === "string" && h.length > 0)
      : [],
  };
}

// True when two normalized settings objects would render identically. Used to
// ignore the storage.onChanged echo of our own write (which would otherwise
// snap a slider back under the user's thumb mid-drag).
function sameSettings(a, b) {
  if (!a || !b) return false;
  return (
    a.enabled === b.enabled &&
    a.coverage === b.coverage &&
    a.weight === b.weight &&
    a.jitter === b.jitter &&
    a.disabledSites.length === b.disabledSites.length &&
    a.disabledSites.every((h, i) => h === b.disabledSites[i])
  );
}

// Hostname for per-site state. Only http(s) pages participate; everything
// else (chrome://, file://, about:, data:, the Web Store) returns null.
function hostnameFromUrl(url) {
  if (typeof url !== "string" || url.length === 0) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed.hostname || null;
}

const EmboldenCore = {
  STRENGTH_RATIOS,
  LIMITS,
  DEFAULT_SETTINGS,
  quantize,
  hashWord,
  jitterOffset,
  boldLength,
  segmentWords,
  renderOptions,
  processText,
  normalizeSettings,
  sameSettings,
  hostnameFromUrl,
};

if (typeof module !== "undefined") module.exports = EmboldenCore;
else globalThis.EmboldenCore = EmboldenCore;
