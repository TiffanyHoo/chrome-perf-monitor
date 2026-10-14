// shared.js — 性能指标定义、阈值、告警判定、可读报告生成
// 被 background.js / popup.js / devtools panel 复用（ES module）。

// 默认阈值（单位 ms；CLS 无量纲；TBT ms）。good <= goodMax <= warnMax => warn => bad。
export const DEFAULT_THRESHOLDS = {
  load:        { goodMax: 2500, warnMax: 4000 },   // 页面完全加载
  dns:         { goodMax: 50,   warnMax: 200 },    // DNS 查询
  tcp:         { goodMax: 50,   warnMax: 200 },    // TCP 连接
  ssl:         { goodMax: 100,  warnMax: 300 },    // SSL 握手
  request:     { goodMax: 300,  warnMax: 800 },    // 请求等待
  response:    { goodMax: 500,  warnMax: 1500 },   // 响应传输
  domParse:    { goodMax: 800,  warnMax: 2000 },   // DOM 解析
  domReady:    { goodMax: 1500, warnMax: 3500 },   // DOMContentLoaded
  interactive: { goodMax: 2500, warnMax: 4500 },   // 可交互
  fcp:         { goodMax: 1800, warnMax: 3000 },   // 首次内容绘制
  lcp:         { goodMax: 2500, warnMax: 4000 },   // 最大内容绘制
  tbt:         { goodMax: 200,  warnMax: 600 },    // 总阻塞时间
  ttfb:        { goodMax: 500,  warnMax: 1000 },   // 首字节时间
  cls:         { goodMax: 0.1,  warnMax: 0.25 },   // 累计布局偏移（无量纲）
};

