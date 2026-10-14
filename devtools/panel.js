// panel.js — DevTools 面板逻辑
// 以被检查（inspected）标签页为维度，从 background 拉取性能档案，
// 调用 shared.buildReadableReport 解析成易读报告并渲染。
import {
  DEFAULT_THRESHOLDS,
  METRIC_META,
  PHASE_ORDER,
  PHASE_TITLES,
  PHASE_DESC,
  GRADE_COLOR,
  GRADE_TEXT,
  gradeMetric,
  overallGrade,
  collectAlerts,
  formatValue,
  i18nLabel,
  buildReadableReport,
  analyzeAdvice,
} from "../shared.js";

let tabId = null;
try {
  tabId = chrome.devtools.inspectedWindow.tabId;
} catch { tabId = null; }

const el = (id) => document.getElementById(id);

async function fetchReport() {
  if (tabId == null) return null;
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "PANEL_QUERY", tabId }, (resp) => {
      console.log("[性能报告] PANEL_QUERY resp:", resp);
      console.log("[性能报告] resp.rec:", resp?.rec);
      console.log("[性能报告] resp.rec.topResources:", resp?.rec?.topResources);
      if (chrome.runtime.lastError || !resp) return resolve(null);
      resolve(resp);
    });
  });
}

async function recapture() {
  if (tabId == null) return;
  await chrome.runtime.sendMessage({ type: "PANEL_RECAPTURE", tabId });
}

// 记录上次报告的 URL + capturedAt，用于检测是否有新数据
let lastUrl = null;
let lastCapturedAt = 0;

async function render() {
  const resp = await fetchReport();
  if (!resp || !resp.rec) {
    el("empty").classList.remove("hidden");
    el("report").classList.add("hidden");
    return;
  }
  const { rec, thresholds } = resp;
  const th = { ...DEFAULT_THRESHOLDS, ...(thresholds || {}) };
  const report = buildReadableReport(rec, th, rec.timingRaw || {});

  // 记录当前档案标识
  lastUrl = rec.url;
  lastCapturedAt = rec.capturedAt || 0;

  // 调试输出：方便定位“时间轴数据没出来”到底卡在哪
  try {
    console.log("[性能报告] rec:", rec);
    console.log("[性能报告] timingRaw:", rec.timingRaw);
    console.log("[性能报告] items 有 timeline 的条数:",
      report.items.filter(i => i.timeline).length, "/", report.items.length);
    console.log("[性能报告] timelineMax:", report.timelineMax);
  } catch {}

  el("empty").classList.add("hidden");
  el("report").classList.remove("hidden");

  // target url
  el("targetUrl").textContent = rec.url || "";
  el("targetUrl").title = rec.url || "";

  // summary
  const g = report.grade;
  el("gradeDot").className = "grade-dot " + g;
  el("gradeLabel").textContent = GRADE_TEXT[g] || "—";
  el("gradePill").style.borderColor = GRADE_COLOR[g] || "";
  const badN = report.alerts.filter((a) => a.grade === "bad").length;
  const warnN = report.alerts.filter((a) => a.grade === "warn").length;
  el("summaryText").textContent =
    g === "good" ? "各项指标均处于良好区间，页面性能健康。"
    : g === "unknown" ? "指标尚未采集完整，请重新采集。"
    : `共 ${report.alerts.length} 项异常：${badN} 项较差、${warnN} 项需关注。`;
  el("capTime").textContent = rec.capturedAt ? new Date(rec.capturedAt).toLocaleString() : "—";

  // 诊断结论（最顶部、最有价值）
  renderDiagnosis(report, th);

  // timeline
  renderTimeline(report);

  // 阶段明细表
  renderDetailTable(report);

  // alerts
  renderAlerts(report, th);

  // groups
  renderGroups(report, th);

  // resources
  renderResources(rec);
}

