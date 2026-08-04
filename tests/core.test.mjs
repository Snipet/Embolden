import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const core = require("../src/core.js");

const {
  STRENGTH_RATIOS,
  DEFAULT_SETTINGS,
  ratioForStrength,
  boldLength,
  segmentWords,
  processText,
  normalizeSettings,
  hostnameFromUrl,
} = core;

// All segmentation tests pin the locale so they don't depend on the
// environment's default locale.
const LOCALE = "en";
const MEDIUM = STRENGTH_RATIOS.medium;

function joined(parts) {
  return parts.map((p) => (p.bold !== undefined ? p.bold : p.plain)).join("");
}

function boldParts(parts) {
  return parts.filter((p) => p.bold !== undefined).map((p) => p.bold);
}

test("strength presets map to the fixed ratios", () => {
  assert.equal(ratioForStrength("low"), 0.3);
  assert.equal(ratioForStrength("medium"), 0.45);
  assert.equal(ratioForStrength("high"), 0.6);
});

test("unknown strength falls back to medium", () => {
  assert.equal(ratioForStrength("bogus"), 0.45);
  assert.equal(ratioForStrength(undefined), 0.45);
  assert.equal(ratioForStrength(null), 0.45);
});

test("inherited object keys are not valid strengths", () => {
  // A corrupt/synced strength like "toString" must not resolve through the
  // prototype chain into a non-number ratio (which would NaN every word).
  for (const key of ["toString", "constructor", "valueOf", "hasOwnProperty"]) {
    assert.equal(ratioForStrength(key), 0.45, key);
    assert.equal(normalizeSettings({ strength: key }).strength, "medium", key);
  }
  assert.equal(normalizeSettings({ strength: "__proto__" }).strength, "medium");
});

test("boldLength at medium matches the spec examples", () => {
  // "a"→1, "the"→1, "word"→2, "reading"→3, "attention"→4
  assert.equal(boldLength(1, MEDIUM), 1);
  assert.equal(boldLength(3, MEDIUM), 1);
  assert.equal(boldLength(4, MEDIUM), 2);
  assert.equal(boldLength(7, MEDIUM), 3);
  assert.equal(boldLength(9, MEDIUM), 4);
});

test("boldLength table at low and high", () => {
  assert.equal(boldLength(4, STRENGTH_RATIOS.low), 1);
  assert.equal(boldLength(7, STRENGTH_RATIOS.low), 2);
  assert.equal(boldLength(10, STRENGTH_RATIOS.low), 3);
  assert.equal(boldLength(2, STRENGTH_RATIOS.high), 1);
  assert.equal(boldLength(3, STRENGTH_RATIOS.high), 2);
  assert.equal(boldLength(4, STRENGTH_RATIOS.high), 2);
  assert.equal(boldLength(5, STRENGTH_RATIOS.high), 3);
  assert.equal(boldLength(7, STRENGTH_RATIOS.high), 4);
});

test("boldLength invariants: >=1 bold and >=1 plain for n >= 2", () => {
  for (const ratio of Object.values(STRENGTH_RATIOS)) {
    for (let n = 2; n <= 40; n++) {
      const b = boldLength(n, ratio);
      assert.ok(b >= 1, `n=${n} ratio=${ratio}: bold ${b} < 1`);
      assert.ok(b <= n - 1, `n=${n} ratio=${ratio}: bold ${b} leaves no plain`);
    }
  }
});

test("boldLength edge cases", () => {
  assert.equal(boldLength(0, MEDIUM), 0);
  assert.equal(boldLength(-3, MEDIUM), 0);
  assert.equal(boldLength(1, STRENGTH_RATIOS.low), 1);
  assert.equal(boldLength(1, STRENGTH_RATIOS.high), 1);
});

test("processText: part shape from the spec", () => {
  // "reading" (7) → round(3.15) = 3; "helps" (5) → round(2.25) = 2.
  assert.deepEqual(processText("reading helps", MEDIUM, LOCALE), [
    { bold: "rea" },
    { plain: "ding " },
    { bold: "he" },
    { plain: "lps" },
  ]);
});

test("processText: concatenated parts always reproduce the input", () => {
  const samples = [
    "The quick brown fox jumps over the lazy dog.",
    "  leading and trailing whitespace  ",
    "punctuation, everywhere! (really?) — yes; truly...",
    "don't split contractions",
    "well-known hyphenated-words work",
    "digits 123 and mixed abc123 tokens",
    "emoji 👍 and families 👨‍👩‍👧‍👦 pass through",
    "mixed scripts: hello 世界 and こんにちは friends",
    "한국어 텍스트",
    "ภาษาไทยไม่มีช่องว่าง",
    "naïve café coöperation",
    "ALLCAPS and MiXeD CaSe",
    "\n\t whitespace \n only words \t",
    "",
  ];
  for (const s of samples) {
    for (const ratio of Object.values(STRENGTH_RATIOS)) {
      assert.equal(joined(processText(s, ratio, LOCALE)), s, JSON.stringify(s));
    }
  }
});

test("processText: never two consecutive parts of the same type", () => {
  const samples = [
    "a b c, d — e! 汉字 mixed in 123 ... end",
    "I a x single letters",
    "hello... world?!",
  ];
  for (const s of samples) {
    const parts = processText(s, MEDIUM, LOCALE);
    for (let i = 1; i < parts.length; i++) {
      const prevIsBold = parts[i - 1].bold !== undefined;
      const curIsBold = parts[i].bold !== undefined;
      assert.notEqual(prevIsBold, curIsBold, `${JSON.stringify(s)} at part ${i}`);
    }
  }
});

