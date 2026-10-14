// devtools.js — 在 DevTools 里注册一个新面板 Tab
// 面板标题“性能报告”，图标用 48px。
try {
  chrome.devtools.panels.create(
    "性能报告",
    chrome.runtime.getURL("icons/icon-48.png"),
    chrome.runtime.getURL("devtools/panel.html"),
    () => {
      // 面板创建回调：无需额外操作
    }
  );
} catch (e) {
  console.warn("[页面性能监控] DevTools 面板创建失败:", e);
}
