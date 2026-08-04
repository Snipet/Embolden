"use strict";

// Embolden content script — DOM pipeline. Pure logic lives in core.js
// (loaded before this file, exposed as globalThis.EmboldenCore).
//
// State is storage-driven: this script reads chrome.storage.sync once on
// injection and reacts to chrome.storage.onChanged afterwards. Nothing
// messages it directly, so tabs opened before the popup stay in sync.
(() => {
  if (window.__emboldenLoaded) return;
  window.__emboldenLoaded = true;

  const core = globalThis.EmboldenCore;
  if (!core || typeof Intl === "undefined" || typeof Intl.Segmenter !== "function") {
    return;
  }
  const storage =
    typeof chrome !== "undefined" && chrome.storage && chrome.storage.sync
      ? chrome.storage
      : null;
  if (!storage) return;

  const WRAPPER_TAG = "EMB-B";
  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TEXTAREA", "INPUT", "SELECT",
    "OPTION", "CODE", "PRE", "KBD", "SAMP", "SVG", "MATH", "CANVAS", "VIDEO",
    "AUDIO", "IFRAME", WRAPPER_TAG,
  ]);
  // Ligature icon fonts render words like "settings" as a single glyph;
  // splitting them into spans destroys the icon. Catches Font Awesome,
  // Material Icons/Symbols, Glyphicons, and the bare-<i> convention.
  const ICON_CLASS_RE = /\b(icon|material-icons|material-symbols|glyphicon|fa[srlbd]?-?)/i;
  const HAS_LETTER_RE = /\p{L}/u;

  const SLICE_BUDGET_MS = 8;
  const FALLBACK_CHUNK = 200;

  let settings = core.normalizeSettings(null);
  let ratio = core.ratioForStrength(settings.strength);
  // True while wrappers are applied (or an apply pass is in flight).
  let active = false;

  // Generation counter: bumped whenever a new apply/revert supersedes
  // in-flight chunked work, so stale idle callbacks abort instead of
  // wrapping into a page that has since been reverted or re-styled.
  let generation = 0;

  // Wrap queue with a cursor instead of shift() so draining is O(1) per node.
  let queue = [];
  let queueIndex = 0;
  let queueScheduled = false;

  function resetQueue() {
    queue = [];
    queueIndex = 0;
  }

  function queueSize() {
    return queue.length - queueIndex;
  }

  function isSkippedElement(el) {
    const tag = el.nodeName.toUpperCase();
    if (SKIP_TAGS.has(tag)) return true;
    if (tag === "I") return true;
    if (el.isContentEditable) return true;
    if (typeof el.hasAttribute === "function" && el.hasAttribute("data-embolden-skip")) {
      return true;
    }
    const cls = typeof el.getAttribute === "function" ? el.getAttribute("class") : null;
    if (cls && ICON_CLASS_RE.test(cls)) return true;
    return false;
  }

  function walkerFilter(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.nodeValue;
      return text && text.trim().length > 0 && HAS_LETTER_RE.test(text)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    }
    // FILTER_REJECT prunes the whole subtree; FILTER_SKIP still descends.
    return isSkippedElement(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
  }

  function collectTextNodes(root, out) {
    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
      walkerFilter
    );
    let node;
    while ((node = walker.nextNode()) !== null) out.push(node);
  }

  function wrapTextNode(node) {
    if (!node.isConnected) return;
    const parent = node.parentNode;
    if (!parent) return;
    const text = node.nodeValue;
    if (!text || !HAS_LETTER_RE.test(text)) return;
    const parts = core.processText(text, ratio);
    if (parts.length === 0) return;
    if (parts.length === 1 && parts[0].plain !== undefined) return;
    const frag = document.createDocumentFragment();
    for (const part of parts) {
      if (part.bold !== undefined) {
        const b = document.createElement("emb-b");
        b.textContent = part.bold;
        frag.appendChild(b);
      } else {
        frag.appendChild(document.createTextNode(part.plain));
      }
    }
    parent.replaceChild(frag, node);
  }

  function scheduleIdle(fn) {
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(fn, { timeout: 500 });
    } else {
      setTimeout(fn, 0);
    }
  }

  function scheduleQueue() {
    if (queueScheduled) return;
    queueScheduled = true;
    const gen = generation;
    scheduleIdle((deadline) => processQueue(gen, deadline));
  }

  function processQueue(gen, deadline) {
    queueScheduled = false;
    if (gen !== generation) return;
    const sliceStart = performance.now();
    const hasDeadline = deadline && typeof deadline.timeRemaining === "function";
    let count = 0;
    while (queueSize() > 0) {
      if (performance.now() - sliceStart > SLICE_BUDGET_MS) break;
      if (hasDeadline) {
        if (deadline.timeRemaining() <= 1 && !deadline.didTimeout) break;
      } else if (count >= FALLBACK_CHUNK) {
        break;
      }
      wrapTextNode(queue[queueIndex++]);
      count++;
    }
    if (queueSize() > 0) scheduleQueue();
    else resetQueue();
  }

  function revertUnder(root) {
    const wrappers = root.querySelectorAll("emb-b");
    if (wrappers.length === 0) return;
    const parents = new Set();
    for (const w of wrappers) {
      const parent = w.parentNode;
      if (!parent) continue;
      parent.replaceChild(document.createTextNode(w.textContent), w);
      parents.add(parent);
    }
    // Merge the leftover fragments back into whole text nodes.
    for (const parent of parents) parent.normalize();
  }

  function applyAll() {
    generation++;
    resetQueue();
    active = true;
    if (!document.body) return;
    collectTextNodes(document.body, queue);
    scheduleQueue();
  }

  function revertAll() {
    generation++;
    resetQueue();
    active = false;
    if (!document.body) return;
    revertUnder(document.body);
  }

  function effectiveEnabled(s) {
    return s.enabled && !s.disabledSites.includes(location.hostname);
  }

  function applySettings(next) {
    const prev = settings;
    settings = next;
    ratio = core.ratioForStrength(next.strength);
    const shouldBeOn = effectiveEnabled(next);
    if (shouldBeOn && !active) {
      applyAll();
    } else if (!shouldBeOn && active) {
      revertAll();
    } else if (shouldBeOn && active && prev.strength !== next.strength) {
      // Strength change: revert + reapply (simple and correct).
      revertAll();
      applyAll();
    }
  }

  storage.onChanged.addListener((changes, area) => {
    if (area !== "sync" || !changes.settings) return;
    applySettings(core.normalizeSettings(changes.settings.newValue));
  });

  storage.sync.get("settings", (result) => {
    if (chrome.runtime.lastError) return;
    applySettings(core.normalizeSettings(result.settings));
  });
})();
