import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const core = require("../src/core.js");

const {
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

test("an unknown v1 strength migrates to the default coverage", () => {
  for (const strength of ["bogus", undefined, null, 7]) {
    assert.equal(normalizeSettings({ strength }).coverage, 45, String(strength));
  }
});

test("inherited object keys are not valid strengths", () => {
  // A corrupt/synced strength like "toString" must not resolve through the
  // prototype chain into a non-number ratio (which would NaN every word).
  for (const key of ["toString", "constructor", "valueOf", "hasOwnProperty", "__proto__"]) {
    assert.equal(normalizeSettings({ strength: key }).coverage, 45, key);
  }
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
  assert.deepEqual(processText("reading helps", { ratio: MEDIUM }, LOCALE), [
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
      assert.equal(joined(processText(s, { ratio }, LOCALE)), s, JSON.stringify(s));
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
    const parts = processText(s, { ratio: MEDIUM }, LOCALE);
    for (let i = 1; i < parts.length; i++) {
      const prevIsBold = parts[i - 1].bold !== undefined;
      const curIsBold = parts[i].bold !== undefined;
      assert.notEqual(prevIsBold, curIsBold, `${JSON.stringify(s)} at part ${i}`);
    }
  }
});

test("processText: apostrophes stay inside the word", () => {
  // "don't" is one 5-cluster word: round(5 * 0.45) = 2 → bold "do"
  const parts = processText("don't", { ratio: MEDIUM }, LOCALE);
  assert.deepEqual(parts, [{ bold: "do" }, { plain: "n't" }]);
});

test("processText: hyphenated words bold each half", () => {
  const parts = processText("well-known", { ratio: MEDIUM }, LOCALE);
  assert.deepEqual(parts, [
    { bold: "we" },
    { plain: "ll-" },
    { bold: "kn" },
    { plain: "own" },
  ]);
});

test("processText: single-letter words are fully bold", () => {
  const parts = processText("I a x", { ratio: MEDIUM }, LOCALE);
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
    const parts = processText(s, { ratio: MEDIUM }, LOCALE);
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
    const parts = processText(s, { ratio: MEDIUM }, LOCALE);
    assert.deepEqual(boldParts(parts), [], JSON.stringify(s));
    assert.equal(joined(parts), s);
  }
});

test("processText: latin words around CJK still get bolded", () => {
  const parts = processText("hello 世界 world", { ratio: MEDIUM }, LOCALE);
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
  const parts = processText(decomposed, { ratio: MEDIUM }, LOCALE);
  assert.equal(parts[0].bold, "na");
  assert.equal(joined(parts), decomposed);

  // A combining mark is never separated from its base: with high strength
  // "café" (decomposed) bolds 2 of 4 clusters → "ca", and the e+accent
  // stays whole in the plain part.
  const cafe = "café";
  const high = processText(cafe, { ratio: STRENGTH_RATIOS.high }, LOCALE);
  assert.equal(high[0].bold, "ca");
  assert.equal(high[1].plain, "fé");
});

test("processText: RTL scripts (not in the skip list) are bolded", () => {
  const parts = processText("שלום עולם", { ratio: MEDIUM }, LOCALE);
  assert.ok(boldParts(parts).length === 2);
  assert.equal(joined(parts), "שלום עולם");
});

test("processText: empty and nullish input", () => {
  assert.deepEqual(processText("", { ratio: MEDIUM }, LOCALE), []);
  assert.deepEqual(processText(null, { ratio: MEDIUM }, LOCALE), []);
  assert.deepEqual(processText(undefined, { ratio: MEDIUM }, LOCALE), []);
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
      v: 2,
      enabled: true,
      coverage: 45,
      weight: 700,
      jitter: 0,
      disabledSites: [],
    });
  }
});

test("normalizeSettings: preserves valid values, fixes invalid ones", () => {
  const s = normalizeSettings({
    enabled: false,
    coverage: 70,
    weight: 900,
    jitter: 2,
    disabledSites: ["example.com", 7, "", "news.ycombinator.com"],
  });
  assert.equal(s.enabled, false);
  assert.equal(s.coverage, 70);
  assert.equal(s.weight, 900);
  assert.equal(s.jitter, 2);
  assert.deepEqual(s.disabledSites, ["example.com", "news.ycombinator.com"]);

  const bad = normalizeSettings({
    enabled: "yes",
    coverage: "lots",
    weight: null,
    jitter: {},
    disabledSites: "nope",
  });
  assert.equal(bad.enabled, true);
  assert.equal(bad.coverage, 45);
  assert.equal(bad.weight, 700);
  assert.equal(bad.jitter, 0);
  assert.deepEqual(bad.disabledSites, []);
});