test("processText: apostrophes stay inside the word", () => {
  // "don't" is one 5-cluster word: round(5 * 0.45) = 2 → bold "do"
  const parts = processText("don't", MEDIUM, LOCALE);
  assert.deepEqual(parts, [{ bold: "do" }, { plain: "n't" }]);
});

test("processText: hyphenated words bold each half", () => {
  const parts = processText("well-known", MEDIUM, LOCALE);
  assert.deepEqual(parts, [
    { bold: "we" },
    { plain: "ll-" },
    { bold: "kn" },
    { plain: "own" },
  ]);
});

test("processText: single-letter words are fully bold", () => {
  const parts = processText("I a x", MEDIUM, LOCALE);
  assert.deepEqual(parts, [
    { bold: "I" },
    { plain: " " },
    { bold: "a" },
    { plain: " " },
    { bold: "x" },
  ]);
});

test("processText: pure digits and punctuation pass through untouched", () => {
  for (const s of ["123 456", "!!! ??? ...", "12:34", "👍 🎉", "   "]) {
    const parts = processText(s, MEDIUM, LOCALE);
    assert.deepEqual(parts, [{ plain: s }], JSON.stringify(s));
  }
});

test("processText: CJK, Hangul, and Thai text is never bolded", () => {
  const samples = [
    "这是一段中文文本",
    "これはテストです",
    "カタカナ",
    "한국어 텍스트입니다",
    "ภาษาไทยไม่มีช่องว่าง",
  ];
  for (const s of samples) {
    const parts = processText(s, MEDIUM, LOCALE);
    assert.deepEqual(boldParts(parts), [], JSON.stringify(s));
    assert.equal(joined(parts), s);
  }
});

test("processText: latin words around CJK still get bolded", () => {
  const parts = processText("hello 世界 world", MEDIUM, LOCALE);
  assert.deepEqual(parts, [
    { bold: "he" },
    { plain: "llo 世界 " },
    { bold: "wo" },
    { plain: "rld" },
  ]);
});

test("processText: counts grapheme clusters, not UTF-16 code units", () => {
  // Decomposed "naïve": n a i+U+0308 v e → 6 code units but 5 clusters,
  // so medium bolds 2 clusters ("na"), not half the code units.
  const decomposed = "naïve";
  const parts = processText(decomposed, MEDIUM, LOCALE);
  assert.equal(parts[0].bold, "na");
  assert.equal(joined(parts), decomposed);

  // A combining mark is never separated from its base: with high strength
  // "café" (decomposed) bolds 2 of 4 clusters → "ca", and the e+accent
  // stays whole in the plain part.
  const cafe = "café";
  const high = processText(cafe, STRENGTH_RATIOS.high, LOCALE);
  assert.equal(high[0].bold, "ca");
  assert.equal(high[1].plain, "fé");
});

test("processText: RTL scripts (not in the skip list) are bolded", () => {
  const parts = processText("שלום עולם", MEDIUM, LOCALE);
  assert.ok(boldParts(parts).length === 2);
  assert.equal(joined(parts), "שלום עולם");
});

test("processText: empty and nullish input", () => {
  assert.deepEqual(processText("", MEDIUM, LOCALE), []);
  assert.deepEqual(processText(null, MEDIUM, LOCALE), []);
  assert.deepEqual(processText(undefined, MEDIUM, LOCALE), []);
});

test("segmentWords: flags exactly the boldable segments", () => {
  const segs = segmentWords("ab 12 汉 c", LOCALE);
  assert.equal(segs.map((s) => s.text).join(""), "ab 12 汉 c");
  const words = segs.filter((s) => s.isWord).map((s) => s.text);
  assert.deepEqual(words, ["ab", "c"]);
});

test("segmentWords: empty input", () => {
  assert.deepEqual(segmentWords("", LOCALE), []);
});

test("normalizeSettings: missing or malformed input yields defaults", () => {
  for (const raw of [undefined, null, 42, "x", [], {}]) {
    const s = normalizeSettings(raw);
    assert.deepEqual(s, {
      v: 1,
      enabled: true,
      strength: "medium",
      disabledSites: [],
    });
  }
});

test("normalizeSettings: preserves valid values, fixes invalid ones", () => {
  const s = normalizeSettings({
    enabled: false,
    strength: "high",
    disabledSites: ["example.com", 7, "", "news.ycombinator.com"],
  });
  assert.equal(s.enabled, false);
  assert.equal(s.strength, "high");
  assert.deepEqual(s.disabledSites, ["example.com", "news.ycombinator.com"]);

  const bad = normalizeSettings({ enabled: "yes", strength: "ultra", disabledSites: "nope" });
  assert.equal(bad.enabled, true);
  assert.equal(bad.strength, "medium");
  assert.deepEqual(bad.disabledSites, []);
});

test("normalizeSettings: matches DEFAULT_SETTINGS shape", () => {
  assert.deepEqual(normalizeSettings(null), {
    v: DEFAULT_SETTINGS.v,
    enabled: DEFAULT_SETTINGS.enabled,
    strength: DEFAULT_SETTINGS.strength,
    disabledSites: [],
  });
});

test("hostnameFromUrl: http(s) pages only", () => {
  assert.equal(hostnameFromUrl("https://en.wikipedia.org/wiki/Reading"), "en.wikipedia.org");
  assert.equal(hostnameFromUrl("http://localhost:3000/app"), "localhost");
  assert.equal(hostnameFromUrl("https://example.com"), "example.com");
  for (const url of [
    "chrome://settings",
    "chrome-extension://abc/popup.html",
    "about:blank",
    "file:///home/user/doc.html",
    "data:text/html,hi",
    "view-source:https://example.com",
    "not a url",
    "",
    null,
    undefined,
  ]) {
    assert.equal(hostnameFromUrl(url), null, String(url));
  }
});