function renderDiagnosis(report, th) {
  const d = report.diagnosis;
  if (!d) return;

  // 一句话总评
  el("verdict").textContent = d.verdict || "—";

  // Core Web Vitals 达标判定
  const vitalMap = [
    { id: "vitalLcp", key: "lcp", label: "LCP", fmt: (v) => v != null ? formatValue("lcp", v) : "—" },
    { id: "vitalCls", key: "cls", label: "CLS", fmt: (v) => v != null ? v.toFixed(3) : "—" },
    { id: "vitalTbt", key: "inp", label: "TBT", fmt: (v) => v != null ? formatValue("tbt", v) : "—" },
  ];
  const passText = { pass: "达标", needs: "需改善", fail: "不达标", unknown: "未采集" };
  for (const vm of vitalMap) {
    const r = d.vitalResults[vm.key];
    const box = el(vm.id);
    box.className = "vital-box " + (r?.pass || "unknown");
    box.querySelector(".vital-value").textContent = vm.fmt(r?.value);
    box.querySelector(".vital-status").textContent = passText[r?.pass || "unknown"];
    box.querySelector(".vital-status").className = "vital-status " + (r?.pass || "unknown");
  }

  // 最大瓶颈
  const bnBox = el("bottleneck");
  if (d.bottleneck) {
    bnBox.classList.remove("hidden");
    const b = d.bottleneck;
    el("bottleneckContent").innerHTML =
      `<b>${b.label}</b>（${formatValue(b.key, b.value)}，${GRADE_TEXT[b.grade]}）` +
      `<br/>${b.what || ""}` +
      `<br/><b>怎么改：</b>${b.howToFix || ""}`;
  } else {
    bnBox.classList.add("hidden");
  }

  // 优先级建议
  const prBox = el("priorities");
  if (d.topPriorities && d.topPriorities.length) {
    prBox.classList.remove("hidden");
    const list = el("priorityList");
    list.innerHTML = "";
    for (const p of d.topPriorities) {
      const li = document.createElement("li");
      li.innerHTML = `<b>${p.label}</b>（${formatValue(p.key, p.value)}）— ${p.howToFix || ""}`;
      list.appendChild(li);
    }
  } else {
    prBox.classList.add("hidden");
  }
}

function renderTimeline(report) {
  const tl = el("timeline");
  tl.innerHTML = "";
  const max = report.timelineMax || 1;
  const barH = 22;
  // 每个阶段一条轨道（按 phase 分组，避免重叠）
  const phases = PHASE_ORDER;
  const totalH = phases.length * (barH + 6) - 6;
  tl.style.height = Math.max(60, totalH) + "px";
  let placed = false;
  phases.forEach((phase, idx) => {
    const items = report.items.filter((i) => i.phase === phase && i.timeline);
    const track = document.createElement("div");
    track.className = "tl-track";
    track.style.top = idx * (barH + 6) + "px";
    track.style.height = barH + "px";
    if (items.length) {
      items.forEach((it) => {
        const left = (it.timeline.start / max) * 100;
        // 0-duration 阶段给最小宽度 0.5%，让用户知道阶段存在
        const w = Math.max(0.5, (it.timeline.dur / max) * 100);
        const bar = document.createElement("div");
        bar.className = "tl-bar " + phase;
        bar.style.left = left + "%";
        bar.style.width = w + "%";
        // 0-duration 显示为细线 + tooltip 说明
        if (it.timeline.dur === 0) {
          bar.style.opacity = "0.4";
          bar.style.borderRight = "1px solid #fff";
          bar.textContent = "";
          bar.title = `${it.name}: 0 ms（阶段跳过，可能是缓存/连接复用）`;
        } else {
          bar.textContent = `${it.name} ${formatValue(it.key, it.value)}`;
          bar.title = `${it.name}: ${formatValue(it.key, it.value)}（${GRADE_TEXT[it.grade]}）`;
        }
        track.appendChild(bar);
        placed = true;
      });
    } else {
      const empty = document.createElement("div");
      empty.className = "tl-empty";
      empty.textContent = `${PHASE_TITLES[phase]}：无时间轴数据`;
      empty.style.fontSize = "11px";
      empty.style.position = "absolute"; empty.style.top = "50%"; empty.style.transform = "translateY(-50%)";
      empty.style.left = "8px";
      track.appendChild(empty);
    }
    tl.appendChild(track);
  });
  if (!placed) {
    tl.innerHTML = `<div class="tl-empty">该页面无可用时间轴数据。可能原因：①这是扩展重载前的旧档案（不含原始时间戳），请「重新采集」；②页面为预渲染/bfcache 恢复（performance.timing 不完整）。</div>`;
    tl.style.height = "48px";
    tl.style.display = "flex"; tl.style.alignItems = "center"; tl.style.justifyContent = "center";
  } else {
    tl.style.display = "";
  }
  el("axisEnd").textContent = max >= 1000 ? (max / 1000).toFixed(2) + " s" : Math.round(max) + " ms";
}