// 展示用的指标元信息：key -> { label, duration, phase, what, whySlow, howToFix, timelineStart/timelineEnd }
// timelineStart/End 用于在时间轴上绘制阶段块（相对 navigationStart 的毫秒）。
export const METRIC_META = {
  // ---- 网络阶段 ----
  dns: {
    label: "metricDns", duration: true, phase: "network",
    timelineStart: "domainLookupStart", timelineEnd: "domainLookupEnd",
    what: "浏览器把域名解析成 IP 地址所用的时间。这一步发生在建立连接之前。",
    whySlow: "常见原因：本地/递归 DNS 缓存未命中、域名首次访问、DNS 服务器响应慢、页面用了大量不同域名的资源。",
    howToFix: "启用并复用 DNS 预解析（<link rel=dns-prefetch>）；减少第三方资源域名数量；对稳定资源域名增加 DNS 缓存时间（TTL）；使用稳定快速的 DNS 服务。",
  },
  tcp: {
    label: "metricTcp", duration: true, phase: "network",
    timelineStart: "connectStart", timelineEnd: "connectEnd",
    what: "浏览器与服务器建立 TCP 连接（三次握手）所用的时间。不含 TLS/SSL。",
    whySlow: "常见原因：跨地域访问导致 RTT 高、连接复用未生效（每请求新建连接）、网络链路质量差。",
    howToFix: "启用 keep-alive 连接复用；使用 HTTP/2 或 HTTP/3（多路复用，少握手）；把关键资源与服务端就近部署（CDN）。",
  },
  ssl: {
    label: "metricSsl", duration: true, phase: "network",
    timelineStart: "secureConnectionStart", timelineEnd: "connectEnd",
    what: "TLS/SSL 安全握手所用时间（从开始安全连接到连接就绪）。仅 HTTPS 页面有值。",
    whySlow: "常见原因：证书链过长、OCSP 在线校验、未启用会话恢复、服务器未启用 TLS 1.3/0-RTT。",
    howToFix: "启用 TLS 1.3；配置证书链（中间证书随服务端下发）；启用会话恢复与 OCSP Stapling；就近部署 TLS 终端。",
  },
  ttfb: {
    label: "metricTtfb", duration: true, phase: "network",
    timelineStart: "requestStart", timelineEnd: "responseStart",
    what: "首字节时间：从发出文档请求到收到响应第一个字节的时间。它=服务器处理+网络往返，是后端/链路最直观的体检指标。",
    whySlow: "常见原因：服务器动态渲染慢、数据库/下游服务慢、RTT 高、未启用缓存或边缘计算。",
    howToFix: "对可缓存页面启用 CDN 边缘缓存；后端接口异步化、消除 N+1 查询；引入对象缓存与页面缓存；把动态内容拆分让首屏可秒出。",
  },
  request: {
    label: "metricRequest", duration: true, phase: "network",
    timelineStart: "requestStart", timelineEnd: "responseStart",
    what: "请求等待：发出文档请求到开始收到响应的时间（含 TTFB 的等待部分，不含传输）。衡量服务器响应快慢。",
    whySlow: "同 TTFB：服务器处理慢、排队、上游依赖慢、冷启动。",
    howToFix: "同 TTFB：边缘缓存、后端提速、预热避免冷启动。",
  },
  response: {
    label: "metricResponse", duration: true, phase: "network",
    timelineStart: "responseStart", timelineEnd: "responseEnd",
    what: "响应传输：从收到首字节到文档下载完成的时间。主要受 HTML 体积与网络带宽影响。",
    whySlow: "HTML 过大（服务端渲染大量内联数据）、网络带宽不足、未压缩。",
    howToFix: "启用 gzip/brotli 压缩；精简首屏 HTML、不在文档里内联大块 JSON；流式输出（尽早 flush <head> 让浏览器并行加载资源）。",
  },
  // ---- DOM 阶段 ----
  domParse: {
    label: "metricDomParse", duration: true, phase: "dom",
    timelineStart: "domLoading", timelineEnd: "domInteractive",
    what: "浏览器把 HTML 解析成 DOM 树所用的时间。HTML 越大、同步脚本越多，解析越慢。",
    whySlow: "HTML 体积大、同步 <script> 阻塞解析、大量内联样式/数据、嵌套过深。",
    howToFix: "给非首屏脚本加 defer/async；拆分超大 HTML；移除内联大 JSON；减少 DOM 节点数（虚拟列表）。",
  },
  interactive: {
    label: "metricDomInteractive", duration: true, phase: "dom",
    timelineStart: "navigationStart", timelineEnd: "domInteractive",
    what: "可交互时间：从导航开始到 DOM 可交互（domInteractive）的时间，约等于“用户能开始点”的时刻。",
    whySlow: "网络+解析+同步脚本综合偏慢，常是首屏脚本阻塞所致。",
    howToFix: "优先保证首屏可交互：关键脚本同步/内联，非关键脚本 defer；减少首屏 JS 体积。",
  },
  domReady: {
    label: "metricDomReady", duration: true, phase: "dom",
    timelineStart: "domContentLoadedEventStart", timelineEnd: "domContentLoadedEventEnd",
    what: "DOMContentLoaded 事件处理耗时。该事件触发时 DOM 已就绪，常被业务框架的初始化占用。",
    whySlow: "DOMContentLoaded 回调里做了大量同步初始化（框架 bootstrap、监听绑定、数据预水合）。",
    howToFix: "把非首屏初始化拆到 requestIdleCallback/微任务延后；按需初始化子模块；避免在 DOMReady 同步拉取数据。",
  },
  // ---- 页面整体 ----
  load: {
    label: "metricLoad", duration: true, phase: "page",
    timelineStart: "navigationStart", timelineEnd: "loadEventEnd",
    what: "页面完全加载：从导航开始到 load 事件结束。包含所有资源加载与 load 回调。是“整页就绪”的总耗时。",
    whySlow: "通常是网络资源多/大、脚本阻塞、第三方资源慢的叠加结果。",
    howToFix: "拆分首屏与次屏资源；延迟加载图片/iframe（loading=lazy）；预连接关键第三方域名；删除无用资源。",
  },
  transferSize: {
    label: "metricTransferSize", duration: false, phase: "page",
    what: "本次文档请求的传输体积（压缩后字节数）。反映首屏文档的体积压力。",
    whySlow: "HTML 内联了大量数据、未压缩、包含冗余注释/样式。",
    howToFix: "启用压缩；把大块数据移到后续异步请求；精简模板。",
  },
  // ---- Web Vitals ----
  fcp: {
    label: "metricFcp", duration: true, phase: "vitals",
    what: "首次内容绘制：用户看到页面任何文本/图片/非白屏内容的时间。代表“不是白屏了”。",
    whySlow: "文档体积大、首字节慢、阻塞渲染的 CSS/字体、服务端渲染慢。",
    howToFix: "内联关键 CSS； preload 关键字体/图片；尽早 flush <head>；减少首屏 DOM。",
  },
  lcp: {
    label: "metricLcp", duration: true, phase: "vitals",
    what: "最大内容绘制：视口内最大元素（通常主图/大标题/大文本块）完成渲染的时间。是“首屏主要内容可见”的核心体验指标。",
    whySlow: "首屏大图加载慢、首字节慢、阻塞渲染的 CSS/JS、字体加载阻塞、图片未优化。",
    howToFix: "preload 首屏主图；优化图片（WebP/AVIF、合适尺寸）；内联关键 CSS；延迟非首屏 JS；给图片设 width/height 避免布局位移。",
  },
  cls: {
    label: "metricCls", duration: false, phase: "vitals",
    what: "累计布局偏移：页面生命周期内，可见内容意外移动的累计分数（0 最稳）。衡量“视觉稳定性”——内容乱跳最伤体验。",
    whySlow: "图片/广告/嵌入无尺寸导致重排、动态插入内容把已有内容推开、字体替换导致文字位移。",
    howToFix: "给所有图片/iframe 设 width/height；预留广告/动态区占位；使用 font-display:optional 或预加载字体；避免在已渲染内容上方插入节点。",
  },
  tbt: {
    label: "metricTbt", duration: true, phase: "vitals",
    what: "总阻塞时间：FCP 与可交互之间，主线程被长任务（>50ms）阻塞的累计时长。代表“页面看着好了但点不动”。",
    whySlow: "首屏 JS 体积大、长任务多、第三方脚本抢占主线程、布局抖动。",
    howToFix: "拆分/延迟非首屏 JS；把长任务切片（scheduler.yield/setTimeout 分片）；减少首屏第三方脚本；用 requestIdleCallback 做次要工作。",
  },
};

