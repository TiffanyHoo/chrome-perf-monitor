// background.js — MV3 service worker
// 职责：
//  1) 维护每个标签页的最新性能档案（per-tab dimension）
//  2) 监听 webNavigation：页面刷新/导航 → 触发 content script 重新采集（自动重分析）
//  3) 收到 content script 上报 → 判定告警 → 更新徽标 + 桌面通知
//  4) 提供 popup 查询当前标签页档案

import {
  DEFAULT_THRESHOLDS,
  overallGrade,
  collectAlerts,
  GRADE_COLOR,
} from "./shared.js";

const STORE_KEY = "perfByTab";        // { [tabId]: PerTabRecord }
const SETTINGS_KEY = "settings";      // { thresholds, badge, autoAnalyze }
const NAV_RESET_KEY = "navReset";    // { [tabId]: bool } 标记本轮导航是"刷新"需重采

function recompute(metrics, thresholds) {
  const grade = overallGrade(metrics, thresholds);
  const alerts = collectAlerts(metrics, thresholds);
  return { grade, alerts };
}

async function getSettings() {
  const cur = await chrome.storage.local.get(SETTINGS_KEY);
  if (cur[SETTINGS_KEY]) return { ...defaultSettings(), ...cur[SETTINGS_KEY] };
  return defaultSettings();
}
function defaultSettings() {
  return {
    thresholds: structuredClone(DEFAULT_THRESHOLDS),
    badge: true,
    autoAnalyze: true,
  };
}
async function getStore() {
  const r = await chrome.storage.local.get(STORE_KEY);
  return r[STORE_KEY] || {};
}
async function saveStore(store) {
  await chrome.storage.local.set({ [STORE_KEY]: store });
}

// ---- 标签页档案写入 ----
async function recordPerf(tabId, payload) {
  const store = await getStore();
  const settings = await getSettings();
  const rec = {
    tabId,
    url: payload.url,
    title: payload.title || payload.url,
    capturedAt: payload.capturedAt || Date.now(),
    metrics: payload.metrics,
    grade: payload.grade,
    alerts: payload.alerts,
    timingRaw: payload.timingRaw || null,
    topResources: payload.topResources || [],
  };
  store[tabId] = rec;
  await saveStore(store);
  // 徽标（轻量，不打扰）
  await updateBadge(tabId, rec, settings);
}

async function updateBadge(tabId, rec, settings) {
  if (!settings.badge) {
    chrome.action.setBadgeText({ tabId, text: "" });
    return;
  }
  const color = GRADE_COLOR[rec.grade] || GRADE_COLOR.unknown;
  chrome.action.setBadgeBackgroundColor({ tabId, color });
  // 文本：bad 显示告警数，warn 显示“!”，good 显示空（不打扰）
  let text = "";
  if (rec.grade === "bad") text = String((rec.alerts || []).length || "");
  else if (rec.grade === "warn") text = "!";
  chrome.action.setBadgeText({ tabId, text });
}

// ---- 接收 content script 上报 ----
// 注意：onMessage 只保留两个 listener。这里只处理 PERF_REPORT；
// 其它查询/重采统一在下面的 listener 处理，避免多 listener 争抢 sendResponse。
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg && msg.type === "PERF_REPORT" && sender.tab) {
      const tabId = sender.tab.id;
      const settings = await getSettings();
      const { grade, alerts } = recompute(msg.payload.metrics, settings.thresholds);
      await recordPerf(tabId, { ...msg.payload, grade, alerts });
      sendResponse({ ok: true });
    }
    // 其它类型交给下面的 listener；这里不 sendResponse 以免抢占
  })();
  return true; // async
});

// ---- 刷新/导航 → 自动重新采集 ----
// webNavigation.onCommitted：新导航（含刷新）开始时，通知 content 在 load 后重采
chrome.webNavigation.onCommitted.addListener(
  (details) => {
    if (details.frameId !== 0) return;
    // 标记该 tab 需要在本轮重新采集；content 端在 load 后会主动采集
    chrome.storage.local.get(NAV_RESET_KEY).then((r) => {
      const m = r[NAV_RESET_KEY] || {};
      m[details.tabId] = true;
      chrome.storage.local.set({ [NAV_RESET_KEY]: m });
    });
  },
  { url: [{ schemes: ["http", "https", "file"] }] }
);

// 标签关闭时清理档案
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const store = await getStore();
  if (store[tabId]) {
    delete store[tabId];
    await saveStore(store);
  }
  const r = await chrome.storage.local.get(NAV_RESET_KEY);
  const m = r[NAV_RESET_KEY] || {};
  if (m[tabId]) {
    delete m[tabId];
    chrome.storage.local.set({ [NAV_RESET_KEY]: m });
  }
});

// popup / panel 主动查询档案（popup 无法直接拿 service worker 内存）。
// devtools 面板用它按 inspectedTabId 拉取对应标签页档案。
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (!msg) return sendResponse(null);
    if (msg.type === "POPUP_QUERY") {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) return sendResponse(null);
      const store = await getStore();
      sendResponse(store[tab.id] || null);
    } else if (msg.type === "PANEL_QUERY") {
      // 面板按 inspected tabId 查询（不依赖 currentWindow 的 active tab）
      const tabId = msg.tabId;
      console.log("[background] PANEL_QUERY tabId:", tabId);
      if (tabId == null) return sendResponse(null);
      const store = await getStore();
      console.log("[background] store[tabId]:", store[tabId]);
      console.log("[background] store[tabId]?.topResources:", store[tabId]?.topResources);
      const settings = await getSettings();
      sendResponse({ rec: store[tabId] || null, thresholds: settings.thresholds });
    } else if (msg.type === "POPUP_RECAPTURE" || msg.type === "PANEL_RECAPTURE") {
      const targetTabId =
        msg.type === "PANEL_RECAPTURE" ? msg.tabId : (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
      if (!targetTabId) return sendResponse({ ok: false });
      try {
        await chrome.scripting.executeScript({
          target: { tabId: targetTabId },
          func: () => { window.__perfMonitorCapture && window.__perfMonitorCapture(true); },
        });
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    }
  })();
  return true;
});

// 启动时：清理已不存在标签页的残留档案
chrome.runtime.onStartup.addListener(cleanupStaleTabs);
chrome.runtime.onInstalled.addListener(cleanupStaleTabs);

async function cleanupStaleTabs() {
  const store = await getStore();
  const live = await chrome.tabs.query({});
  const liveIds = new Set(live.map((t) => t.id));
  let changed = false;
  for (const id of Object.keys(store)) {
    if (!liveIds.has(Number(id))) {
      delete store[id];
      changed = true;
    }
  }
  if (changed) await saveStore(store);
}