test("normalizeSettings: matches DEFAULT_SETTINGS shape", () => {
  assert.deepEqual(normalizeSettings(null), {
    v: DEFAULT_SETTINGS.v,
    enabled: DEFAULT_SETTINGS.enabled,
    coverage: DEFAULT_SETTINGS.coverage,
    weight: DEFAULT_SETTINGS.weight,
    jitter: DEFAULT_SETTINGS.jitter,
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

// ---------------------------------------------------------------------------
// Coverage / weight / jitter (settings v2)
// ---------------------------------------------------------------------------

test("quantize: snaps onto the step grid and clamps to the range", () => {
  const c = LIMITS.coverage; // 10–90 by 5
  assert.equal(quantize(45, c), 45);
  assert.equal(quantize(47, c), 45);
  assert.equal(quantize(48, c), 50);
  assert.equal(quantize(-100, c), c.min);
  assert.equal(quantize(1e9, c), c.max);
  assert.equal(quantize(725, LIMITS.weight), 700);
  assert.equal(quantize(751, LIMITS.weight), 800);
});

test("quantize: rejects non-numbers so callers can pick the fallback", () => {
  for (const v of [undefined, null, "45", NaN, Infinity, -Infinity, {}, []]) {
    assert.equal(quantize(v, LIMITS.coverage), null, String(v));
  }
});

test("LIMITS defaults sit on their own grids", () => {
  for (const [name, range] of Object.entries(LIMITS)) {
    assert.equal(quantize(range.default, range), range.default, name);
    assert.ok(range.min <= range.default && range.default <= range.max, name);
  }
});

test("normalizeSettings: v1 strength migrates to a coverage percentage", () => {
  assert.equal(normalizeSettings({ v: 1, strength: "low" }).coverage, 30);
  assert.equal(normalizeSettings({ v: 1, strength: "medium" }).coverage, 45);
  assert.equal(normalizeSettings({ v: 1, strength: "high" }).coverage, 60);
  // Migrated profiles keep everything else they had.
  const migrated = normalizeSettings({
    v: 1,
    enabled: false,
    strength: "high",
    disabledSites: ["example.com"],
  });
  assert.equal(migrated.v, 2);
  assert.equal(migrated.coverage, 60);
  assert.equal(migrated.enabled, false);
  assert.deepEqual(migrated.disabledSites, ["example.com"]);
});

test("normalizeSettings: an explicit coverage wins over a stale strength", () => {
  assert.equal(normalizeSettings({ strength: "low", coverage: 80 }).coverage, 80);
});

test("normalizeSettings: out-of-range numbers are clamped, not rejected", () => {
  const s = normalizeSettings({ coverage: 500, weight: 100, jitter: 99 });
  assert.equal(s.coverage, LIMITS.coverage.max);
  assert.equal(s.weight, LIMITS.weight.min);
  assert.equal(s.jitter, LIMITS.jitter.max);
});

test("renderOptions: derives ratio + jitter, ignoring weight", () => {
  assert.deepEqual(renderOptions({ coverage: 60, jitter: 2, weight: 900 }), {
    ratio: 0.6,
    jitter: 2,
  });
  // Garbage in, defaults out — the popup renders before storage answers.
  assert.deepEqual(renderOptions(null), { ratio: 0.45, jitter: 0 });
  assert.deepEqual(renderOptions({}), { ratio: 0.45, jitter: 0 });
});

test("processText: a missing/garbage options object falls back to defaults", () => {
  const expected = processText("reading", { ratio: 0.45 }, LOCALE);
  for (const options of [undefined, null, {}, "medium", 7]) {
    assert.deepEqual(processText("reading", options, LOCALE), expected, String(options));
  }
});

test("hashWord: deterministic, and unsigned 32-bit", () => {
  for (const w of ["reading", "", "a", "naïve", "👍", "The"]) {
    const h = hashWord(w);
    assert.equal(h, hashWord(w), w);
    assert.ok(Number.isInteger(h) && h >= 0 && h <= 0xffffffff, w);
  }
  assert.notEqual(hashWord("The"), hashWord("the"));
});

test("jitterOffset: zero when disabled, in range otherwise", () => {
  for (const w of ["reading", "anchor", "the", "variation", "x"]) {
    assert.equal(jitterOffset(w, 0), 0, w);
    for (let j = 1; j <= LIMITS.jitter.max; j++) {
      const offset = jitterOffset(w, j);
      assert.ok(Number.isInteger(offset), `${w}@${j}`);
      assert.ok(offset >= -j && offset <= j, `${w}@${j}: ${offset}`);
    }
  }
  assert.equal(jitterOffset("", 3), 0);
});

test("jitterOffset: same word always gets the same offset", () => {
  // Stability is the whole point: a page mutation reprocesses a subtree, and
  // text that re-jittered on every pass would visibly twitch.
  for (let j = 1; j <= LIMITS.jitter.max; j++) {
    assert.equal(jitterOffset("attention", j), jitterOffset("attention", j));
  }
});

test("jitterOffset: actually varies across a normal sentence", () => {
  const words = "the quick brown fox jumps over a lazy dog while reading".split(" ");
  const offsets = new Set(words.map((w) => jitterOffset(w, 2)));
  assert.ok(offsets.size >= 3, `too uniform: ${[...offsets].join(",")}`);
});

test("boldLength: the jitter offset shifts the split", () => {
  // "attention" is 9 clusters; medium → 4.
  assert.equal(boldLength(9, MEDIUM, 0), 4);
  assert.equal(boldLength(9, MEDIUM, 2), 6);
  assert.equal(boldLength(9, MEDIUM, -2), 2);
});

test("boldLength: jitter can never bold a whole word or none of it", () => {
  for (const ratio of [0.1, 0.45, 0.9]) {
    for (let n = 2; n <= 24; n++) {
      for (let offset = -6; offset <= 6; offset++) {
        const b = boldLength(n, ratio, offset);
        assert.ok(b >= 1, `n=${n} offset=${offset}: ${b}`);
        assert.ok(b <= n - 1, `n=${n} offset=${offset}: ${b}`);
      }
    }
  }
  // One-cluster words stay fully bold regardless of jitter.
  assert.equal(boldLength(1, MEDIUM, -3), 1);
  assert.equal(boldLength(1, MEDIUM, 3), 1);
});

test("processText with jitter: still reproduces the input exactly", () => {
  const samples = [
    "The quick brown fox jumps over the lazy dog.",
    "punctuation, everywhere! (really?) — yes; truly...",
    "emoji 👍 and families 👨‍👩‍👧‍👦 pass through",
    "mixed scripts: hello 世界 and こんにちは friends",
    "naïve café coöperation",
  ];
  for (const s of samples) {
    for (let jitter = 0; jitter <= LIMITS.jitter.max; jitter++) {
      for (const coverage of [10, 45, 90]) {
        const parts = processText(s, { ratio: coverage / 100, jitter }, LOCALE);
        assert.equal(joined(parts), s, `${JSON.stringify(s)} j=${jitter} c=${coverage}`);
      }
    }
  }
});

test("processText with jitter: identical words bold identically", () => {
  const parts = processText("reading reading", { ratio: MEDIUM, jitter: 3 }, LOCALE);
  const bolds = boldParts(parts);
  assert.equal(bolds.length, 2);
  assert.equal(bolds[0], bolds[1]);
});

test("processText at the coverage extremes keeps one plain cluster", () => {
  const parts = processText("anchor", { ratio: 0.9 }, LOCALE);
  assert.deepEqual(parts, [{ bold: "ancho" }, { plain: "r" }]);
  assert.deepEqual(processText("anchor", { ratio: 0.1 }, LOCALE), [
    { bold: "a" },
    { plain: "nchor" },
  ]);
});

test("sameSettings: equal when every rendered field matches", () => {
  const base = normalizeSettings({ coverage: 50, weight: 800, jitter: 1 });
  assert.ok(sameSettings(base, normalizeSettings({ coverage: 50, weight: 800, jitter: 1 })));
  for (const change of [
    { enabled: false },
    { coverage: 55 },
    { weight: 900 },
    { jitter: 2 },
    { disabledSites: ["example.com"] },
  ]) {
    const other = normalizeSettings({ coverage: 50, weight: 800, jitter: 1, ...change });
    assert.equal(sameSettings(base, other), false, JSON.stringify(change));
  }
});

test("sameSettings: disabled-site order matters, nullish is never equal", () => {
  const a = normalizeSettings({ disabledSites: ["a.com", "b.com"] });
  const b = normalizeSettings({ disabledSites: ["b.com", "a.com"] });
  assert.equal(sameSettings(a, b), false);
  assert.equal(sameSettings(a, null), false);
  assert.equal(sameSettings(null, a), false);
});