function renderDetailTable(report) {
  const body = el("detailBody");
  body.innerHTML = "";
  for (const it of report.items) {
    const tr = document.createElement("tr");
    const phaseTitle = PHASE_TITLES[it.phase] || it.phase;
    const isZero = it.timeline && it.timeline.dur === 0;
    const gradeTextClass = it.grade === "bad" ? "grade-bad" : it.grade === "warn" ? "grade-warn" : "";
    tr.innerHTML = `
      <td>${phaseTitle}</td>
      <td class="detail-name">${it.name}</td>
      <td class="detail-val">${it.valueText}${isZero ? ' <span class="zero-tag">跳过</span>' : ''}</td>
      <td class="detail-grade ${gradeTextClass}">${GRADE_TEXT[it.grade]}</td>
      <td class="detail-what">${it.what || ''}</td>`;
    body.appendChild(tr);
  }
}

function renderAlerts(report, th) {
  const card = el("alertsCard");
  const list = el("alertList");
  list.innerHTML = "";
  if (!report.alerts.length) {
    card.classList.add("hidden");
    return;
  }
  card.classList.remove("hidden");
  for (const a of report.alerts) {
    const meta = METRIC_META[a.key];
    const row = document.createElement("div");
    row.className = "alert-row";
    row.innerHTML = `
      <span class="alert-dot ${a.grade}"></span>
      <span class="alert-name">${i18nLabel(meta.label)}</span>
      <span class="alert-val">${formatValue(a.key, a.value)}</span>
      <span class="alert-grade">${GRADE_TEXT[a.grade]}（${formatTh(a.key, th)}）</span>`;
    list.appendChild(row);
  }
}

function formatTh(key, th) {
  const t = th[key];
  if (!t) return "—";
  if (key === "cls") return `良好≤${t.goodMax} / 关注≤${t.warnMax}`;
  return `良好≤${t.goodMax} / 关注≤${t.warnMax} ms`;
}

function renderGroups(report, th) {
  const groups = el("groups");
  groups.innerHTML = "";
  for (const phase of PHASE_ORDER) {
    const items = report.items.filter((i) => i.phase === phase);
    if (!items.length) continue;
    const wrap = document.createElement("div");
    wrap.className = "group";
    const t = document.createElement("div");
    t.className = "group-title";
    t.textContent = `${PHASE_TITLES[phase]} — ${PHASE_DESC[phase] || ""}`;
    wrap.appendChild(t);
    for (const it of items) {
      const row = document.createElement("div");
      row.className = "metric-row";
      const head = document.createElement("div");
      head.className = "metric-head";
      head.innerHTML = `
        <span class="metric-dot ${it.grade}"></span>
        <span class="metric-name">${it.name}</span>
        <span class="metric-val">${it.valueText}</span>
        <span class="metric-th">${formatTh(it.key, th)}</span>`;
      // chevron
      const chev = document.createElement("span");
      chev.className = "metric-chev";
      chev.textContent = "▶";
      head.appendChild(chev);
      head.addEventListener("click", () => row.classList.toggle("open"));

      const body = document.createElement("div");
      body.className = "metric-body";
      // 动态建议：根据实际数据组合分析，非写死文案
      const dynamicFix = analyzeAdvice(it.key, report.metrics || {}, report.diagnosis?.networkSlow);
      body.innerHTML = `
        <div class="metric-section">
          <div class="metric-section-title">这是什么</div>
          <div class="metric-section-text">${it.what || "—"}</div>
        </div>
        <div class="metric-section">
          <div class="metric-section-title">为什么会慢</div>
          <div class="metric-section-text">${it.whySlow || "—"}</div>
        </div>
        <div class="metric-section">
          <div class="metric-section-title">当前页面的具体建议</div>
          <div class="metric-section-text metric-howto">${dynamicFix || "该指标在良好区间，无需特别优化。"}</div>
        </div>`;
      row.appendChild(head);
      row.appendChild(body);
      wrap.appendChild(row);
    }
    groups.appendChild(wrap);
  }
}

