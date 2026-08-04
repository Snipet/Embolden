"use strict";

// Embolden service worker. Two jobs only:
//   1. Seed/normalize settings on install.
//   2. Keyboard command → toggle the current site in disabledSites.
// Content scripts react via chrome.storage.onChanged — the worker never
// messages tabs directly.

importScripts("core.js");

const core = globalThis.EmboldenCore;

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get("settings", (result) => {
    if (chrome.runtime.lastError) return;
    // Seeds defaults on first install; on update, migrates any stored
    // value through normalizeSettings (schema is versioned via "v").
    chrome.storage.sync.set({ settings: core.normalizeSettings(result.settings) });
  });
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== "toggle-site") return;
  let target = tab;
  if (!target || !target.url) {
    // activeTab is granted by the keyboard-shortcut invocation, so the
    // active tab's URL is readable here.
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    target = tabs && tabs[0];
  }
  const host = core.hostnameFromUrl(target && target.url);
  if (!host) return;
  const result = await chrome.storage.sync.get("settings");
  const settings = core.normalizeSettings(result.settings);
  const index = settings.disabledSites.indexOf(host);
  if (index === -1) settings.disabledSites.push(host);
  else settings.disabledSites.splice(index, 1);
  await chrome.storage.sync.set({ settings });
});
