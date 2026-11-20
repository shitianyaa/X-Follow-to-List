(function installCuratorPanel() {
  const SOURCE = "x-list-curator";
  const STORAGE_KEY = "x-list-curator-state-v1";
  const EXTENSION_VERSION = chrome.runtime.getManifest().version;
  const SOURCE_LABELS = { custom: "自定义名单", following: "关注列表", legacy: "历史缓存" };
  const ROW_HEIGHT = 104;
  const VISIBLE_ROWS = 14;
  const DEFAULT_SETTINGS = {
    betweenMin: 2,
    betweenMax: 6,
    batchSize: 20,
    pauseMin: 2,
    pauseMax: 5,
    maxAttempts: 2
  };
  const DEFAULT_FILTERS = {
    query: "",
    include: "",
    exclude: "",
    location: "",
    minFollowers: "",
    maxFollowers: "",
    minFollowing: "",
    maxFollowing: "",
    minPosts: "",
    maxPosts: "",
    mutual: false
  };

  const state = {
    schemaVersion: 2,
    users: [],
    collections: { custom: [], following: [], legacy: [] },
    activeSource: "custom",
    selectedIds: [],
    filters: { ...DEFAULT_FILTERS },
    filterDraft: { ...DEFAULT_FILTERS },
    listUrl: "",
    settings: { ...DEFAULT_SETTINGS },
    job: null,
    history: [],
    sessionFingerprint: "",
    lookupCooldownUntil: 0
  };
  const runtime = {
    panelOpen: false,
    running: false,
    stopRequested: false,
    cooldownTimer: 0,
    cooldownTicker: 0,
    filteredUsers: [],
    sessionReady: false,
    sessionFingerprint: "",
    hookReady: false,
    persistTimer: 0,
    toastTimer: 0,
    pendingAdds: new Map(),
    storageCorrupt: false,
    captureGeneration: 0,
    captureClearPending: false,
    accountImport: null
  };
  const refs = {};

  const css = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .xcurator-panel { display: flex; flex-direction: column; position: fixed; z-index: 2147483647; top: 16px; right: 16px; width: min(470px, calc(100vw - 32px)); max-height: calc(100vh - 32px); overflow: hidden; color: #eff6f0; background: #101817; border: 1px solid #2d4941; border-radius: 18px; box-shadow: 0 22px 70px rgba(0,0,0,.46); font: 13px/1.4 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .xcurator-panel[hidden] { display: none; }
    .xcurator-header { flex: 0 0 auto; display: flex; align-items: flex-start; justify-content: space-between; padding: 18px 20px 14px; border-bottom: 1px solid #203730; background: linear-gradient(135deg, #14231f, #101817 68%); }
    .header-actions { display: flex; align-items: center; gap: 8px; margin-left: 12px; flex: 0 0 auto; }
    .clear-capture { min-height: 30px; padding: 5px 9px; border: 1px solid #705541; border-radius: 8px; color: #f0c88d; background: rgba(122, 75, 38, .14); font-size: 11px; font-weight: 700; white-space: nowrap; }
    .clear-capture:hover:not(:disabled) { color: #fff1d3; border-color: #c08b57; background: rgba(151, 91, 45, .28); }
    .eyebrow { color: #a8d8b2; letter-spacing: .18em; font-size: 10px; font-weight: 700; }
    h1 { margin: 3px 0 0; color: #f5f1dc; font: 600 23px/1.1 Georgia, Cambria, serif; letter-spacing: -.02em; }
    .close { width: 30px; height: 30px; border: 0; border-radius: 50%; color: #b7cbc0; background: #1c302a; cursor: pointer; font-size: 18px; }
    .close:hover { color: #fff; background: #315246; }
    .xcurator-body { min-height: 0; flex: 1 1 auto; overflow: auto; overscroll-behavior: contain; }
    .section { padding: 14px 20px; border-bottom: 1px solid #203730; }
    .section-title { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 9px; color: #f4f0dd; font-weight: 700; }
    .muted { color: #8ea99c; }
    .status-line { display: flex; gap: 8px; align-items: center; padding: 8px 10px; color: #c5d5cc; background: #15241f; border-radius: 9px; }
    .dot { width: 7px; height: 7px; border-radius: 50%; background: #e29a55; flex: 0 0 auto; }
    .dot.ready { background: #91e6a8; box-shadow: 0 0 0 3px rgba(145,230,168,.12); }
    .notice { margin-top: 9px; padding: 9px 10px; color: #e9c68b; background: rgba(159, 96, 36, .14); border: 1px solid rgba(223, 158, 81, .26); border-radius: 9px; font-size: 11px; }
    .risk-inline { color: #e9c68b; font-weight: 700; }
    label.field { display: block; color: #9eb8aa; font-size: 11px; }
    label.field span { display: block; margin-bottom: 5px; }
    input[type=text], input[type=number] { width: 100%; min-height: 34px; padding: 7px 9px; border: 1px solid #355448; border-radius: 8px; color: #eef5ef; background: #0d1514; outline: none; font: inherit; }
    input[type=text]:focus, input[type=number]:focus { border-color: #8edca5; box-shadow: 0 0 0 2px rgba(142,220,165,.12); }
    .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; }
    .grid3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; }
    .filter-grid { display: grid; gap: 9px; }
    .metric-ranges { display: grid; gap: 7px; }
    .metric-range { display: grid; grid-template-columns: 46px minmax(0, 1fr); gap: 9px; align-items: end; padding: 8px; border: 1px solid #28453b; border-radius: 9px; background: rgba(10, 23, 19, .38); }
    .metric-name { padding-bottom: 7px; color: #b4cabd; font-size: 10px; font-weight: 800; letter-spacing: .04em; }
    .metric-range label.field span { font-size: 10px; }
    .relationship-filter { display: inline-flex; align-items: center; gap: 7px; min-height: 32px; padding: 6px 10px; border: 1px solid #315246; border-radius: 8px; color: #c8dacd; background: #12211c; font-size: 11px; cursor: pointer; }
    .relationship-filter input { accent-color: #98e6aa; }
    .relationship-filter .relationship-mark { color: #9ae5a6; font-size: 15px; line-height: 1; }
    .relationship-filter small { color: #7e9a8d; font-size: 10px; }
    .filter-apply-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 10px; padding-top: 9px; border-top: 1px solid #203730; }
    .filter-commit { display: inline-flex; align-items: center; gap: 8px; }
    .match-count { color: #a6c7ae; font-size: 11px; white-space: nowrap; }
    .match-count.pending { color: #e2c58c; }
    button.filter-reset { color: #9eb8aa; background: transparent; }
    button.filter-apply { min-height: 32px; padding-inline: 13px; color: #102018; background: #9ae5a6; border-color: #9ae5a6; font-weight: 800; }
    button.filter-apply:hover { background: #b1f1b7; }
    .selection-panel { margin-top: 12px; padding: 10px; border: 1px solid #2d4d42; border-radius: 10px; background: #102019; }
    .selection-panel-head { display: flex; justify-content: space-between; align-items: end; gap: 8px; }
    .selection-panel-head strong { display: block; margin-top: 1px; color: #f4f0dd; font-size: 13px; }
    .panel-kicker { color: #86a99a; font-size: 9px; font-weight: 800; letter-spacing: .13em; text-transform: uppercase; }
    .selection-scope { color: #8aa89a; font-size: 10px; white-space: nowrap; }
    .selection-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; margin-top: 9px; }
    .selection-actions button { min-height: 35px; padding-inline: 7px; }
    .selection-actions .selection-export { color: #b9dcc1; border-color: #4d7862; background: #142a20; }
    button { min-height: 31px; padding: 6px 10px; border: 1px solid #395a4e; border-radius: 8px; color: #c7d8ce; background: #15241f; cursor: pointer; font: 600 11px/1.1 inherit; }
    button:hover { border-color: #90dca4; color: #f6fff8; }
    button:disabled { opacity: .42; cursor: not-allowed; }
    button.primary { width: 100%; margin-top: 10px; border-color: #a3e9ad; color: #092216; background: #9ae5a6; font-size: 13px; }
    button.primary:hover { background: #b1f1b7; }
    button.danger { color: #efb3a4; }
    .list-viewport { height: min(300px, 38vh); overflow: auto; overscroll-behavior: contain; border: 1px solid #29463d; border-radius: 10px; background: #0c1413; }
    .list-row { display: grid; grid-template-columns: 21px 44px minmax(0, 1fr); gap: 9px; align-items: center; height: ${ROW_HEIGHT}px; overflow: hidden; padding: 8px 10px; border-bottom: 1px solid #1a2a26; }
    .list-row:last-child { border-bottom: 0; }
    .list-row:hover { background: #12231d; }
    .row-check { accent-color: #98e6aa; }
    .avatar { width: 44px; height: 44px; border-radius: 50%; object-fit: cover; background: #274238; border: 1px solid #45675a; }
    .user-main { min-width: 0; }
    .user-name { display: flex; gap: 5px; align-items: center; min-width: 0; color: #f4f2e6; font-weight: 700; }
    .user-name strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .badge { color: #92e6a5; font-size: 11px; }
    .handle { color: #87a99a; font-size: 11px; }
    .bio { display: -webkit-box; overflow: hidden; margin-top: 2px; color: #b1c5b9; font-size: 11px; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
    .metrics { margin-top: 3px; color: #789588; font-size: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .empty { display: grid; place-items: center; height: 100%; padding: 20px; color: #819a8e; text-align: center; }
    .selection-hint { margin-top: 7px; color: #86a294; font-size: 10px; }
    details { margin-top: 10px; border: 1px solid #28453b; border-radius: 9px; }
    summary { padding: 8px 10px; color: #a4bdaf; cursor: pointer; font-size: 11px; }
    .advanced { display: grid; gap: 9px; padding: 2px 10px 11px; }
    .job-card { padding: 10px; border: 1px solid #315246; border-radius: 10px; background: #12211c; }
    .job-head { display: flex; justify-content: space-between; gap: 8px; color: #dae9df; font-weight: 700; }
    .progress-track { height: 7px; margin: 9px 0 6px; overflow: hidden; border-radius: 99px; background: #263c34; }
    .progress-fill { height: 100%; width: 0%; border-radius: inherit; background: #9ae5a6; transition: width .2s ease; }
    .job-meta { display: flex; justify-content: space-between; color: #8faa9c; font-size: 10px; }
    .job-action-groups { display: grid; grid-template-columns: minmax(0, 2fr) minmax(126px, 1fr); gap: 8px; margin-top: 10px; }
    .job-action-group { padding: 8px; border: 1px solid #2d4d42; border-radius: 9px; background: rgba(8, 21, 17, .42); }
    .job-action-group-label { margin: 0 0 7px; color: #86a99a; font-size: 9px; font-weight: 800; letter-spacing: .13em; text-transform: uppercase; }
    .job-action-grid { display: grid; gap: 6px; }
    .job-action-group.flow .job-action-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .job-action-group.export .job-action-grid { grid-template-columns: minmax(0, 1fr); }
    .job-action-group button { min-height: 37px; padding-inline: 7px; }
    .history-list { display: grid; gap: 7px; max-height: 220px; overflow: auto; }
    .history-item { padding: 8px 9px; border: 1px solid #29463d; border-radius: 8px; background: #0d1715; }
    .history-item strong { color: #e9f0e8; }
    .history-item .history-meta { margin-top: 3px; color: #87a294; font-size: 10px; }
    .history-item .history-actions { display: flex; gap: 6px; margin-top: 6px; }
    .toast { flex: 0 0 auto; margin: 0 12px 12px; padding: 8px 10px; color: #07170e; background: #a3e9ad; border-radius: 9px; font-size: 11px; font-weight: 700; }
    @media (max-width: 560px) { .xcurator-panel { top: 8px; right: 8px; width: calc(100vw - 16px); max-height: calc(100vh - 16px); }  .job-action-groups { grid-template-columns: 1fr; } .job-action-group.export .job-action-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .metric-range { grid-template-columns: 1fr; gap: 5px; } .metric-name { padding-bottom: 0; } .relationship-filter small { display: none; } }

    [hidden] { display: none !important; }
    .import-footer { flex: 0 0 auto; padding: 12px 20px 14px; border-top: 1px solid #355448; background: #14231f; }
    .import-footer .section-title { font-size: 12px; margin-bottom: 7px; }
    .import-footer .section-title .muted { font-size: 10px; font-weight: 400; }
    .import-footer .check { display: block; margin-top: 7px; color: #a9c1b2; font-size: 10px; }
    .footer-actions { display: flex; gap: 8px; margin-top: 8px; }
    .footer-actions .primary { flex: 1; width: auto; margin-top: 0; }
    .footer-actions button { min-height: 36px; }
    .source-panel { margin-top: 9px; overflow: hidden; }
    .source-panel > summary { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 43px; font-size: 12px; }
    .source-panel > summary::before { content: "▸"; color: #9ae5a6; }
    .source-panel[open] > summary::before { content: "▾"; }
    .source-panel > summary strong { flex: 1; color: #f4f0dd; }
    .source-panel > summary span { color: #8ea99c; font-size: 10px; }
    .source-panel[open] > summary { border-bottom: 1px solid #28453b; background: #15241f; }
    .source-content { padding: 10px; }
    .filters-content { padding: 2px 9px 10px; }
    .source-clean { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 8px; }
    .source-clean button { flex: 0 0 auto; font-size: 10px; }
    .source-clean .selection-hint { margin: 0; }
    .selection-panel { margin-top: 9px; margin-bottom: 8px; }
    .selection-scope { white-space: normal; text-align: right; }
    .snapshot-action { margin-top: 8px; }
    .job-card { margin-top: 9px; }
    .notice > summary { padding: 0; color: #e9c68b; }
    .notice > div { margin-top: 7px; }
    .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
    button:focus-visible, summary:focus-visible, input:focus-visible { outline: 2px solid #9ae5a6; outline-offset: 2px; }
    @media (max-width: 420px) { .xcurator-header { padding: 12px; } h1 { font-size: 19px; } .header-actions { gap: 5px; margin-left: 6px; } .section { padding: 10px 12px; } .import-footer { padding: 10px 12px; } .source-content { padding: 8px; } }
  `;

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, Number(value) || min));
  }

  function splitTerms(value) {
    return String(value || "").split(/[\s,，、]+/).map((term) => term.trim().toLowerCase()).filter(Boolean);
  }

  function parseListUrl(value) {
    try {
      const url = new URL(String(value).trim());
      if (!/(^|\.)x\.com$|(^|\.)twitter\.com$/i.test(url.hostname)) return null;
      const match = url.pathname.match(/\/i\/lists\/(\d+)|\/lists\/(\d+)/i);
      if (!match) return null;
      return { id: match[1] || match[2], url: url.toString() };
    } catch (_) {
      return null;
    }
  }

  function isFollowingPage() {
    return /(?:^|\/)(following|friends)(?:\/|$)/i.test(location.pathname) || /following/i.test(document.title);
  }

  function selectedSet() {
    return new Set(state.selectedIds);
  }

  function currentSettings() {
    const read = (name, fallback) => Number(refs[name]?.value ?? fallback);
    const min = clamp(read("betweenMin", DEFAULT_SETTINGS.betweenMin), 1, 60);
    const max = clamp(read("betweenMax", DEFAULT_SETTINGS.betweenMax), min, 120);
    return {
      betweenMin: min,
      betweenMax: max,
      batchSize: clamp(read("batchSize", DEFAULT_SETTINGS.batchSize), 1, 500),
      pauseMin: clamp(read("pauseMin", DEFAULT_SETTINGS.pauseMin), 0.1, 60),
      pauseMax: clamp(read("pauseMax", DEFAULT_SETTINGS.pauseMax), clamp(read("pauseMin", DEFAULT_SETTINGS.pauseMin), 0.1, 60), 120),
      maxAttempts: clamp(read("maxAttempts", DEFAULT_SETTINGS.maxAttempts), 1, 5)
    };
  }

  function randomBetween(min, max) {
    return min + Math.random() * Math.max(0, max - min);
  }

  async function sha256Hex(value) {
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
    return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  async function queueFingerprint(listId, ids) {
    return sha256Hex(`${listId}|${ids.join(",")}`);
  }

  function formatNumber(value) {
    return Number(value || 0).toLocaleString("zh-CN");
  }

  function formatMetric(value) {
    return value == null ? "未知" : formatNumber(value);
  }

  function formatDuration(ms) {
    const seconds = Math.max(0, Math.ceil(ms / 1000));
    if (seconds < 60) return `${seconds} 秒`;
    return `${Math.ceil(seconds / 60)} 分钟`;
  }

  function jobStatusLabel(status) {
    return ({ draft: "待开始", running: "导入中", paused: "已暂停", cooldown: "冷却中", completed: "已完成" }[status]) || status || "无任务";
  }

  function itemStatusLabel(status) {
    return ({ pending: "待处理", retryable: "等待重试", succeeded: "已加入", already_member: "已在列表", failed: "失败", skipped: "跳过" }[status]) || status;
  }

  function recomputeJobStats(job) {
    if (!job?.queue) return;
    job.successCount = job.queue.filter((item) => item.status === "succeeded").length;
    job.alreadyCount = job.queue.filter((item) => item.status === "already_member").length;
    job.failureCount = job.queue.filter((item) => item.status === "failed").length;
  }

  async function persistNow() {
    if (runtime.storageCorrupt) return;
    recomputeJobStats(state.job);
    state.job && (state.job.updatedAt = Date.now());
    try {
      await globalThis.XListStore.save(state);
    } catch (error) {
      showToast(`本地保存失败：${error?.message || "storage error"}`);
    }
  }

  function persistSoon() {
    clearTimeout(runtime.persistTimer);
    runtime.persistTimer = setTimeout(() => persistNow(), 180);
  }

  function showToast(message) {
    if (!refs.toast) return;
    refs.toast.textContent = message;
    refs.toast.hidden = false;
    clearTimeout(runtime.toastTimer);
    runtime.toastTimer = setTimeout(() => { refs.toast.hidden = true; }, 3500);
  }

  function createUi() {
    const host = document.createElement("div");
    host.id = "x-following-curator-host";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>${css}</style>
      <section class="xcurator-panel" hidden aria-label="X Following Curator">
        <header class="xcurator-header">
          <div><div class="eyebrow">X FOLLOW TO LIST · ${escapeHtml(EXTENSION_VERSION)}</div><h1>把账号名单变成你的清单</h1></div>
          <div class="header-actions"><button class="clear-capture" data-ref="clearCaptured" data-action="clearCaptured" title="清除所有来源的账号缓存和名单，保留任务及冷却">清除缓存</button><button class="close" data-action="close" title="关闭">×</button></div>
        </header>
        <div class="xcurator-body">
          <section class="section session-section">
            <div class="status-line"><span class="dot" data-ref="sessionDot"></span><span data-ref="pageStatus">正在等待 X 页面数据…</span></div>
            <details class="notice"><summary>操作说明与风险</summary><div>此扩展使用当前 X 网页会话发起列表操作。X 可能限制或暂停自动化行为；请仅添加你明确选择的账号。</div></details>
          </section>
          <section class="section source-section">
            <div class="section-title"><span>账号来源</span><span class="muted" data-ref="captureCount" title="两种名单共用账号资料；清空名单不会删除缓存">共用缓存 0 人</span></div>
            <details class="source-panel" data-source="custom" open>
              <summary><strong>自定义名单</strong><span data-source-count="custom">0 人</span></summary>
              <div class="source-content">
                <div data-ref="accountImport"></div>
                <div data-results-slot="custom">
                  <div data-ref="accountResults">
                    <details class="filters-panel"><summary>筛选本组账号（可选）</summary><div class="filters-content">
            <div class="filter-grid">
              <label class="field"><span>搜索姓名、@用户名、简介或位置</span><input type="text" data-ref="query" placeholder="例如：design / 设计 / @alice"></label>
              <div class="grid2"><label class="field"><span>包含关键词</span><input type="text" data-ref="include" placeholder="空格分隔"></label><label class="field"><span>排除关键词</span><input type="text" data-ref="exclude" placeholder="空格分隔"></label></div>
              <label class="field"><span>位置关键词</span><input type="text" data-ref="location" placeholder="例如：Shanghai / Hong Kong"></label>
              <div class="metric-ranges">
                <div class="metric-range"><span class="metric-name">粉丝数</span><div class="grid2"><label class="field"><span>最少</span><input type="number" min="0" data-ref="minFollowers" placeholder="不限"></label><label class="field"><span>最多</span><input type="number" min="0" data-ref="maxFollowers" placeholder="不限"></label></div></div>
                <div class="metric-range"><span class="metric-name">关注数</span><div class="grid2"><label class="field"><span>最少</span><input type="number" min="0" data-ref="minFollowing" placeholder="不限"></label><label class="field"><span>最多</span><input type="number" min="0" data-ref="maxFollowing" placeholder="不限"></label></div></div>
                <div class="metric-range"><span class="metric-name">发帖数</span><div class="grid2"><label class="field"><span>最少</span><input type="number" min="0" data-ref="minPosts" placeholder="不限"></label><label class="field"><span>最多</span><input type="number" min="0" data-ref="maxPosts" placeholder="不限"></label></div></div>
              </div>
            </div>
            <div style="margin-top:9px"><label class="relationship-filter"><input type="checkbox" data-ref="mutual"><span class="relationship-mark">↔</span><span>仅互关</span><small>对方也关注你</small></label></div>
            <div class="filter-apply-row"><button class="filter-reset" data-action="clearFilters">清除条件</button><div class="filter-commit"><span class="match-count" data-ref="matchCount">已匹配 0 人</span><button class="filter-apply" data-action="applyFilters">确定筛选</button></div></div>

                      <div class="selection-hint">统计缺失显示“未知”；设置数值条件时，缺失该项统计的账号不参与匹配。</div>
                    </div></details>
            <div class="selection-panel">
              <div class="selection-panel-head"><div><span class="panel-kicker" data-ref="resultsTitle">本组结果</span><strong data-ref="selectionCount">已选 0 人</strong></div><span class="selection-scope" data-ref="selectionScope">当前结果 0 人</span></div>
              <div class="selection-actions"><button data-ref="selectFiltered" data-action="selectFiltered">全选当前结果</button><button data-action="invertSelection">反选当前结果</button><button data-ref="clearSelection" data-action="clearSelection">清空本组勾选</button><button class="selection-export" data-action="exportCsv">导出已选 CSV</button></div>
            </div>
            <div class="list-viewport" data-ref="listViewport"><div class="empty">粘贴自定义名单并解析，或滚动 Following 页面收集账号。</div></div>

                    <div class="source-clean"><span class="selection-hint">清空本组名单仍会保留共用缓存</span><button data-ref="clearSource" data-action="clearSource">清空自定义名单</button></div>
                  </div>
                </div>
              </div>
            </details>
            <details class="source-panel" data-source="following">
              <summary><strong>关注列表</strong><span data-source-count="following">0 人</span></summary>
              <div class="source-content"><p class="selection-hint">滚动自己的 Following 页面收集账号；这些资料也能供自定义名单直接复用。</p><div data-results-slot="following"></div></div>
            </details>
            <details class="source-panel" data-source="legacy" hidden>
              <summary><strong>历史缓存</strong><span data-source-count="legacy">0 人</span></summary>
              <div class="source-content"><p class="selection-hint">旧版账号未记录来源，先保留在这里。重新捕获或导入后会归入对应名单；旧缓存中不确定的零值显示为“未知”。</p><div data-results-slot="legacy"></div></div>
            </details>
          </section>
          <section class="section task-section">
            <details><summary>节奏与恢复设置</summary><div class="advanced">
              <div class="grid2"><label class="field"><span>两次操作间隔（秒）</span><div class="grid2"><input type="number" min="1" max="60" step="0.1" data-ref="betweenMin"><input type="number" min="1" max="120" step="0.1" data-ref="betweenMax"></div></label><label class="field"><span>每批账号数</span><input type="number" min="1" max="500" data-ref="batchSize"></label></div>
              <div class="grid3"><label class="field"><span>批次暂停最短（分钟）</span><input type="number" min="0.1" max="60" step="0.1" data-ref="pauseMin"></label><label class="field"><span>批次暂停最长（分钟）</span><input type="number" min="0.1" max="120" step="0.1" data-ref="pauseMax"></label><label class="field"><span>单项最多重试</span><input type="number" min="1" max="5" data-ref="maxAttempts"></label></div>
            </div></details>
            <div class="snapshot-action"><button data-action="importSnapshot">恢复任务快照</button></div>
            <div class="job-card" data-ref="jobCard" hidden>
              <div class="job-head"><span data-ref="jobStatus">无任务</span><span data-ref="jobProgressText">0 / 0</span></div>
              <div class="progress-track"><div class="progress-fill" data-ref="progressFill"></div></div>
              <div class="job-meta"><span data-ref="jobMeta">等待开始</span><span data-ref="cooldownText"></span></div>
              <div class="job-action-groups">
                <div class="job-action-group flow">
                  <div class="job-action-group-label">流程控制</div>
                  <div class="job-action-grid"><button data-ref="resume" data-action="resume">继续</button><button class="danger" data-ref="pause" data-action="pause">暂停</button><button data-action="stopJob">停止并保留进度</button><button data-action="archiveJob">结束任务</button></div>
                </div>
                <div class="job-action-group export">
                  <div class="job-action-group-label">导出数据</div>
                  <div class="job-action-grid"><button data-action="exportJob">导出结果</button><button data-action="exportSnapshot">导出快照</button></div>
                </div>
              </div>
            </div>

          </section>
          <section class="section" data-ref="historySection" hidden>
            <div class="section-title"><span>历史任务</span><span><button data-action="importSnapshot">导入快照</button> <span class="muted" data-ref="historyCount">0 个</span></span></div>
            <div class="history-list" data-ref="historyList"></div>
            <input type="file" data-ref="snapshotInput" accept="application/json,.json" hidden>
          </section>

        </div>
        <footer class="import-footer">
          <div class="section-title"><span>添加到 X 列表</span><span class="muted" data-ref="footerProgress">预览并勾选后添加</span></div>
          <label class="field"><span class="sr-only">列表分享链接</span><input type="text" data-ref="listUrl" placeholder="https://x.com/i/lists/1234567890"></label>
          <label class="check"><input type="checkbox" data-ref="ackRisk"> 我已确认当前会话与所选账号 <span class="risk-inline">（可能触发限流）</span></label>
          <div class="selection-hint" data-ref="confirmSummary">目标列表：未设置 · 待导入：0 人</div>
          <div class="footer-actions"><button class="primary" data-ref="start" data-action="start">导入已选 0 人</button><button class="danger" data-ref="footerPause" data-action="pause" hidden>暂停</button></div>
        </footer>
        <div class="toast" data-ref="toast" hidden></div>
      </section>`;
    document.documentElement.appendChild(host);
    refs.host = host;
    refs.panel = shadow.querySelector(".xcurator-panel");
    shadow.querySelectorAll("[data-ref]").forEach((node) => { refs[node.dataset.ref] = node; });
    runtime.accountImport = globalThis.XListImport.mount({
      root: refs.accountImport,
      getUsers: () => state.users,
      beginImport: (handles) => {
        const known = new Map(state.users.map((user) => [user.handle.toLowerCase(), user.id]));
        globalThis.XListAccounts.replaceSource(state, "custom", handles.map((handle) => known.get(handle.toLowerCase())).filter(Boolean));
        state.filters = { ...DEFAULT_FILTERS };
        state.filterDraft = { ...DEFAULT_FILTERS };
        activateSource("custom");
      },
      onStateChange: () => {
        render();
        if (!runtime.accountImport.running && state.activeSource === "custom" && state.collections.custom.length) {
          const body = refs.panel.querySelector(".xcurator-body");
          body.scrollTop += refs.accountResults.getBoundingClientRect().top - body.getBoundingClientRect().top;
        }
      },
      canImport: () => !runtime.storageCorrupt && !runtime.running && !["running", "cooldown"].includes(state.job?.status),
      getSettings: currentSettings,
      getCooldown: () => state.lookupCooldownUntil,
      onRateLimit: (result) => {
        state.lookupCooldownUntil = Date.now() + Math.max(cooldownFor(result.status), Number(result.retryAfterMs) || 0);
        return persistNow();
      },
      mergeUsers: (users) => mergeUsers(users, "custom"),
      showToast
    });
    shadow.addEventListener("click", onClick);
    shadow.addEventListener("input", onInput);
    shadow.addEventListener("change", onChange);
    refs.listViewport.addEventListener("scroll", renderList);
    shadow.addEventListener("toggle", (event) => {
      const source = event.target.dataset?.source;
      if (source && event.target.open && source !== state.activeSource) activateSource(source);
    }, true);
  }

  function onInput(event) {
    const name = event.target?.dataset?.ref;
    if (!name) return;
    if (Object.prototype.hasOwnProperty.call(state.filters, name)) {
      state.filterDraft[name] = event.target.type === "checkbox" ? Boolean(event.target.checked) : event.target.value;
      persistSoon();
      renderFilterSummary();
    }
    if (name === "listUrl") { state.listUrl = event.target.value; persistSoon(); renderJob(); renderConfirmation(); }
  }

  function onChange(event) {
    const name = event.target?.dataset?.ref;
    if (!name) return;
    if (name === "snapshotInput") {
      importSnapshotFile(event.target.files?.[0]);
      event.target.value = "";
      return;
    }
    if (Object.prototype.hasOwnProperty.call(state.filters, name) && event.target.type === "checkbox") {
      state.filterDraft[name] = Boolean(event.target.checked);
      persistSoon();
      renderFilterSummary();
    }
  }

  function onClick(event) {
    const action = event.target?.dataset?.action;
    if (action) {
      event.preventDefault();
      const historyId = event.target?.dataset?.historyId || event.target?.closest?.("[data-history-id]")?.dataset?.historyId;
      const handlers = { close: closePanel, applyFilters, clearFilters, clearCaptured: clearCapturedUsers, clearSource: clearCurrentSource, selectFiltered, invertSelection, clearSelection, exportCsv, exportJob, exportSnapshot, importSnapshot, start: startOrResume, resume: resumeJob, pause: pauseJob, stopJob, archiveJob };
      if (action === "retryHistory") return retryHistory(historyId);
      if (action === "deleteHistory") return deleteHistory(historyId);
      if (action === "exportHistory") return exportHistory(historyId);
      (handlers[action] || (() => {}))();
      return;
    }
    const checkbox = event.target?.closest?.("input[data-user-id]");
    if (checkbox) {
      const id = checkbox.dataset.userId;
      const set = selectedSet();
      checkbox.checked ? set.add(id) : set.delete(id);
      state.selectedIds = Array.from(set);
      persistSoon();
      renderSelection();
      renderJob();
      renderConfirmation();
    }
  }

  function openPanel() {
    runtime.panelOpen = true;
    refs.panel.hidden = false;
    render();
  }

  function closePanel() {
    runtime.panelOpen = false;
    refs.panel.hidden = true;
  }

  function filteredUsers(filters = state.filters) {
    const f = filters;
    const query = String(f.query || "").trim().toLowerCase();
    const includes = splitTerms(f.include);
    const excludes = splitTerms(f.exclude);
    const location = String(f.location || "").trim().toLowerCase();
    return globalThis.XListAccounts.sourceUsers(state).filter((user) => {
      const haystack = `${user.name} @${user.handle} ${user.bio} ${user.location}`.toLowerCase();
      if (query && !haystack.includes(query.replace(/^@/, ""))) return false;
      if (includes.length && !includes.every((term) => haystack.includes(term))) return false;
      if (excludes.some((term) => haystack.includes(term))) return false;
      if (location && !String(user.location || "").toLowerCase().includes(location)) return false;
      if (!globalThis.XListAccounts.matchesRanges(user, f)) return false;
      if (f.mutual && !user.mutual) return false;
      return true;
    });
  }

  function normalizeFilters(input) {
    const normalized = { ...DEFAULT_FILTERS };
    for (const [key, fallback] of Object.entries(DEFAULT_FILTERS)) {
      const value = input?.[key];
      normalized[key] = typeof fallback === "boolean" ? value === true : (value == null || value === false ? "" : String(value));
    }
    return normalized;
  }

  function sameFilters(left, right) {
    return Object.keys(DEFAULT_FILTERS).every((key) => left?.[key] === right?.[key]);
  }

  function renderFilterSummary() {
    if (!refs.matchCount) return;
    const count = filteredUsers(state.filterDraft).length;
    const pending = !sameFilters(state.filterDraft, state.filters);
    refs.matchCount.textContent = `${pending ? "预览" : "已匹配"} ${formatNumber(count)} 人`;
    refs.matchCount.classList.toggle("pending", pending);
  }

  function applyFilters() {
    state.filters = normalizeFilters(state.filterDraft);
    refs.listViewport.scrollTop = 0;
    persistNow();
    render();
    showToast("已应用筛选条件");
  }

  function clearFilters() {
    state.filterDraft = { ...DEFAULT_FILTERS };
    state.filters = { ...DEFAULT_FILTERS };
    refs.listViewport.scrollTop = 0;
    persistNow();
    render();
    showToast("已清除全部筛选条件");
  }

  function renderList() {
    if (!refs.listViewport) return;
    runtime.filteredUsers = filteredUsers();
    const users = runtime.filteredUsers;
    if (!users.length) {
      refs.listViewport.innerHTML = `<div class="empty">${state.collections[state.activeSource].length ? "本组没有符合当前筛选条件的账号。" : state.activeSource === "custom" ? "粘贴名单并解析，结果会直接显示在这里。" : state.activeSource === "following" ? "打开自己的 Following 页面并滚动，即可在这里查看捕获的账号。" : "历史账号已归入对应来源。"}</div>`;
      return;
    }
    const scrollTop = refs.listViewport.scrollTop;
    const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 2);
    const end = Math.min(users.length, start + VISIBLE_ROWS + 5);
    const checked = selectedSet();
    const rows = users.slice(start, end).map((user) => {
      const avatar = user.avatar ? `<img class="avatar" loading="lazy" referrerpolicy="no-referrer" src="${escapeHtml(user.avatar)}" alt="">` : `<div class="avatar"></div>`;
      return `<label class="list-row"><input class="row-check" type="checkbox" aria-label="选择 @${escapeHtml(user.handle)}" data-user-id="${escapeHtml(user.id)}" ${checked.has(user.id) ? "checked" : ""}><span>${avatar}</span><span class="user-main"><span class="user-name"><strong>${escapeHtml(user.name || user.handle)}</strong>${user.verified ? '<span class="badge">●</span>' : ''}</span><span class="handle">@${escapeHtml(user.handle)}</span><span class="bio">${escapeHtml(user.bio || "暂无简介")}</span><span class="metrics">粉丝 ${formatMetric(user.followers)} · 关注 ${formatMetric(user.following)} · 发帖 ${formatMetric(user.posts)}${user.location ? ` · ${escapeHtml(user.location)}` : ""}${user.mutual ? " · 互关" : ""}</span></span></label>`;
    }).join("");
    const top = start * ROW_HEIGHT;
    const bottom = Math.max(0, (users.length - end) * ROW_HEIGHT);
    refs.listViewport.innerHTML = `<div style="height:${top}px"></div>${rows}<div style="height:${bottom}px"></div>`;
  }

  function renderFilters() {
    Object.entries(state.filterDraft).forEach(([key, value]) => {
      if (refs[key]) refs[key].type === "checkbox" ? (refs[key].checked = Boolean(value)) : (refs[key].value = value ?? "");
    });
    refs.listUrl.value = state.listUrl || "";
    Object.entries({ ...DEFAULT_SETTINGS, ...(state.settings || {}) }).forEach(([key, value]) => { if (refs[key]) refs[key].value = value; });
    renderFilterSummary();
  }

  function renderSelection() {
    const checked = selectedSet();
    const visibleSelected = runtime.filteredUsers.filter((user) => checked.has(user.id)).length;
    const sourceSelected = state.collections[state.activeSource].filter((id) => checked.has(id)).length;
    refs.resultsTitle.textContent = `${SOURCE_LABELS[state.activeSource]}结果`;
    refs.selectionCount.textContent = `本组已选 ${formatNumber(sourceSelected)} 人`;
    refs.selectionScope.textContent = `当前结果 ${formatNumber(runtime.filteredUsers.length)} 人 · 全部已选 ${formatNumber(state.selectedIds.length)} 人`;
    refs.captureCount.textContent = `共用缓存 ${formatNumber(state.users.length)} 人`;
    refs.clearCaptured.disabled = state.users.length === 0;
    refs.selectFiltered.disabled = false;
    refs.clearSelection.disabled = sourceSelected === 0;
    refs.clearSource.disabled = !state.collections[state.activeSource].length || Boolean(runtime.accountImport?.running);
    refs.clearSource.textContent = `清空${SOURCE_LABELS[state.activeSource]}`;
    refs.selectionCount.title = `当前筛选结果中已选 ${visibleSelected} 人`;
  }

  function renderPageStatus() {
    const ready = runtime.sessionReady;
    refs.sessionDot.classList.toggle("ready", ready);
    if (runtime.storageCorrupt) refs.pageStatus.textContent = "本地状态结构异常，当前仅可查看，已阻止写操作";
    else if (ready && runtime.sessionFingerprint) refs.pageStatus.textContent = `已连接当前 X 会话 · ${isFollowingPage() ? "可滚动捕获账号或解析名单" : "可解析自定义名单"}`;
    else if (ready) refs.pageStatus.textContent = "已监听页面会话，但还未得到可用于校验的会话指纹";
    else if (runtime.hookReady) refs.pageStatus.textContent = "已监听页面请求，请打开个人主页或 Following 页面连接会话…";
    else refs.pageStatus.textContent = "正在连接 X 页面…";
  }

  function renderJob() {
    const job = state.job;
    refs.footerPause.hidden = !runtime.running;
    refs.footerProgress.textContent = runtime.accountImport?.running ? "正在解析名单" : job ? `${jobStatusLabel(job.status)} · ${globalThis.XListJob.progress(job).done}/${job.queue.length}` : "预览并勾选后添加";
    refs.jobCard.hidden = !job;
    if (!job) {
      refs.start.textContent = `导入已选 ${state.selectedIds.length} 人`;
      refs.start.disabled = Boolean(runtime.accountImport?.running);
      return;
    }
    recomputeJobStats(job);
    const p = globalThis.XListJob.progress(job);
    refs.jobStatus.textContent = jobStatusLabel(job.status);
    refs.jobProgressText.textContent = `${p.done} / ${p.total}`;
    refs.progressFill.style.width = `${p.percent}%`;
    const current = globalThis.XListJob.firstRunnable(job);
    refs.jobMeta.textContent = `${p.pending} 人待处理 · ${job.successCount || 0} 成功 · ${job.alreadyCount || 0} 已存在 · ${job.failureCount || 0} 失败${current ? ` · 下一位 @${escapeHtml(state.users.find((u) => u.id === current.userId)?.handle || current.userId)}` : ""}`;
    const batchCooldown = job.status === "cooldown" && job.cooldownReason === "batch";
    const batchWaiting = batchCooldown && job.cooldownUntil > Date.now();
    const platformWaiting = job.status === "cooldown" && job.cooldownReason === "platform" && job.cooldownUntil > Date.now();
    if (batchWaiting) refs.cooldownText.textContent = `约 ${formatDuration(job.cooldownUntil - Date.now())} 后自动继续`;
    else if (batchCooldown) refs.cooldownText.textContent = "等待 X 会话连接后自动继续";
    else if (platformWaiting) refs.cooldownText.textContent = `约 ${formatDuration(job.cooldownUntil - Date.now())} 后可继续`;
    else refs.cooldownText.textContent = job.status === "completed" ? "队列已完成" : "";
    refs.start.textContent = job.status === "completed" ? `导入已选 ${state.selectedIds.length} 人` : (job.status === "running" ? "导入进行中" : (batchWaiting ? "取消等待，继续任务" : (platformWaiting ? "等待 X 冷却" : "继续上次导入")));
    refs.start.disabled = runtime.running || platformWaiting || Boolean(runtime.accountImport?.running);
    refs.resume.textContent = batchWaiting ? "取消等待" : "继续";
    refs.resume.disabled = runtime.running || job.status === "completed" || platformWaiting;
    refs.pause.disabled = !runtime.running && !["running", "cooldown"].includes(job.status);
  }

  function renderConfirmation() {
    const parsed = parseListUrl(refs.listUrl.value || state.listUrl);
    const pending = state.job ? globalThis.XListJob.progress(state.job).pending : state.selectedIds.length;
    refs.confirmSummary.textContent = `目标列表：${parsed ? `${parsed.id}（链接有效）` : "未设置或链接无效"} · 已选择：${state.selectedIds.length} 人 · 待导入：${pending} 人`;
  }

  function renderHistory() {
    const history = Array.isArray(state.history) ? state.history : [];
    refs.historySection.hidden = history.length === 0;
    refs.historyCount.textContent = `${history.length} 个`;
    refs.historyList.innerHTML = history.map((job) => {
      recomputeJobStats(job);
      const p = globalThis.XListJob.progress(job);
      const failed = job.queue.filter((item) => item.status === "failed").length;
      const listLabel = escapeHtml(job.listUrl || `list/${job.listId}`);
      return `<article class="history-item" data-history-id="${escapeHtml(job.id)}"><strong>${jobStatusLabel(job.status)} · ${p.done}/${p.total}</strong><div class="history-meta">${listLabel} · 成功 ${job.successCount || 0} · 已存在 ${job.queue.filter((item) => item.status === "already_member").length} · 失败 ${failed}</div><div class="history-actions"><button data-action="retryHistory" data-history-id="${escapeHtml(job.id)}" ${failed ? "" : "disabled"}>重试失败项</button><button data-action="exportHistory" data-history-id="${escapeHtml(job.id)}">导出</button><button class="danger" data-action="deleteHistory" data-history-id="${escapeHtml(job.id)}">删除</button></div></article>`;
    }).join("");
  }

  function render() {
    renderSources();
    renderFilters();
    renderPageStatus();
    renderList();
    renderSelection();
    renderJob();
    renderConfirmation();
    renderHistory();
  }

  function activateSource(source) {
    if (!globalThis.XListAccounts.SOURCES.includes(source)) return;
    state.activeSource = source;
    refs.accountResults.querySelector(".filters-panel").open = false;
    refs.host.shadowRoot.querySelectorAll("details[data-source]").forEach((node) => { node.open = node.dataset.source === source; });
    refs.listViewport.scrollTop = 0;
    refs.panel.querySelector(".xcurator-body").scrollTop = 0;
    persistSoon();
    render();
  }

  function renderSources() {
    const shadow = refs.host.shadowRoot;
    const checked = selectedSet();
    if (state.activeSource === "legacy" && !state.collections.legacy.length) {
      state.activeSource = state.collections.following.length ? "following" : "custom";
      shadow.querySelector(`[data-source="${state.activeSource}"]`).open = true;
    }
    shadow.querySelector('[data-source="legacy"]').hidden = !state.collections.legacy.length;
    for (const source of globalThis.XListAccounts.SOURCES) {
      const ids = state.collections[source];
      const selected = ids.filter((id) => checked.has(id)).length;
      shadow.querySelector(`[data-source-count="${source}"]`).textContent = `${ids.length} 人${selected ? ` · 已选 ${selected}` : ""}`;
    }
    const slot = shadow.querySelector(`[data-results-slot="${state.activeSource}"]`);
    if (refs.accountResults.parentNode !== slot) slot.appendChild(refs.accountResults);
  }

  function resetFollowingCapture() {
    runtime.captureGeneration += 1;
    runtime.captureClearPending = true;
    window.postMessage({ source: SOURCE, kind: "CLEAR_CAPTURED_USERS" }, "*");
  }

  function clearCurrentSource() {
    if (runtime.storageCorrupt) return showToast("本地状态异常，已阻止修改名单");
    if (runtime.accountImport?.running) return showToast("请先停止名单解析，再清空名单");
    const source = state.activeSource;
    if (!state.collections[source].length) return;
    if (!window.confirm(`清空${SOURCE_LABELS[source]}？共用账号缓存仍会保留，不会修改 X 列表或当前任务。`)) return;
    globalThis.XListAccounts.clearSource(state, source);
    if (source === "following") resetFollowingCapture();
    if (source === "custom") runtime.accountImport.reset();
    persistNow();
    render();
    showToast("本组名单已清空，账号资料仍保留在共用缓存中");
  }

  function mergeUsers(incoming, source) {
    if (runtime.storageCorrupt) return;
    const { overflow } = globalThis.XListAccounts.merge(state, incoming, source);
    if (overflow) showToast("共用缓存已达到 5,000 个账号，请清除不需要的缓存后重试");
    persistSoon();
    if (runtime.panelOpen) render();
  }

  function clearCapturedUsers() {
    if (runtime.storageCorrupt) return showToast("本地状态异常，已阻止修改缓存");
    if (runtime.accountImport?.running) return showToast("请先停止名单解析，再清除账号");
    if (!state.users.length) return showToast("当前没有账号缓存");
    if (!window.confirm("清除所有来源的账号缓存、名单和勾选状态？X 列表成员、当前任务、历史记录和冷却时间不受影响。")) return;
    globalThis.XListAccounts.clearAll(state);
    runtime.accountImport.reset();
    runtime.filteredUsers = [];
    resetFollowingCapture();
    persistNow();
    render();
    showToast("已清除全部账号缓存；任务、历史记录和冷却时间已保留");
  }

  function selectFiltered() {
    const set = selectedSet();
    runtime.filteredUsers.forEach((user) => set.add(user.id));
    state.selectedIds = Array.from(set);
    persistSoon();
    render();
  }

  function clearSelection() {
    const ids = new Set(state.collections[state.activeSource]);
    state.selectedIds = state.selectedIds.filter((id) => !ids.has(id));
    persistSoon();
    render();
  }

  function invertSelection() {
    const set = selectedSet();
    runtime.filteredUsers.forEach((user) => set.has(user.id) ? set.delete(user.id) : set.add(user.id));
    state.selectedIds = Array.from(set);
    persistSoon();
    render();
  }

  function exportCsv() {
    const chosen = state.users.filter((user) => state.selectedIds.includes(user.id));
    if (!chosen.length) return showToast("请先选择至少一个用户");
    const headers = ["USERID", "handle", "name", "bio", "location", "followers", "following", "posts"];
    const csvCell = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
    const csv = [headers.join(","), ...chosen.map((user) => [user.id, user.handle, user.name, user.bio, user.location, user.followers, user.following, user.posts].map(csvCell).join(","))].join("\n");
    const blob = new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `x-following-selection-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportJob() {
    if (!state.job) return showToast("当前没有导入任务");
    const users = new Map(state.users.map((user) => [user.id, user]));
    const headers = ["USERID", "handle", "name", "status", "attempts", "http_status", "error_code", "error_path", "response_shape", "duration_ms", "last_error"];
    const csvCell = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
    const csv = [headers.join(","), ...state.job.queue.map((item) => {
      const user = users.get(item.userId) || {};
      return [item.userId, user.handle || "", user.name || "", item.status, item.attempts || 0, item.httpStatus || 0, item.errorCode || "", item.errorPath || "", item.responseShape || "", item.durationMs || 0, item.lastError || ""].map(csvCell).join(",");
    })].join("\n");
    const blob = new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `x-list-import-result-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function downloadJson(filename, value) {
    const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportSnapshot() {
    if (!state.job) return showToast("当前没有导入任务");
    downloadJson(`x-list-job-${state.job.id}.json`, { schemaVersion: state.schemaVersion, exportedAt: Date.now(), job: state.job });
  }

  function importSnapshot() {
    refs.snapshotInput.click();
  }

  function importSnapshotFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result || ""));
        const imported = parsed?.job || parsed;
        if (!imported?.id || !imported?.listId || !Array.isArray(imported.queue) || !imported.queue.length) throw new Error("任务快照结构不完整");
        if (state.job && !["completed", "stopped"].includes(state.job.status)) throw new Error("请先暂停或归档当前任务");
        imported.status = "stopped";
        imported.cooldownUntil = 0;
        imported.updatedAt = Date.now();
        imported.queue.forEach((item) => { if (item.status === "in_flight") item.status = "retryable"; });
        state.job = imported;
        state.listUrl = imported.listUrl || state.listUrl;
        persistNow();
        render();
        showToast("任务快照已导入，校验通过后可继续");
      } catch (error) {
        showToast(`任务快照导入失败：${error?.message || "格式错误"}`);
      }
    };
    reader.readAsText(file);
  }

  function exportHistory(historyId) {
    const job = state.history.find((entry) => entry.id === historyId);
    if (job) downloadJson(`x-list-job-${job.id}.json`, { schemaVersion: state.schemaVersion, exportedAt: Date.now(), job });
  }

  function retryHistory(historyId) {
    if (state.job && state.job.status !== "completed" && state.job.status !== "stopped") return showToast("请先暂停或归档当前任务");
    const archived = state.history.find((entry) => entry.id === historyId);
    if (!archived) return;
    const copy = JSON.parse(JSON.stringify(archived));
    copy.id = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    copy.status = "paused";
    copy.cooldownUntil = 0;
    copy.createdAt = Date.now();
    copy.updatedAt = Date.now();
    copy.queue.forEach((item) => {
      if (["failed", "retryable", "in_flight"].includes(item.status)) {
        item.status = "pending";
        item.attempts = 0;
        item.lastError = "";
        item.httpStatus = 0;
        item.errorCode = "";
        item.errorPath = "";
        item.responseShape = "";
        item.durationMs = 0;
        item.lastAttemptAt = 0;
        item.completedAt = 0;
      }
    });
    state.job = copy;
    persistNow();
    render();
    showToast("失败项已复制到新任务，点击“继续”开始");
  }

  function deleteHistory(historyId) {
    if (!window.confirm("删除这条历史任务记录？不会影响 X 列表里的已添加成员。")) return;
    state.history = state.history.filter((entry) => entry.id !== historyId);
    persistNow();
    render();
  }

  function loadState(saved) {
    if (!saved || typeof saved !== "object") return;
    const invalidJob = saved.job && (!Array.isArray(saved.job.queue) || !saved.job.listId);
    if ((saved.schemaVersion && Number(saved.schemaVersion) > 2) || (saved.users != null && !Array.isArray(saved.users)) || (saved.history != null && !Array.isArray(saved.history)) || (saved.collections != null && !globalThis.XListAccounts.validCollections(saved.collections)) || invalidJob) {
      runtime.storageCorrupt = true;
      return;
    }
    Object.assign(state, globalThis.XListAccounts.hydrate(saved));
    state.schemaVersion = 2;
    state.filters = normalizeFilters(saved.filters);
    state.filterDraft = normalizeFilters(saved.filterDraft || state.filters);
    state.listUrl = String(saved.listUrl || "");
    state.settings = { ...DEFAULT_SETTINGS, ...(saved.settings || {}) };
    state.job = saved.job ? globalThis.XListJob.normalizeAfterRestart(saved.job) : null;
    state.history = Array.isArray(saved.history) ? saved.history.slice(0, 20) : [];
    state.sessionFingerprint = String(saved.sessionFingerprint || "");
    state.lookupCooldownUntil = Number(saved.lookupCooldownUntil) || 0;
  }

  function addMemberViaPage(listId, userId) {
    const requestId = `add_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        runtime.pendingAdds.delete(requestId);
        resolve({ ok: false, retryable: true, resultKind: "failed", status: 0, message: "页面请求超时" });
      }, 45000);
      runtime.pendingAdds.set(requestId, (result) => { clearTimeout(timeout); resolve(result); });
      window.postMessage({ source: SOURCE, kind: "ADD_MEMBER", requestId, listId, userId }, "*");
    });
  }

  function cooldownFor(status) {
    if (status === 429 || status === 403) return 10 * 60 * 1000;
    if (status === 400) return 2 * 60 * 1000;
    return 60 * 1000;
  }

  function pauseForBatch(job) {
    const settings = job.settings || DEFAULT_SETTINGS;
    return Math.round(randomBetween(settings.pauseMin, settings.pauseMax) * 60 * 1000);
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function clearCooldownTimers() {
    if (runtime.cooldownTimer) clearTimeout(runtime.cooldownTimer);
    if (runtime.cooldownTicker) clearInterval(runtime.cooldownTicker);
    runtime.cooldownTimer = 0;
    runtime.cooldownTicker = 0;
  }

  function isBatchWaiting(job) {
    return Boolean(job && job.status === "cooldown" && job.cooldownReason === "batch" && Number(job.cooldownUntil || 0) > Date.now());
  }

  function isAutoBatchCooldown(job) {
    return Boolean(job && job.status === "cooldown" && job.cooldownReason === "batch");
  }

  function refreshCooldownDisplay() {
    if (!isAutoBatchCooldown(state.job)) {
      if (runtime.cooldownTicker) clearCooldownTimers();
      return;
    }
    renderJob();
  }

  function scheduleAutoResume(job) {
    clearCooldownTimers();
    if (!isAutoBatchCooldown(job)) return;
    const jobId = job.id;
    const waitMs = Math.max(0, Number(job.cooldownUntil) - Date.now());
    runtime.cooldownTicker = setInterval(refreshCooldownDisplay, 1000);
    runtime.cooldownTimer = setTimeout(() => autoResumeBatch(jobId), waitMs + 25);
  }

  async function autoResumeBatch(jobId) {
    const job = state.job;
    if (!job || job.id !== jobId || !isAutoBatchCooldown(job)) return;
    if (Number(job.cooldownUntil || 0) > Date.now()) return scheduleAutoResume(job);
    if (!runtime.sessionFingerprint) {
      runtime.cooldownTimer = setTimeout(() => autoResumeBatch(jobId), 5000);
      return;
    }
    clearCooldownTimers();
    job.cooldownUntil = 0;
    job.cooldownReason = "";
    await persistNow();
    render();
    runJob();
  }

  async function cancelBatchWaitAndResume() {
    const job = state.job;
    if (!isBatchWaiting(job)) return runJob();
    clearCooldownTimers();
    job.cooldownUntil = 0;
    job.cooldownReason = "";
    await persistNow();
    showToast("已取消批次等待，正在继续任务");
    runJob();
  }

  async function runJob() {
    if (runtime.running || !state.job) return;
    const job = state.job;
    if (!(await validateJobForResume(job))) return;
    if (runtime.accountImport?.blocked) return showToast("名单解析中或账号查询冷却中，请稍后再开始导入任务");
    if (job.status === "completed") return;
    if (job.cooldownUntil && Date.now() < job.cooldownUntil) {
      job.status = "cooldown";
      renderJob();
      if (job.cooldownReason === "batch") {
        scheduleAutoResume(job);
        showToast(`批次等待中，约 ${formatDuration(job.cooldownUntil - Date.now())} 后自动继续`);
      } else {
        showToast(`仍在冷却中，约 ${formatDuration(job.cooldownUntil - Date.now())} 后再继续`);
      }
      return;
    }
    clearCooldownTimers();
    runtime.running = true;
    runtime.stopRequested = false;
    job.status = "running";
    job.cooldownUntil = 0;
    job.cooldownReason = "";
    await persistNow();
    renderJob();
    try {
      while (!runtime.stopRequested && globalThis.XListJob.firstRunnable(job)) {
        const item = globalThis.XListJob.firstRunnable(job);
        job.currentItemId = item.userId;
        item.status = "in_flight";
        item.attempts = (item.attempts || 0) + 1;
        item.lastAttemptAt = Date.now();
        await persistNow();
        renderJob();
        const result = await addMemberViaPage(job.listId, item.userId);
        item.httpStatus = Number(result.status || 0);
        item.errorCode = String(result.errorCode || "");
        item.errorPath = String(result.errorPath || "");
        item.responseShape = String(result.responseShape || "");
        item.durationMs = Number(result.durationMs || 0);
        if (result.ok) {
          item.status = result.resultKind === "already_member" ? "already_member" : "succeeded";
          item.completedAt = Date.now();
          item.lastError = "";
          job.successCount = (job.successCount || 0) + 1;
        } else if (result.retryable && item.attempts < Number(job.settings.maxAttempts || DEFAULT_SETTINGS.maxAttempts)) {
          item.status = "retryable";
          item.lastError = result.message || `HTTP ${result.status || "?"}`;
          job.status = "cooldown";
          job.cooldownUntil = Date.now() + cooldownFor(result.status);
          job.cooldownReason = "platform";
          await persistNow();
          showToast(`X 暂停或拒绝了本次操作，${formatDuration(job.cooldownUntil - Date.now())} 后可继续`);
          break;
        } else {
          item.status = "failed";
          item.lastError = result.message || `HTTP ${result.status || "?"}`;
          job.failureCount = (job.failureCount || 0) + 1;
        }
        if (globalThis.XListJob.isComplete(job)) {
          job.status = "completed";
          job.completedAt = Date.now();
          break;
        }
        const completed = job.queue.filter((entry) => ["succeeded", "already_member"].includes(entry.status)).length;
        if (completed > 0 && completed % Number(job.settings.batchSize || DEFAULT_SETTINGS.batchSize) === 0) {
          job.status = "cooldown";
          job.cooldownUntil = Date.now() + pauseForBatch(job);
          job.cooldownReason = "batch";
          await persistNow();
          scheduleAutoResume(job);
          showToast(`已处理 ${completed} 人，进入批次暂停`);
          break;
        }
        await persistNow();
        renderJob();
        await delay(randomBetween(Number(job.settings.betweenMin), Number(job.settings.betweenMax)) * 1000);
      }
      if (!globalThis.XListJob.firstRunnable(job) && job.queue.length) {
        job.status = "completed";
        job.completedAt = Date.now();
      } else if (runtime.stopRequested && job.status === "running") {
        job.status = "paused";
      }
    } finally {
      job.currentItemId = "";
      runtime.running = false;
      await persistNow();
      render();
    }
  }

  async function validateJobForResume(job) {
    const parsed = parseListUrl(refs.listUrl.value || job.listUrl);
    if (!parsed || parsed.id !== String(job.listId) || parsed.id !== String(parseListUrl(job.listUrl)?.id || "")) {
      showToast("目标列表链接与任务不一致，请恢复原链接或先归档任务");
      return false;
    }
    if (!runtime.sessionFingerprint) {
      showToast("尚未取得当前 X 会话指纹，请等待页面请求完成后再继续");
      return false;
    }
    if (job.ownerFingerprint && job.ownerFingerprint !== runtime.sessionFingerprint) {
      showToast("当前 X 账号与创建任务时不同，已阻止续传");
      return false;
    }
    const ids = job.queue.map((item) => String(item.userId));
    if (job.queueHash && job.queueHash !== await queueFingerprint(job.listId, ids)) {
      showToast("任务队列校验失败，已阻止继续以避免错位添加");
      return false;
    }
    return true;
  }

  async function startOrResume() {
    if (runtime.accountImport?.blocked) return showToast("名单解析中或账号查询冷却中，请稍后再开始导入任务");
    if (runtime.running) return;
    if (runtime.storageCorrupt) return showToast("本地状态结构异常，已进入只读保护，请导出/清理后再开始");
    if (state.job && state.job.status !== "completed") return cancelBatchWaitAndResume();
    const parsed = parseListUrl(refs.listUrl.value);
    if (!parsed) return showToast("请输入有效的 X 列表分享链接");
    if (!state.selectedIds.length) return showToast("请先勾选要导入的用户");
    if (state.selectedIds.length > 5000) return showToast("单个 X 列表最多容纳 5,000 个账号");
    if (!refs.ackRisk.checked) return showToast("请先确认当前 X 会话的批量操作风险");
    if (!runtime.sessionFingerprint) return showToast("尚未取得当前 X 会话指纹，请等待页面请求完成后再开始");
    state.listUrl = refs.listUrl.value.trim();
    state.settings = currentSettings();
    const queueHash = await queueFingerprint(parsed.id, state.selectedIds);
    state.job = globalThis.XListJob.createJob({ listUrl: state.listUrl, listId: parsed.id, selectedIds: state.selectedIds, settings: state.settings, queueHash, ownerFingerprint: runtime.sessionFingerprint });
    runJob();
  }

  function resumeJob() {
    if (!state.job) return startOrResume();
    if (state.job.status === "completed") return;
    cancelBatchWaitAndResume();
  }

  function pauseJob() {
    if (!state.job) return;
    clearCooldownTimers();
    runtime.stopRequested = true;
    state.job.status = "paused";
    state.job.cooldownUntil = 0;
    state.job.cooldownReason = "";
    persistNow();
    renderJob();
  }

  function stopJob() {
    if (!state.job) return;
    clearCooldownTimers();
    runtime.stopRequested = true;
    state.job.status = "stopped";
    state.job.cooldownUntil = 0;
    state.job.cooldownReason = "";
    persistNow();
    renderJob();
    showToast("任务已停止，未处理项仍保留，可稍后继续或归档");
  }

  function archiveJob() {
    if (!state.job) return showToast("当前没有活动任务");
    if (runtime.running) return showToast("请先暂停任务，再结束任务");
    if (!window.confirm("结束当前任务？结束后不会自动继续，并会保存在历史任务中。")) return;
    const archived = JSON.parse(JSON.stringify({ ...state.job, status: state.job.status === "completed" ? "completed" : "stopped" }));
    clearCooldownTimers();
    state.history = [archived, ...(state.history || [])].slice(0, 20);
    state.job = null;
    persistNow();
    render();
  }

  function onMessage(event) {
    if (event.source !== window || event.data?.source !== SOURCE) return;
    const data = event.data;
    if (data.kind === "X_HOOK_READY") runtime.hookReady = true;
    if (data.kind === "X_SESSION_READY") {
      runtime.sessionReady = Boolean(data.ready || data.fingerprint);
      runtime.sessionFingerprint = String(data.fingerprint || runtime.sessionFingerprint || "");
      if (runtime.sessionFingerprint) state.sessionFingerprint = runtime.sessionFingerprint;
      persistSoon();
      if (isBatchWaiting(state.job)) scheduleAutoResume(state.job);
    }
    if (data.kind === "X_CAPTURE_CLEARED") {
      runtime.captureGeneration = Number(data.captureGeneration || runtime.captureGeneration);
      runtime.captureClearPending = false;
    }
    if (["X_USERS", "X_SNAPSHOT", "X_PROFILE_USERS"].includes(data.kind)) {
      const generation = Number(data.captureGeneration || 0);
      if (!runtime.captureClearPending && generation >= runtime.captureGeneration) {
        runtime.captureGeneration = generation;
        mergeUsers(data.users, data.kind === "X_PROFILE_USERS" ? undefined : "following");
      }
    }
    if (data.kind === "X_ADD_RESULT") {
      const resolve = runtime.pendingAdds.get(data.requestId);
      if (resolve) { runtime.pendingAdds.delete(data.requestId); resolve(data); }
    }
    if (runtime.panelOpen) renderPageStatus();
  }

  async function init() {
    window.addEventListener("message", onMessage);
    chrome.runtime.onMessage.addListener((message) => { if (message?.type === "TOGGLE_PANEL") runtime.panelOpen ? closePanel() : openPanel(); });
    createUi();
    try {
      loadState(await globalThis.XListStore.load());
    } catch (error) {
      showToast(`读取本地状态失败：${error?.message || "storage error"}`);
    }
    activateSource(state.activeSource);
    if (isBatchWaiting(state.job)) scheduleAutoResume(state.job);
    window.postMessage({ source: SOURCE, kind: "REQUEST_SNAPSHOT" }, "*");
  }

  init();
})();