function renderResources(rec) {
  const card = el("resCard");
  const body = el("resBody");
  body.innerHTML = "";
  const res = rec.topResources || [];
  console.log("[性能报告] topResources:", res);
  if (!res.length) {
    card.classList.remove("hidden");
    body.innerHTML = `<tr><td colspan="4" class="res-empty">未采集到资源数据。可能原因：页面无外部资源，或 performance API 不可用。</td></tr>`;
    return;
  }
  card.classList.remove("hidden");
  const maxSize = Math.max(1, ...res.map((r) => r.size || 0));
  for (const r of res) {
    const tr = document.createElement("tr");
    const name = r.name || "";
    const pct = (r.size || 0) / maxSize * 100;
    const sizeText = r.size > 0 ? formatBytes(r.size) : '0 (跨域)';
    const durText = r.duration > 0 ? (r.duration >= 1000 ? (r.duration / 1000).toFixed(2) + ' s' : Math.round(r.duration) + ' ms') : '—';
    tr.innerHTML = `
      <td class="res-name" title="${escapeHtml(name)}">${escapeHtml(shortRes(name))}</td>
      <td>${r.initiatorType || "—"}</td>
      <td class="res-size">${sizeText}</td>
      <td class="res-bar-cell"><span class="res-dur">${durText}</span><div class="res-bar" style="width:${pct}%"></div></td>`;
    body.appendChild(tr);
  }
}

function shortRes(url) {
  try {
    const u = new URL(url, location.href);
    return (u.host + u.pathname).slice(0, 80);
  } catch {
    return (url || "").slice(0, 80);
  }
}
function formatBytes(n) {
  if (!n) return "—";
  const kb = n / 1024;
  if (kb >= 1024) return (kb / 1024).toFixed(2) + " MB";
  return kb.toFixed(1) + " KB";
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// 按钮
el("recapture").addEventListener("click", async () => {
  el("recapture").disabled = true;
  await recapture();
  setTimeout(render, 900);
  el("recapture").disabled = false;
});
el("refresh").addEventListener("click", render);

// 初次渲染
render();

// 页面导航/刷新后：轮询等待新数据（不再用固定延迟，因为页面可能加载很慢）
let navPollTimer = null;
try {
  chrome.devtools.network.onNavigated.addListener(() => {
    // 清掉旧的轮询
    if (navPollTimer) clearInterval(navPollTimer);
    // 导航后每隔 1 秒检查一次，直到拿到新数据（URL 变了或 capturedAt 变了），最多等 30 秒
    const startTime = Date.now();
    const prevUrl = lastUrl;
    const prevCap = lastCapturedAt;
    navPollTimer = setInterval(async () => {
      const resp = await fetchReport();
      const newRec = resp?.rec;
      // 拿到新数据：URL 变了，或 capturedAt 比上次新
      if (newRec && (newRec.url !== prevUrl || (newRec.capturedAt || 0) > prevCap)) {
        clearInterval(navPollTimer);
        navPollTimer = null;
        render();
      }
      // 超时 30 秒放弃
      if (Date.now() - startTime > 30000) {
        clearInterval(navPollTimer);
        navPollTimer = null;
      }
    }, 1000);
  });
} catch {}

// 监听存储变化（content 上报后自动刷新）
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.perfByTab) render();
});
