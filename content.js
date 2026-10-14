// content.js — 页面端性能采集
// 采集内容：
//   Navigation Timing（DNS/TCP/SSL/请求/响应/DOM解析/可交互/DOMReady/Load）
//   Web Vitals：FCP、LCP、CLS、TBT（TBT 由 longtask 近似）
//   资源传输体积（transferSize, from NavigationEntry）
// 触发时机：
//   1) 页面 load 事件后自动采集一次（首次打开）
//   2) 检测到 webNavigation 标记的"刷新"标记 → 重新采集（自动重分析）
//   3) popup 调用 window.__perfMonitorCapture(true) 手动重采
// 注意：为避免数据残缺（如 loadEventEnd 尚未就绪），延迟到 load 之后 + 兜底轮询。

(() => {
  "use strict";

  const NAV_RESET_KEY = "navReset";
  let capturedForThisNav = false; // 当前导航是否已采集过（防止重复）
  let clsValue = 0;               // 累计布局偏移
  let lcpValue = 0;               // 最大内容绘制
  let tbtValue = 0;               // 总阻塞时间 (ms)
  let fcpValue = 0;
  let clsEntries = [];
  let lcpObserver = null;
  let clsObserver = null;
  let longTaskObserver = null;

  // ---- Web Vitals 观察者（在脚本注入时即启动，捕获整页生命周期）----
  function setupVitalsObservers() {
    try {
      // LCP
      if ("PerformanceObserver" in self && PerformanceObserver.supportedEntryTypes?.includes("largest-contentful-paint")) {
        lcpObserver = new PerformanceObserver((list) => {
          const entries = list.getEntries();
          const last = entries[entries.length - 1];
          if (last) lcpValue = last.startTime;
        });
        lcpObserver.observe({ type: "largest-contentful-paint", buffered: true });
      }
      // CLS（session 窗口聚合）
      if ("PerformanceObserver" in self && PerformanceObserver.supportedEntryTypes?.includes("layout-shift")) {
        clsObserver = new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            if (!e.hadRecentInput) {
              clsValue += e.value;
              clsEntries.push(e.value);
            }
          }
        });
        clsObserver.observe({ type: "layout-shift", buffered: true });
      }
      // TBT 近似：longtask 超过 50ms 的部分累加
      if ("PerformanceObserver" in self && PerformanceObserver.supportedEntryTypes?.includes("longtask")) {
        longTaskObserver = new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            tbtValue += Math.max(0, e.duration - 50);
          }
        });
        longTaskObserver.observe({ type: "longtask", buffered: true });
      }
    } catch (e) {
      // 某些页面不支持，忽略
    }
  }

  // ---- 读取 Navigation Timing，拆分阶段 ----
  function readNavigationTiming() {
    const nav = performance.getEntriesByType?.("navigation")?.[0];
    const t = performance.timing ? { ...performance.timing } : {};
    const safe = (a, b) => (a > 0 && b > 0 && b >= a ? b - a : 0);
    const start = t.navigationStart || (nav ? nav.startTime : 0) || 0;

    const metrics = {};
    // 网络
    metrics.dns = safe(t.domainLookupStart, t.domainLookupEnd) || (nav ? (nav.domainLookupEnd - nav.domainLookupStart) : 0);
    metrics.tcp = safe(t.connectStart, t.connectEnd) || (nav ? (nav.connectEnd - nav.connectStart) : 0);
    metrics.ssl = (t.secureConnectionStart > 0)
      ? safe(t.secureConnectionStart, t.connectEnd)
      : (nav && nav.secureConnectionStart > 0 ? (nav.connectEnd - nav.secureConnectionStart) : 0);
    metrics.ttfb = safe(t.requestStart, t.responseStart) || (nav ? (nav.responseStart - nav.requestStart) : 0);
    metrics.request = metrics.ttfb; // 请求等待 ≈ TTFB（传输前等待）
    metrics.response = safe(t.responseStart, t.responseEnd) || (nav ? (nav.responseEnd - nav.responseStart) : 0);
    // DOM
    metrics.domParse = safe(t.domLoading, t.domInteractive) || (nav ? (nav.domInteractive - nav.domLoading) : 0);
    metrics.interactive = t.domInteractive > 0 ? (t.domInteractive - start) : (nav ? nav.domInteractive : 0);
    metrics.domReady = safe(t.domContentLoadedEventStart, t.domContentLoadedEventEnd) || (nav ? (nav.domContentLoadedEventEnd - nav.domContentLoadedEventStart) : 0);
    metrics.load = t.loadEventEnd > 0 ? (t.loadEventEnd - start) : (nav ? nav.loadEventEnd : 0);
    // Vitals
    metrics.fcp = fcpValue || readPaint("first-contentful-paint");
    metrics.lcp = Math.round(lcpValue) || 0;
    metrics.cls = Number(clsValue.toFixed(4));
    metrics.tbt = Math.round(tbtValue);
    metrics.transferSize = nav ? nav.transferSize : 0;
    // 清理 0 -> null
    for (const k of Object.keys(metrics)) if (metrics[k] === 0) metrics[k] = null;
    return metrics;
  }

  function readPaint(type) {
    try {
      const e = performance.getEntriesByType("paint").find((x) => x.name === type);
      return e ? e.startTime : 0;
    } catch { return 0; }
  }

  // ---- 等待 load + loadEventEnd 就绪 ----
  function waitReady(timeout = 15000) {
    return new Promise((resolve) => {
      const start = Date.now();
      function check() {
        const ready = document.readyState === "complete";
        const t = performance.timing || {};
        const navEndReady = t.loadEventEnd > 0;
        if ((ready && navEndReady) || Date.now() - start > timeout) {
          resolve();
        } else {
          setTimeout(check, 200);
        }
      }
      check();
    });
  }

  // ---- 上报 ----
  async function report() {
    await waitReady();
    // 再让出一帧，确保 LCP/CLS 收尾
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const metrics = readNavigationTiming();
    // 附带原始 timing（供 DevTools 面板绘制时间轴）与资源体积排行
    const timingRaw = {};
    if (performance.timing) {
      const t = performance.timing;
      // 仅取时间轴需要的字段（相对 navigationStart 的绝对时间戳）
      for (const k of ["navigationStart","fetchStart","domainLookupStart","domainLookupEnd","connectStart","connectEnd","secureConnectionStart","requestStart","responseStart","responseEnd","domLoading","domInteractive","domContentLoadedEventStart","domContentLoadedEventEnd","domComplete","loadEventStart","loadEventEnd"]) {
        timingRaw[k] = t[k] || 0;
      }
    }
    const topResources = readTopResources(8);
    console.log("[性能监控] report() 里的 topResources 长度:", topResources.length, "前 2 条:", topResources.slice(0, 2));
    const payload = {
      url: location.href,
      title: document.title || location.href,
      capturedAt: Date.now(),
      metrics,
      timingRaw,
      topResources,
    };
    try {
      await chrome.runtime.sendMessage({ type: "PERF_REPORT", payload });
      console.log("[性能监控] 上报成功，url:", payload.url);
    } catch (e) {
      console.warn("[性能监控] 上报失败:", e, "1 秒后重试");
      // service worker 可能休眠，延迟重试一次
      setTimeout(() => {
        chrome.runtime.sendMessage({ type: "PERF_REPORT", payload }).catch(() => {});
      }, 1000);
    }
  }

  // 读取传输体积最大的若干资源（传输大小排行）
  function readTopResources(limit) {
    const out = [];
    try {
      const entries = performance.getEntriesByType("resource");
      console.log("[性能监控] resource entries 数量:", entries.length);
      for (const e of entries) {
        const t = e.encodedBodySize || e.transferSize || 0;
        out.push({
          name: e.name,
          initiatorType: e.initiatorType || "",
          duration: e.duration || 0,
          size: t,
          decodedSize: e.decodedBodySize || 0,
        });
      }
      console.log("[性能监控] 处理后的资源数:", out.length, "前 3 个:", out.slice(0, 3));
    } catch (e) {
      console.error("[性能监控] readTopResources 错误:", e);
    }
    // 优先按体积排序；体积相同时按耗时排序（跨域资源体积为0时，用耗时兜底）
    out.sort((a, b) => {
      if ((b.size || 0) !== (a.size || 0)) return (b.size || 0) - (a.size || 0);
      return (b.duration || 0) - (a.duration || 0);
    });
    return out.slice(0, limit);
  }

  // ---- 刷新检测：检查 background 设的 navReset 标记 ----
  async function checkNavReset() {
    try {
      const r = await chrome.storage.local.get(NAV_RESET_KEY);
      const m = r[NAV_RESET_KEY] || {};
      if (m[/* tabId 占位 */ 0] === undefined) {
        // content 无法直接知道自己的 tabId，用 sender 间接；此处改为：
        // 一旦发现任一标记存在且本页未采集，则采一次后清掉标记。
      }
    } catch {}
  }

  // ---- 公开的手动重采入口（background 通过 scripting 注入调用）----
  window.__perfMonitorCapture = async function (force) {
    if (force) capturedForThisNav = false;
    if (capturedForThisNav) return;
    capturedForThisNav = true;
    await report();
  };

  // ---- 启动 ----
  setupVitalsObservers();

  // 首次加载：load 后采集
  if (document.readyState === "complete") {
    window.__perfMonitorCapture();
  } else {
    window.addEventListener("load", () => {
      // 稍延后，等 loadEventEnd
      setTimeout(() => window.__perfMonitorCapture(), 300);
    });
  }

  // 页面卸载前补采一次最终 CLS/LCP（避免 late 布局偏移遗漏）
  window.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      // 隐藏视为页面会话结束，做一次最终上报
      capturedForThisNav = false;
      window.__perfMonitorCapture(true);
    }
  });

  // 监听 storage 变化：当 background 写入 navReset[本tab] 时自动重采
  // （content 无法稳定拿到自身 tabId，改用更简单策略：
  //   只要 settings.autoAnalyze=true 且本页发生 navigation 重载，
  //   上面 load 事件本身就会重新触发采集 —— 刷新即新文档，content 重新注入，
  //   所以“刷新自动重新分析”天然成立。此处不再额外处理。）
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[NAV_RESET_KEY]) {
      // 保守：标记变化时若尚未采集则补采
      if (!capturedForThisNav) window.__perfMonitorCapture();
    }
  });
})();
