"use strict";

// Popup logic. Reads/writes the single "settings" key in chrome.storage.sync;
// content scripts pick changes up via chrome.storage.onChanged. core.js is
// loaded first via <script>, so EmboldenCore is on globalThis.
(() => {
  const core = globalThis.EmboldenCore;

  const PREVIEW_TEXT =
    "Embolden guides your eyes with gentle anchors at the start of every word, so longer passages are easier to follow.";

  // Content scripts can't run on the Web Store even though the URL is https.
  const WEBSTORE_HOSTS = new Set(["chromewebstore.google.com", "chrome.google.com"]);

  const masterToggle = document.getElementById("master-toggle");
  const siteToggle = document.getElementById("site-toggle");
  const siteSwitch = document.getElementById("site-switch");
  const siteHost = document.getElementById("site-host");
  const strengthGroup = document.getElementById("strength-group");
  const strengthButtons = Array.from(strengthGroup.querySelectorAll("button"));
  const preview = document.getElementById("preview");

  let settings = core.normalizeSettings(null);
  // null until the active tab is known; stays null on unsupported pages.
  let currentHost = null;

  function siteEnabled() {
    return currentHost !== null && !settings.disabledSites.includes(currentHost);
  }

  function renderPreview() {
    const ratio = core.ratioForStrength(settings.strength);
    const parts = core.processText(PREVIEW_TEXT, ratio, "en");
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
    const effectivelyOn =
      settings.enabled && (currentHost === null || siteEnabled());
    preview.classList.toggle("off", !effectivelyOn);
  }

  function render() {
    masterToggle.checked = settings.enabled;
    siteToggle.checked = siteEnabled();
    for (const button of strengthButtons) {
      button.setAttribute(
        "aria-checked",
        button.dataset.strength === settings.strength ? "true" : "false"
      );
    }
    renderPreview();
  }

  function save() {
    chrome.storage.sync.set({ settings });
  }

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

  strengthGroup.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-strength]");
    if (!button) return;
    settings.strength = button.dataset.strength;
    save();
    render();
  });

  function disableSiteRow(reason) {
    currentHost = null;
    siteToggle.checked = false;
    siteToggle.disabled = true;
    siteSwitch.title = reason;
    siteHost.textContent = "Not available on this page";
  }

  function initSiteRow(tab) {
    const url = tab && tab.url;
    const host = core.hostnameFromUrl(url);
    if (host && !WEBSTORE_HOSTS.has(host)) {
      currentHost = host;
      siteHost.textContent = host;
    } else if (typeof url === "string" && url.startsWith("file:")) {
      disableSiteRow("Local files don't have a site to toggle; use the main switch.");
    } else {
      disableSiteRow("Embolden can't run on this page.");
    }
    render();
  }

  // Keep the popup live if settings change elsewhere (Alt+B, another window).
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync" || !changes.settings) return;
    settings = core.normalizeSettings(changes.settings.newValue);
    render();
  });

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
