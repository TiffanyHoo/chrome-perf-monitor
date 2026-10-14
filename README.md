# 页面性能监控（Page Performance Monitor）Chrome 扩展

一个以 **标签页为维度** 的前端性能监控扩展。利用 Chrome Performance API（Navigation Timing + Web Vitals）实时分析每次打开/刷新页面的性能，**刷新自动重新采集**，并通过 **徽标颜色、桌面通知、弹窗明细** 对性能瓶颈实时告警。

> 灵感来自掘金《5 分钟撸一个前端性能监控工具》：用 `window.performance` 时序把页面加载拆成 DNS / TCP / 请求 / 响应 / DOM 解析 / Load 等阶段，量化用户体验。本扩展把这套思路做成了可安装的浏览器插件，并补齐了「以页面为维度、刷新即重采、实时告警」三项关键能力。

---

## 功能

- **以标签页为维度**：每个标签页维护一份独立性能档案，互不干扰。
- **刷新自动重新分析**：刷新或导航到新页面后，扩展自动重新采集并刷新告警（content script 随新文档重新注入，天然按新页面为单位采集）。
- **实时告警**：
  - 徽标颜色：良好（绿）/ 需关注（黄，显示 `!`）/ 较差（红，显示告警数）。
  - 桌面通知：触发 `bad`/`warn` 级指标时弹出系统通知。
  - 弹窗明细：点击工具栏图标，查看各阶段时长、Web Vitals 与告警列表。
- **采集指标**：
  - 网络阶段：DNS、TCP、SSL、TTFB、请求等待、响应传输
  - DOM 阶段：DOM 解析、可交互、DOMContentLoaded
  - 页面整体：完全加载（Load）、传输体积
  - Web Vitals：FCP、LCP、CLS、TBT（longtask 近似）
- **阈值可配置**：在选项页自定义每个指标的「良好上限 / 关注上限」，并开关徽标、通知、自动重分析。

## 安装

1. 打开 Chrome，地址栏输入 `chrome://extensions`。
2. 右上角打开「开发者模式」。
3. 点击「加载已解压的扩展程序」，选择本目录 `page-perf-monitor`。
4. 工具栏出现「页面性能监控」图标，固定到工具栏方便使用。

> 要求 Chrome ≥ 102（MV3）。Edge / 360 等基于 Chromium 的浏览器同样适用。

## 使用

1. 打开任意网页。页面加载完成后，扩展图标徽标会显示当前性能等级颜色。
2. 点击图标，弹窗显示该标签页的性能明细与告警。
3. **刷新页面**：扩展自动重新采集并更新徽标/告警。
4. 弹窗内「重新采集」按钮可手动触发一次重新分析。
5. 点击弹窗底部「阈值配置」进入选项页调整阈值与开关。

## 目录结构

```
page-perf-monitor/
├─ manifest.json          # MV3 清单
├─ background.js          # service worker：徽标、通知、告警判定、标签页档案
├─ shared.js              # 指标定义、阈值、定级、格式化（background/popup 复用）
├─ content.js             # 页面端采集：Navigation Timing + Web Vitals
├─ popup/
│  ├─ popup.html / .css / .js   # 当前页性能弹窗
├─ options/
│  ├─ options.html / .css / .js # 阈值配置页
├─ icons/                 # 16/32/48/128 PNG
└─ _locales/
   ├─ zh/messages.json
   └─ en/messages.json
```

## 告警定级规则

每个指标有「良好上限 `goodMax`」与「关注上限 `warnMax`」：

- `value <= goodMax` → **良好**（绿）
- `goodMax < value <= warnMax` → **需关注**（黄）
- `value > warnMax` → **较差**（红）

整体等级取所有已采集指标中最差的一级。默认阈值（毫秒；CLS 无量纲）：

| 指标 | goodMax | warnMax |
|---|---|---|
| 完全加载 Load | 2500 | 4000 |
| TTFB | 500 | 1000 |
| DNS | 50 | 200 |
| TCP | 50 | 200 |
| SSL | 100 | 300 |
| 请求等待 | 300 | 800 |
| 响应传输 | 500 | 1500 |
| DOM 解析 | 800 | 2000 |
| 可交互 | 2500 | 4500 |
| DOMContentLoaded | 1500 | 3500 |
| FCP | 1800 | 3000 |
| LCP | 2500 | 4000 |
| CLS | 0.10 | 0.25 |
| TBT | 200 | 600 |

## 技术要点

- **Navigation Timing 拆解**：用 `performance.timing` 与 `PerformanceNavigationTiming` 双源兜底，按时间戳相减得到各阶段。
- **Web Vitals**：`PerformanceObserver` 订阅 `largest-contentful-paint`、`layout-shift`、`longtask`、`first-contentful-paint`；CLS 取整页累计值，TBT 近似为各 longtask 超过 50ms 部分之和。
- **刷新自动重采**：刷新 = 新文档加载 → content script 重新注入 → `load` 后自动采集，故「刷新即重分析」天然成立；`webNavigation.onCommitted` 用于清理与标记，标签关闭时回收档案。
- **per-tab 维度**：档案以 `tabId` 为键存于 `chrome.storage.local`，徽标按 `tabId` 设置，不同标签页互不干扰。
- **告警交付**：`chrome.action.setBadge*` 控制徽标颜色与文本；`chrome.notifications` 推送系统通知；popup 拉取当前 tab 档案渲染。

## 局限与说明

- TBT 由 longtask 近似（Lab 数据需 DevTools 的长任务精确统计，扩展侧为近似值）。
- `chrome://` 等内部页与 `file://` 在部分浏览器中可能受限，扩展主要针对 http(s) 页面。
- 首字节/传输体积依赖 Navigation Timing，预渲染或 bfcache 恢复场景下可能为 0（已按「未采集」显示）。
