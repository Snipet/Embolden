"use strict";

// Embolden core — pure functions only. No DOM, no chrome.* APIs.
// Loaded as a classic script by the content script and popup (via
// globalThis.EmboldenCore), by the service worker (importScripts), and by
// Node's test runner (module.exports).

const STRENGTH_RATIOS = Object.freeze({
  low: 0.3,
  medium: 0.45,
  high: 0.6,
});

const DEFAULT_SETTINGS = Object.freeze({
  v: 1,
  enabled: true,
  strength: "medium",
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

function ratioForStrength(strength) {
  return STRENGTH_RATIOS[strength] !== undefined
    ? STRENGTH_RATIOS[strength]
    : STRENGTH_RATIOS.medium;
}

// Number of grapheme clusters to bold for a word of n clusters.
// Always >= 1 bold; always >= 1 unbolded for n >= 2.
function boldLength(n, ratio) {
  if (n <= 0) return 0;
  if (n === 1) return 1;
  return Math.min(n - 1, Math.max(1, Math.round(n * ratio)));
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

// processText("reading helps", 0.45) →
//   [{bold:"rea"},{plain:"ding "},{bold:"hel"},{plain:"ps"}]
// Concatenating all parts always reproduces the input exactly.
// Adjacent same-type runs are merged so callers create fewer nodes.
function processText(text, ratio, locale) {
  if (!text) return [];
  const { word, grapheme } = getSegmenters(locale);
  const parts = [];
  for (const seg of word.segment(text)) {
    const s = seg.segment;
    if (seg.isWordLike && isBoldableWord(s)) {
      const clusters = [];
      for (const g of grapheme.segment(s)) clusters.push(g.segment);
      const b = boldLength(clusters.length, ratio);
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
  return {
    v: 1,
    enabled: typeof s.enabled === "boolean" ? s.enabled : DEFAULT_SETTINGS.enabled,
    strength:
      STRENGTH_RATIOS[s.strength] !== undefined ? s.strength : DEFAULT_SETTINGS.strength,
    disabledSites: Array.isArray(s.disabledSites)
      ? s.disabledSites.filter((h) => typeof h === "string" && h.length > 0)
      : [],
  };
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
  DEFAULT_SETTINGS,
  ratioForStrength,
  boldLength,
  segmentWords,
  processText,
  normalizeSettings,
  hostnameFromUrl,
};

if (typeof module !== "undefined") module.exports = EmboldenCore;
else globalThis.EmboldenCore = EmboldenCore;
