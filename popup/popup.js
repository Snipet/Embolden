"use strict";

// Popup logic. Reads/writes the single "settings" key in chrome.storage.sync;
// content scripts pick changes up via chrome.storage.onChanged. core.js is
// loaded first via <script>, so EmboldenCore is on globalThis.
(() => {
  const core = globalThis.EmboldenCore;
  const LIMITS = core.LIMITS;

  const PREVIEW_TEXT =
    "An anchor at the start of every word gives your eyes a place to land, so long pages stop sliding past.";

  const JITTER_LABELS = ["Off", "Subtle", "Mixed", "Wild"];
  const WEIGHT_LABELS = {
    500: "Light",
    600: "Semi",
    700: "Bold",
    800: "Extra",
    900: "Black",
  };

  // Content scripts can't run on the Web Store even though the URL is https.
  const WEBSTORE_HOSTS = new Set(["chromewebstore.google.com", "chrome.google.com"]);

  // Slider travel is (track − thumb) wide, so a naive percentage leaves the
  // fill lagging the thumb at both ends. Keep the two numbers in sync.
  const THUMB_PX = 18;

  const SAVE_DEBOUNCE_MS = 250;

  const el = (id) => document.getElementById(id);

  const masterToggle = el("master-toggle");
  const siteToggle = el("site-toggle");
  const siteSwitch = el("site-switch");
  const siteHost = el("site-host");
  const siteMonogram = el("site-monogram");
  const coverage = el("coverage");
  const coverageValue = el("coverage-value");
  const jitter = el("jitter");
  const jitterValue = el("jitter-value");
  const jitterStops = Array.from(el("jitter-stops").querySelectorAll("span"));
  const weightGroup = el("weight-group");
  const weightButtons = Array.from(weightGroup.querySelectorAll("button"));
  const weightValue = el("weight-value");
  const preview = el("preview");
  const stage = document.querySelector(".stage");
  const stageNote = el("stage-note");
  const resetButton = el("reset");

  let settings = core.normalizeSettings(null);
  // null until the active tab is known; stays null on unsupported pages.
  let currentHost = null;

  function configureRange(input, range) {
    input.min = String(range.min);
    input.max = String(range.max);
    input.step = String(range.step);
  }

  configureRange(coverage, LIMITS.coverage);
  configureRange(jitter, LIMITS.jitter);

  function siteEnabled() {
    return currentHost !== null && !settings.disabledSites.includes(currentHost);
  }

  function effectivelyOn() {
    return settings.enabled && (currentHost === null || siteEnabled());
  }

  function paintTrack(input, range) {
    const fraction = (Number(input.value) - range.min) / (range.max - range.min);
    input.style.setProperty(
      "--fill",
      `calc(${fraction} * (100% - ${THUMB_PX}px) + ${THUMB_PX / 2}px)`
    );
  }

  function renderPreview() {
    const parts = core.processText(PREVIEW_TEXT, core.renderOptions(settings), "en");
    preview.textContent = "";
    for (const part of parts) {
      if (part.bold !== undefined) {
        const b = document.createElement("emb-b");
        b.textContent = part.bold;
        preview.appendChild(b);
      } else {
        preview.appendChild(document.createTextNode(part.plain));
      }
    }
    // The preview inherits the same custom property the content script writes
    // to page documents, so one code path drives both.
    document.documentElement.style.setProperty("--embolden-weight", String(settings.weight));
    const on = effectivelyOn();
    stage.classList.toggle("off", !on);
    stageNote.textContent = !settings.enabled
      ? "Paused everywhere"
      : currentHost !== null && !siteEnabled()
        ? `Paused on ${currentHost}`
        : "";
  }

  function render() {
    masterToggle.checked = settings.enabled;
    siteToggle.checked = siteEnabled();

    coverage.value = String(settings.coverage);
    coverage.setAttribute("aria-valuetext", `${settings.coverage}% of each word`);
    coverageValue.textContent = `${settings.coverage}%`;
    paintTrack(coverage, LIMITS.coverage);

    jitter.value = String(settings.jitter);
    const jitterLabel = JITTER_LABELS[settings.jitter] || JITTER_LABELS[0];
    jitter.setAttribute("aria-valuetext", jitterLabel);
    jitterValue.textContent = jitterLabel;
    paintTrack(jitter, LIMITS.jitter);
    for (const stop of jitterStops) {
      stop.dataset.active = Number(stop.dataset.stop) === settings.jitter ? "true" : "false";
    }

    weightValue.textContent = WEIGHT_LABELS[settings.weight] || String(settings.weight);
    for (const button of weightButtons) {
      const selected = Number(button.dataset.weight) === settings.weight;
      button.setAttribute("aria-checked", selected ? "true" : "false");
      // Roving tabindex: Tab reaches the group once, arrows move within.
      button.tabIndex = selected ? 0 : -1;
    }

    renderPreview();
  }

  // ---------------------------------------------------------------- saving
  // Dragging a slider fires `input` continuously. chrome.storage.sync has a
  // write-rate quota (and every write makes content scripts re-walk the page),
  // so drags are debounced while the UI updates on every frame; `change`
  // (mouse release, keyboard commit) flushes immediately.
  let saveTimer = null;

  function writeSettings() {
    chrome.storage.sync.set({ settings }, () => {
      if (chrome.runtime.lastError) {
        console.warn("Embolden: saving settings failed:", chrome.runtime.lastError.message);
      }
    });
  }

  function flushSave() {
    if (saveTimer === null) return;
    clearTimeout(saveTimer);
    saveTimer = null;
    writeSettings();
  }

  function saveSoon() {
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      writeSettings();
    }, SAVE_DEBOUNCE_MS);
  }

  function save() {
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    writeSettings();
  }

  // A popup can be dismissed mid-drag; don't lose the pending write.
  window.addEventListener("pagehide", flushSave);

  // ---------------------------------------------------------------- events
  masterToggle.addEventListener("change", () => {
    settings.enabled = masterToggle.checked;
    save();
    render();
  });

  siteToggle.addEventListener("change", () => {
    if (currentHost === null) return;
    const index = settings.disabledSites.indexOf(currentHost);
    if (siteToggle.checked && index !== -1) settings.disabledSites.splice(index, 1);
    else if (!siteToggle.checked && index === -1) settings.disabledSites.push(currentHost);
    save();
    render();
  });

  // Slider values come back through normalizeSettings so a wheel/keyboard
  // nudge can't land off the step grid.
  function bindRange(input, key, commit) {
    input.addEventListener("input", () => {
      settings[key] = core.quantize(Number(input.value), LIMITS[key]) ?? settings[key];
      render();
      commit();
    });
    input.addEventListener("change", () => {
      settings[key] = core.quantize(Number(input.value), LIMITS[key]) ?? settings[key];
      render();
      save();
    });
  }

  bindRange(coverage, "coverage", saveSoon);
  bindRange(jitter, "jitter", saveSoon);

  function selectWeight(weight, focus) {
    settings.weight = weight;
    save();
    render();
    if (focus) {
      const button = weightButtons.find((b) => Number(b.dataset.weight) === weight);
      if (button) button.focus();
    }
  }

  weightGroup.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-weight]");
    if (!button) return;
    selectWeight(Number(button.dataset.weight), false);
  });

  // ARIA radio pattern: arrow keys move (and select) within the group.
  weightGroup.addEventListener("keydown", (event) => {
    const delta =
      event.key === "ArrowRight" || event.key === "ArrowDown" ? 1
      : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1
      : 0;
    let index;
    if (delta !== 0) {
      const current = weightButtons.findIndex(
        (b) => Number(b.dataset.weight) === settings.weight
      );
      index = (current + delta + weightButtons.length) % weightButtons.length;
    } else if (event.key === "Home") {
      index = 0;
    } else if (event.key === "End") {
      index = weightButtons.length - 1;
    } else {
      return;
    }
    event.preventDefault();
    selectWeight(Number(weightButtons[index].dataset.weight), true);
  });

  // Reset restores the three appearance dials only: wiping disabledSites
  // would silently switch Embolden back on for sites the user muted.
  resetButton.addEventListener("click", () => {
    settings.coverage = LIMITS.coverage.default;
    settings.weight = LIMITS.weight.default;
    settings.jitter = LIMITS.jitter.default;
    save();
    render();
  });

  // -------------------------------------------------------------- site row
  function disableSiteRow(reason, detail) {
    currentHost = null;
    siteToggle.checked = false;
    siteToggle.disabled = true;
    siteSwitch.title = reason;
    siteHost.textContent = detail;
    siteMonogram.textContent = "—";
  }

  function initSiteRow(tab) {
    const url = tab && tab.url;
    const host = core.hostnameFromUrl(url);
    if (host && !WEBSTORE_HOSTS.has(host)) {
      currentHost = host;
      siteHost.textContent = host;
      siteHost.title = host;
      // Drop a leading "www." so the monogram is the letter people read.
      siteMonogram.textContent = host.replace(/^www\./, "").charAt(0) || "?";
      // Starts disabled in the markup so clicks before the tab is known
      // can't desync the UI.
      siteToggle.disabled = false;
    } else if (typeof url === "string" && url.startsWith("file:")) {
      disableSiteRow(
        "Local files don't have a site to toggle; use the main switch.",
        "Local file"
      );
    } else {
      disableSiteRow("Embolden can't run on this page.", "Not available here");
    }
    render();
  }

  // Keep the popup live if settings change elsewhere (Alt+B, another window).
  // Our own writes echo back through here; ignoring identical values keeps a
  // slider from snapping out from under the user's thumb mid-drag.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync" || !changes.settings) return;
    const next = core.normalizeSettings(changes.settings.newValue);
    if (core.sameSettings(next, settings)) return;
    settings = next;
    render();
  });

  // Paint defaults synchronously so the popup never flashes a range input
  // parked at its midpoint while storage answers.
  render();

  chrome.storage.sync.get("settings", (result) => {
    if (!chrome.runtime.lastError) {
      settings = core.normalizeSettings(result.settings);
    }
    render();
    // activeTab (granted while the popup is open) exposes the URL here.
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      initSiteRow(tabs && tabs[0]);
    });
  });
})();
