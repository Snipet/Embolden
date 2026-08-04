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
    "AUDIO", "IFRAME", "HEAD", "TITLE", WRAPPER_TAG,
  ]);
  // Ligature icon fonts render words like "settings" as a single glyph;
  // splitting them into spans destroys the icon. Catches Font Awesome,
  // Material Icons/Symbols, Glyphicons, and the bare-<i> convention.
  const ICON_CLASS_RE = /\b(icon|material-icons|material-symbols|glyphicon|fa[srlbd]?-?)/i;
  const HAS_LETTER_RE = /\p{L}/u;

  const SLICE_BUDGET_MS = 8;
  const FALLBACK_CHUNK = 200;
  const DEDUPE_ROOT_LIMIT = 50;

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

  // Roots touched by page mutations, awaiting a debounced re-process.
  const pendingRoots = new Set();
  let flushScheduled = false;

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

  // The walker filter only vets descendants of the root it starts from.
  // Mutation roots can sit anywhere (e.g. inside a contenteditable
  // composer), so their own chain up to <html> must be vetted too.
  function isInsideSkippedTree(el) {
    for (let e = el; e !== null; e = e.parentElement) {
      if (e.nodeType === Node.ELEMENT_NODE && isSkippedElement(e)) return true;
    }
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
    // Re-vet at wrap time: between collection and this idle slice the node
    // may have moved, or an ancestor may have become editable/skipped
    // (attribute flips produce no observer records).
    if (!node.parentElement || isInsideSkippedTree(node.parentElement)) return;
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

  // ---------------------------------------------------------------------
  // MutationObserver: catches SPA re-renders, infinite scroll, and live
  // text updates. Our own DOM writes always happen with the observer
  // disconnected (within one synchronous block, so no page mutations can
  // slip through the gap) — records only queue while connected, which is
  // sturdier than any boolean "ignore my own mutations" flag.
  // ---------------------------------------------------------------------
  const observer = new MutationObserver((records) => {
    if (!active) return;
    collectFromRecords(records);
    scheduleFlush();
  });

  function observe() {
    // Observe documentElement, not body: Turbo/Turbolinks-style apps swap
    // the whole <body> element on navigation, and an observer bound to the
    // old body would be left watching a detached node forever. Head/title
    // mutations that this now also delivers are pruned by the HEAD/TITLE
    // skip tags when roots are vetted.
    if (document.documentElement) {
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    }
  }

  function withObserverPaused(fn) {
    // Queued-but-undelivered records would be lost on disconnect; drain
    // them into pendingRoots first.
    const pending = observer.takeRecords();
    if (pending.length > 0) {
      collectFromRecords(pending);
      scheduleFlush();
    }
    observer.disconnect();
    try {
      fn();
    } finally {
      if (active) observe();
    }
  }

  function isOurElement(node) {
    let el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    for (; el !== null; el = el.parentElement) {
      if (el.nodeName.toUpperCase() === WRAPPER_TAG) return true;
    }
    return false;
  }

  function addRoot(node) {
    if (!node) return;
    const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    if (el) pendingRoots.add(el);
  }

  function collectFromRecords(records) {
    for (const record of records) {
      // Belt-and-braces: our writes shouldn't be observed at all (see
      // withObserverPaused), but never react to anything inside a wrapper.
      if (isOurElement(record.target)) continue;
      if (record.type === "characterData") {
        addRoot(record.target);
      } else if (record.type === "childList") {
        for (const node of record.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.TEXT_NODE) {
            continue;
          }
          if (isOurElement(node)) continue;
          addRoot(node);
        }
        // A framework may strip our wrappers on re-render, leaving
        // partial-word text fragments behind; reprocess the parent.
        for (const node of record.removedNodes) {
          if (
            node.nodeType === Node.ELEMENT_NODE &&
            node.nodeName.toUpperCase() === WRAPPER_TAG
          ) {
            addRoot(record.target);
            break;
          }
        }
      }
    }
  }

  function scheduleFlush() {
    if (flushScheduled) return;
    flushScheduled = true;
    scheduleIdle(flushRoots);
  }

  function flushRoots() {
    flushScheduled = false;
    if (!active) {
      pendingRoots.clear();
      return;
    }
    const roots = Array.from(pendingRoots);
    pendingRoots.clear();
    const live = roots.filter((r) => r.isConnected && !isInsideSkippedTree(r));
    // Drop roots nested inside other pending roots (redundant work, and a
    // nested revert between an ancestor's revert and re-wrap is wasted).
    // Purely an optimization, so skip the O(n²) pass on big batches.
    const tops =
      live.length <= DEDUPE_ROOT_LIMIT
        ? live.filter((r) => !live.some((o) => o !== r && o.contains(r)))
        : live;
    if (tops.length === 0) return;
    withObserverPaused(() => {
      for (const root of tops) {
        // Revert before re-walking: existing wrappers under this root hold
        // partial words, and normalize() fuses the fragments back into
        // whole text nodes so re-bolding starts from clean words.
        revertUnder(root);
        collectTextNodes(root, queue);
      }
    });
    scheduleQueue();
  }

  // ---------------------------------------------------------------------
  // Apply / revert
  // ---------------------------------------------------------------------
  function scheduleQueue() {
    if (queueSize() === 0) return;
    if (queueScheduled) return;
    queueScheduled = true;
    const gen = generation;
    scheduleIdle((deadline) => processQueue(gen, deadline));
  }

  function processQueue(gen, deadline) {
    queueScheduled = false;
    if (gen !== generation) {
      // A newer apply superseded this slice while it was pending. Any
      // queued nodes were collected by that newer generation (every bump
      // runs resetQueue first), so hand the callback slot over to it
      // instead of stranding a full queue with nothing scheduled.
      scheduleQueue();
      return;
    }
    const sliceStart = performance.now();
    const hasDeadline = deadline && typeof deadline.timeRemaining === "function";
    withObserverPaused(() => {
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
    });
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
    pendingRoots.clear();
    active = true;
    observe();
    // TreeWalker filters never vet the traversal root itself, so check
    // body's own chain: covers data-embolden-skip on <body>/<html> and
    // fully-editable documents (designMode editor iframes).
    if (!document.body || isInsideSkippedTree(document.body)) return;
    collectTextNodes(document.body, queue);
    scheduleQueue();
  }

  function revertAll() {
    generation++;
    resetQueue();
    active = false;
    observer.disconnect();
    pendingRoots.clear();
    if (!document.body) return;
    revertUnder(document.body);
  }

  // ---------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------
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