export const PHASE_ORDER = ["network", "dom", "page", "vitals"];
export const PHASE_TITLES = {
  network: "网络阶段",
  dom: "DOM 阶段",
  page: "页面整体",
  vitals: "Web Vitals",
};
export const PHASE_DESC = {
  network: "从浏览器开始取文档到文档下载完成。",
  dom: "浏览器解析 HTML 并就绪 DOM 的过程。",
  page: "整页加载与传输体积。",
  vitals: "Google 推荐的用户体验核心指标。",
};

// 单指标定级：'good' | 'warn' | 'bad' | 'unknown'
export function gradeMetric(key, value, thresholds) {
  if (value === null || value === undefined || Number.isNaN(value)) return "unknown";
  const th = thresholds[key];
  if (!th) return "unknown";
  if (value <= th.goodMax) return "good";
  if (value <= th.warnMax) return "warn";
  return "bad";
}

// 整体定级：取所有已采集指标中最差的一级
export function overallGrade(metrics, thresholds) {
  const order = { good: 1, unknown: 1, warn: 2, bad: 3 };
  let worst = "good";
  for (const k of Object.keys(metrics)) {
    if (!METRIC_META[k]) continue;
    const g = gradeMetric(k, metrics[k], thresholds);
    if (order[g] > order[worst]) worst = g;
  }
  return worst === "good" && Object.values(metrics).every((v) => v === null || v === undefined)
    ? "unknown"
    : worst;
}

