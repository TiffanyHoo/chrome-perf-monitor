// popup.js — 查询并渲染当前标签页性能档案
import {
  DEFAULT_THRESHOLDS,
  METRIC_META,
  PHASE_ORDER,
  PHASE_TITLES,
  gradeMetric,
  overallGrade,
  collectAlerts,
  GRADE_COLOR,
  GRADE_TEXT,
  formatValue,
} from "../shared.js";

const SETTINGS_KEY = "settings";

async function getSettings() {
  const r = await chrome.storage.local.get(SETTINGS_KEY);
  const s = r[SETTINGS_KEY] || { thresholds: DEFAULT_THRESHOLDS };
  return { thresholds: { ...DEFAULT_THRESHOLDS, ...(s.thresholds || {}) } };
}

function i18n(msgName, ...sub) {
  return chrome.i18n.getMessage(msgName, sub) || msgName;
}

function applyI18n() {
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = i18n(el.getAttribute("data-i18n"));
  });
}

async function render() {
  applyI18n();
  const rec = await chrome.runtime.sendMessage({ type: "POPUP_QUERY" });
  const settings = await getSettings();
  const empty = document.getElementById("empty");
  const summary = document.getElementById("summary");
  const alertsSec = document.getElementById("alerts");
  const metricsSec = document.getElementById("metrics");

  if (!rec) {
    empty.classList.remove("hidden");
    summary.classList.add("hidden");
    alertsSec.classList.add("hidden");
    metricsSec.classList.add("hidden");
    return;
  }
  empty.classList.add("hidden");

  // ---- summary ----
  const grade = rec.grade || overallGrade(rec.metrics, settings.thresholds);
  const gradeDot = document.getElementById("gradeDot");
  const gradeLabel = document.getElementById("gradeLabel");
  const gradeDesc = document.getElementById("gradeDesc");
  gradeDot.className = "grade-dot " + grade;
  gradeLabel.textContent = i18n("level" + cap(grade));
  const bad = (rec.alerts || []).filter((a) => a.grade === "bad").length;
  const warn = (rec.alerts || []).filter((a) => a.grade === "warn").length;
  gradeDesc.textContent =
    grade === "good" ? "各项指标均在良好区间"
    : `${bad} 项较差 / ${warn} 项需关注`;
  summary.classList.remove("hidden");

  // meta
  const urlEl = document.getElementById("metaUrl");
  urlEl.textContent = rec.url;
  urlEl.title = rec.url;
  document.getElementById("metaTime").textContent = new Date(rec.capturedAt).toLocaleString();

  // ---- alerts ----
  const alerts = rec.alerts || collectAlerts(rec.metrics, settings.thresholds);
  const alertList = document.getElementById("alertList");
  alertList.innerHTML = "";
  if (alerts.length) {
    alertsSec.classList.remove("hidden");
    for (const a of alerts) {
      const li = document.createElement("li");
      li.className = "alert-item";
      li.innerHTML = `
        <span class="alert-dot ${a.grade}"></span>
        <span class="alert-name">${i18n(a.label)}</span>
        <span class="alert-val">${formatValue(a.key, a.value)}</span>`;
      alertList.appendChild(li);
    }
  } else {
    alertsSec.classList.add("hidden");
  }

  // ---- metrics by phase ----
  const groups = document.getElementById("metricGroups");
  groups.innerHTML = "";
  for (const phase of PHASE_ORDER) {
    const keys = Object.keys(METRIC_META).filter((k) => METRIC_META[k].phase === phase);
    if (!keys.length) continue;
    const wrap = document.createElement("div");
    wrap.className = "metric-group";
    const t = document.createElement("div");
    t.className = "metric-group-title";
    t.textContent = PHASE_TITLES[phase] || phase;
    wrap.appendChild(t);
    for (const k of keys) {
      const v = rec.metrics?.[k];
      const g = gradeMetric(k, v, settings.thresholds);
      const row = document.createElement("div");
      row.className = "metric-row";
      row.innerHTML = `
        <span class="metric-name">${i18n(METRIC_META[k].label)}</span>
        <span class="metric-val">${formatValue(k, v)}</span>
        <span class="metric-grade-dot ${g}"></span>`;
      wrap.appendChild(row);
    }
    groups.appendChild(wrap);
  }
  metricsSec.classList.remove("hidden");
}

function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

document.getElementById("recapture").addEventListener("click", async () => {
  const btn = document.getElementById("recapture");
  btn.disabled = true;
  await chrome.runtime.sendMessage({ type: "POPUP_RECAPTURE" });
  // 等待一帧后重新渲染（采集异步）
  setTimeout(render, 800);
  btn.disabled = false;
});

document.getElementById("optionsLink").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

render();
