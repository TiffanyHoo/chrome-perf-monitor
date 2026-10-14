// options.js — 阈值配置
import { DEFAULT_THRESHOLDS, METRIC_META } from "../shared.js";

const SETTINGS_KEY = "settings";
const THRESH_KEYS = Object.keys(DEFAULT_THRESHOLDS);

function i18n(name) { return chrome.i18n.getMessage(name) || name; }

function applyI18n() {
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = i18n(el.getAttribute("data-i18n"));
  });
}

async function load() {
  applyI18n();
  const r = await chrome.storage.local.get(SETTINGS_KEY);
  const s = r[SETTINGS_KEY] || {};
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(s.thresholds || {}) };
  document.getElementById("optBadge").checked = s.badge !== false;
  document.getElementById("optAutoAnalyze").checked = s.autoAnalyze !== false;

  const tb = document.getElementById("tbody");
  tb.innerHTML = "";
  for (const k of THRESH_KEYS) {
    const meta = METRIC_META[k];
    const unit = k === "cls" ? "—" : "ms";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${i18n(meta.label)}</td>
      <td><input type="number" step="any" data-k="${k}" data-l="goodMax" value="${thresholds[k].goodMax}" /></td>
      <td><input type="number" step="any" data-k="${k}" data-l="warnMax" value="${thresholds[k].warnMax}" /></td>
      <td>${unit}</td>`;
    tb.appendChild(tr);
  }
}

async function save() {
  const r = await chrome.storage.local.get(SETTINGS_KEY);
  const s = r[SETTINGS_KEY] || {};
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(s.thresholds || {}) };
  document.querySelectorAll("#tbody input").forEach((inp) => {
    const k = inp.dataset.k; const l = inp.dataset.l;
    const v = parseFloat(inp.value);
    if (!Number.isNaN(v)) thresholds[k][l] = v;
  });
  const next = {
    thresholds,
    badge: document.getElementById("optBadge").checked,
    autoAnalyze: document.getElementById("optAutoAnalyze").checked,
  };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  const saved = document.getElementById("saved");
  saved.classList.remove("hidden");
  setTimeout(() => saved.classList.add("hidden"), 1500);
}

document.getElementById("save").addEventListener("click", save);
load();
