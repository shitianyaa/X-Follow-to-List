(function attachAccountImport(global) {
  const SOURCE = "x-list-curator";
  const MAX_TEXT = 1024 * 1024;
  const MAX_USERS = 5000;
  const HANDLE_RE = /^[a-zA-Z0-9_]{1,15}$/;
  const RESERVED = new Set(["home", "explore", "notifications", "messages", "settings", "i", "search", "compose", "intent", "share", "login", "logout", "signup", "tos", "privacy"]);

  function csvRows(text) {
    const rows = [];
    let row = [], cell = "", quoted = false;
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (char === '"') {
        if (quoted && text[i + 1] === '"') { cell += '"'; i++; }
        else if (quoted || !cell.trim()) quoted = !quoted;
        else cell += char;
      } else if (!quoted && (char === "," || char === "\n" || char === "\r")) {
        row.push(cell.trim());
        cell = "";
        if (char !== ",") {
          rows.push(row);
          row = [];
          if (char === "\r" && text[i + 1] === "\n") i++;
        }
      } else cell += char;
    }
    if (quoted) throw new Error("CSV 引号未闭合，请检查文件格式");
    row.push(cell.trim());
    rows.push(row);
    return rows.filter((cells) => cells.some(Boolean));
  }

  function parse(text) {
    text = String(text || "").replace(/^\uFEFF/, "");
    if (text.length > MAX_TEXT) throw new Error("名单过大，请使用不超过 1 MB 的文本");
    const rows = csvRows(text);
    const column = rows.length > 1 ? rows[0].findIndex((cell) => /^(handle|screen_name|username|profile_url|url)$/i.test(cell)) : -1;
    const tokens = column >= 0 ? rows.slice(1).map((row) => row[column] || "") : rows.flat();
    const handles = [], invalid = [], seen = new Set();
    let duplicates = 0;
    for (const token of tokens.flatMap((cell) => cell.split(/[\s，;；、]+/)).filter(Boolean)) {
      let handle = token.replace(/^@/, "");
      if (/^(?:https?:\/\/|(?:www\.|mobile\.)?(?:x|twitter)\.com\/)/i.test(token)) {
        try {
          const url = new URL(/^https?:\/\//i.test(token) ? token : `https://${token}`);
          if (!/^(?:(?:www|mobile)\.)?(?:x|twitter)\.com$/i.test(url.hostname) || url.username || url.password || url.port) throw new Error();
          handle = url.pathname.match(/^\/([a-zA-Z0-9_]{1,15})\/?$/)?.[1] || "";
        } catch (_) { handle = ""; }
      }
      if (!HANDLE_RE.test(handle) || RESERVED.has(handle.toLowerCase())) { invalid.push(token); continue; }
      const key = handle.toLowerCase();
      if (seen.has(key)) { duplicates++; continue; }
      seen.add(key);
      handles.push(handle);
    }
    if (handles.length > MAX_USERS) throw new Error("每次最多解析 5,000 个账号");
    return { handles, invalid, duplicates };
  }

  function mount({ root, getUsers, beginImport, onStateChange, canImport, getSettings, getCooldown, onRateLimit, mergeUsers, showToast }) {
    root.innerHTML = `
      <style>
        .account-input { width: 100%; min-height: 86px; resize: vertical; padding: 8px 9px; border: 1px solid #355448; border-radius: 8px; color: #eef5ef; background: #0d1514; font: inherit; }
        .account-input:focus { outline: 2px solid #8edca5; outline-offset: 1px; }
        .account-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
        .account-errors { max-height: 110px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; color: #e9c68b; font: inherit; font-size: 11px; }
      </style>
      <label class="field"><span>用户名、@用户名或 X 个人主页链接</span><textarea class="account-input" placeholder="@alice, bob, https://x.com/carol" aria-label="自定义账号名单" spellcheck="false"></textarea></label>
      <div class="selection-hint">支持英文/中文逗号、换行、空格、分号；CSV 支持 handle、username 或 profile_url 列。</div>
      <label class="selection-hint"><input type="checkbox" data-import="refresh"> 补全缓存中的未知统计（每个缺失账号额外查询一次）</label>
      <div class="account-actions"><button type="button" data-import="parse">解析名单</button><button type="button" data-import="file">导入 TXT / CSV</button><button type="button" data-import="stop" hidden>停止解析</button></div>
      <div class="selection-hint" data-import="status" role="status" aria-live="polite">首次解析前，请打开任意 X 个人主页以连接账号查询。解析后在下方勾选要添加的账号。</div>
      <pre class="account-errors" data-import="errors" hidden></pre>
      <input type="file" data-import="input" accept=".txt,.csv,text/plain,text/csv" hidden>`;
    const input = root.querySelector("textarea");
    const refs = Object.fromEntries(Array.from(root.querySelectorAll("[data-import]")).map((node) => [node.dataset.import, node]));
    const pending = new Map();
    let running = false, stopped = false, attempted = false;

    global.addEventListener("message", (event) => {
      if (event.source !== global || event.data?.source !== SOURCE) return;
      if (event.data.kind === "X_LOOKUP_READY" && !running && !attempted) refs.status.textContent = "已连接账号查询。粘贴名单后点击“解析名单”，再在下方勾选要添加的账号。";
      if (event.data.kind !== "X_LOOKUP_RESULT") return;
      const resolve = pending.get(event.data.requestId);
      if (resolve) { pending.delete(event.data.requestId); resolve(event.data); }
    });

    function lookup(handle) {
      const requestId = `lookup_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          resolve({ ok: false, halt: true, retryable: true, status: 0, message: "账号查询超时，请检查网络后重试" });
        }, 35000);
        pending.set(requestId, (result) => { clearTimeout(timer); resolve(result); });
        global.postMessage({ source: SOURCE, kind: "LOOKUP_USER", requestId, handle }, "*");
      });
    }

    async function wait(ms) {
      const end = Date.now() + ms;
      while (!stopped && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, Math.min(250, end - Date.now())));
    }

    async function run() {
      if (running) return;
      if (getCooldown() > Date.now()) {
        refs.status.textContent = `账号查询冷却中，请约 ${Math.ceil((getCooldown() - Date.now()) / 60000)} 分钟后重试`;
        return;
      }
      if (!canImport()) return showToast("请先暂停导入任务并等待当前请求结束；限流冷却期间不能解析名单");
      let parsed;
      try { parsed = parse(input.value); }
      catch (error) { refs.status.textContent = error.message; return; }
      if (!parsed.handles.length) {
        refs.status.textContent = "没有可解析的用户名，请检查输入格式";
        refs.errors.textContent = parsed.invalid.map((token) => `格式无效：${token}`).join("\n");
        refs.errors.hidden = !parsed.invalid.length;
        return;
      }
      const known = new Map(getUsers().map((user) => [user.handle.toLowerCase(), user]));
      const fresh = parsed.handles.filter((handle) => !known.has(handle.toLowerCase()));
      const handles = parsed.handles.filter((handle) => {
        const user = known.get(handle.toLowerCase());
        return !user || (refs.refresh.checked && ["followers", "following", "posts"].some((key) => user[key] == null));
      });
      const existing = parsed.handles.length - fresh.length;
      const errors = parsed.invalid.map((token) => `格式无效：${token}`);
      if (getUsers().length + fresh.length > MAX_USERS) {
        refs.status.textContent = "本地账号总数将超过 5,000，请先清除不需要的账号再解析";
        return;
      }
      running = true;
      attempted = true;
      stopped = false;
      input.disabled = refs.parse.disabled = refs.file.disabled = refs.refresh.disabled = true;
      refs.stop.hidden = false;
      beginImport(parsed.handles);
      let done = 0, succeeded = 0, refreshed = 0;
      const settings = getSettings();
      const update = () => {
        refs.status.textContent = `${running ? "解析中" : stopped ? "解析已停止" : "解析完成"} · 已处理 ${done}/${handles.length} · 新增 ${succeeded} · 已收录 ${existing} · 补查 ${refreshed} · 重复 ${parsed.duplicates} · 无效 ${parsed.invalid.length} · 查询失败 ${errors.length - parsed.invalid.length}`;
        refs.errors.textContent = errors.join("\n");
        refs.errors.hidden = !errors.length;
      };
      update();
      try {
        for (const handle of handles) {
          if (stopped) break;
          const result = await lookup(handle);
          done++;
          if (result.ok && result.user?.id && String(result.user.handle).toLowerCase() === handle.toLowerCase()) {
            mergeUsers([result.user]);
            if (known.has(handle.toLowerCase())) refreshed++;
            else succeeded++;
          } else {
            errors.push(`@${handle}：${result.message || "未返回匹配的账号资料"}`);
            if (result.retryable) await onRateLimit(result);
            if (result.halt) stopped = true;
          }
          update();
          if (done < handles.length && !stopped) {
            const seconds = Number(settings.betweenMin) + Math.random() * (Number(settings.betweenMax) - Number(settings.betweenMin));
            const batch = done % Number(settings.batchSize) === 0;
            const minutes = Number(settings.pauseMin) + Math.random() * (Number(settings.pauseMax) - Number(settings.pauseMin));
            if (batch) refs.status.textContent += ` · 批次暂停约 ${Math.ceil(minutes)} 分钟`;
            await wait(batch ? minutes * 60000 : seconds * 1000);
          }
        }
      } catch (error) {
        stopped = true;
        errors.push(error?.message || "解析中断，请重试");
      } finally {
        running = false;
        input.disabled = refs.parse.disabled = refs.file.disabled = refs.refresh.disabled = false;
        refs.stop.hidden = true;
        update();
        if (getCooldown() > Date.now()) refs.status.textContent += ` · 冷却约 ${Math.ceil((getCooldown() - Date.now()) / 60000)} 分钟`;
        if (parsed.handles.length) refs.status.textContent += " · 请在下方勾选账号后导入到列表；默认复用缓存，勾选选项才补查未知统计";
        onStateChange();
      }
    }

    refs.parse.addEventListener("click", run);
    refs.stop.addEventListener("click", () => {
      stopped = true;
      refs.status.textContent = "正在停止解析，等待当前查询结束…";
    });
    refs.file.addEventListener("click", () => refs.input.click());
    refs.input.addEventListener("change", async () => {
      const file = refs.input.files?.[0];
      refs.input.value = "";
      if (!file || running) return;
      if (file.size > MAX_TEXT) { refs.status.textContent = "文件过大，请使用不超过 1 MB 的 TXT / CSV"; return; }
      try { input.value = await file.text(); await run(); }
      catch (error) { refs.status.textContent = `读取名单失败：${error?.message || "文件不可读"}`; }
    });
    return {
      get running() { return running; },
      get blocked() { return running || getCooldown() > Date.now(); },
      reset() {
        if (running) return;
        input.value = "";
        refs.refresh.checked = false;
        refs.errors.textContent = "";
        refs.errors.hidden = true;
        refs.status.textContent = "名单已清空；重新解析时仍可复用账号缓存";
      }
    };
  }

  global.XListImport = { parse, mount };
})(globalThis);