export const GRADE_COLOR = { good: "#22c55e", warn: "#f59e0b", bad: "#ef4444", unknown: "#9ca3af" };
export const GRADE_TEXT = { good: "良好", warn: "需关注", bad: "较差", unknown: "未知" };

// 生成告警条目（仅在 bad/warn 且启用该指标时返回）
export function collectAlerts(metrics, thresholds) {
  const alerts = [];
  for (const k of Object.keys(metrics)) {
    const meta = METRIC_META[k];
    if (!meta) continue;
    const v = metrics[k];
    const g = gradeMetric(k, v, thresholds);
    if (g === "bad" || g === "warn") {
      alerts.push({ key: k, value: v, grade: g, label: meta.label });
    }
  }
  alerts.sort((a, b) => (a.grade === b.grade ? 0 : a.grade === "bad" ? -1 : 1));
  return alerts;
}

// 数值格式化：duration -> "1.23 s" 或 "456 ms"；CLS -> 两位小数；bytes -> KB/MB
export function formatValue(key, value) {
  const meta = METRIC_META[key];
  if (value === null || value === undefined) return "—";
  if (meta && meta.duration) {
    if (value >= 1000) return (value / 1000).toFixed(2) + " s";
    return Math.round(value) + " ms";
  }
  if (key === "cls") return value.toFixed(3);
  if (key === "transferSize") {
    const kb = value / 1024;
    if (kb >= 1024) return (kb / 1024).toFixed(2) + " MB";
    return kb.toFixed(1) + " KB";
  }
  return String(value);
}

// i18n 取标签（面板/popup 都可用，带兜底）
export function i18nLabel(msgName) {
  try {
    return chrome.i18n.getMessage(msgName) || msgName;
  } catch {
    return msgName;
  }
}

// 构建一份可读报告：每指标含 name/value/grade/what/whySlow/howToFix/timeline
// rec 是 background 存的 PerTabRecord；timingRaw 可选，用于时间轴坐标。
export function buildReadableReport(rec, thresholds, timingRaw) {
  const metrics = rec?.metrics || {};
  const t = timingRaw || {};
  // navigationStart 作为时间轴的 0 点（performance.timing 的值是绝对 Unix 时间戳）
  const navStart = t.navigationStart || 0;
  const TL = (k) => {
    const meta = METRIC_META[k];
    if (!meta || !meta.timelineStart) return null;
    const s = t[meta.timelineStart];
    const e = t[meta.timelineEnd];
    if (s == null || e == null || e < s || !s || !e) return null;
    // 转成相对 navigationStart 的相对时间（ms）
    return { start: s - navStart, end: e - navStart, dur: e - s };
  };
  const items = [];
  for (const phase of PHASE_ORDER) {
    const keys = Object.keys(METRIC_META).filter((k) => METRIC_META[k].phase === phase);
    for (const k of keys) {
      const meta = METRIC_META[k];
      const v = metrics[k] ?? null;
      const g = gradeMetric(k, v, thresholds);
      const tl = TL(k);
      items.push({
        key: k,
        phase,
        name: i18nLabel(meta.label),
        value: v,
        valueText: formatValue(k, v),
        grade: g,
        what: meta.what,
        whySlow: meta.whySlow,
        howToFix: meta.howToFix,
        timeline: tl,
        duration: meta.duration,
      });
    }
  }
  const grade = overallGrade(metrics, thresholds);
  const alerts = collectAlerts(metrics, thresholds);
  return {
    url: rec?.url,
    title: rec?.title,
    capturedAt: rec?.capturedAt,
    grade,
    alerts,
    items,
    // 时间轴总跨度：取所有 timeline end 的最大值（至少 1ms）
    timelineMax: Math.max(1, ...items.map((i) => i.timeline?.end ?? 0)),
  };
}
