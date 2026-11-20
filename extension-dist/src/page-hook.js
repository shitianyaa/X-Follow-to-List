(function installXPageHook() {
  if (window.__xFollowingCuratorHookInstalled) return;
  window.__xFollowingCuratorHookInstalled = true;

  const SOURCE = "x-list-curator";
  const GRAPHQL_RE = /\/i\/api\/graphql\//i;
  const FOLLOWING_RE = /following|friends|userfollow/i;
  const METRICS = ["followers", "following", "posts"];
  const ADD_ENDPOINT = "https://x.com/i/api/graphql/EQ9KOQeashjfWnwFvcSSpg/ListAddMember";
  const session = {
    authorization: "",
    csrf: "",
    transaction: "",
    activeUser: "yes",
    authType: "OAuth2Session",
    fingerprint: ""
  };
  const capturedUsers = new Map();
  const profileUsers = new Map();
  let captureGeneration = 0;
  let lookupTemplate = null;
  let lookupRunning = false;

  function post(kind, detail) {
    window.postMessage({ source: SOURCE, ...(detail || {}), kind }, "*");
  }

  async function refreshSessionFingerprint() {
    const cookie = document.cookie.match(/(?:^|;\s*)ct0=([^;]+)/)?.[1] || "";
    if (!cookie) return;
    try {
      const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(decodeURIComponent(cookie)));
      session.fingerprint = Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
      post("X_SESSION_READY", { ready: Boolean(session.authorization), fingerprint: session.fingerprint });
    } catch (_) {}
  }

  function mergeProfile(previous, user) {
    const merged = { ...previous, ...user };
    for (const key of METRICS) merged[key] = user[key] ?? previous?.[key] ?? null;
    return merged;
  }

  function emitUsers(users, url, generation = captureGeneration, profile = false) {
    if (generation !== captureGeneration) return;
    for (const user of users || []) {
      // Profile responses may arrive before the content script finishes loading.
      if (profile && user?.id) {
        profileUsers.set(String(user.id), mergeProfile(profileUsers.get(String(user.id)), user));
        if (profileUsers.size > 5000) profileUsers.delete(profileUsers.keys().next().value);
      }
      if (user?.id && (!profile || capturedUsers.has(String(user.id)))) {
        capturedUsers.set(String(user.id), mergeProfile(capturedUsers.get(String(user.id)), user));
      }
    }
    const compact = Array.from(capturedUsers.values()).slice(-5000);
    post(profile ? "X_PROFILE_USERS" : "X_USERS", { users, url, total: compact.length, captureGeneration });
  }

  function headerEntries(headers) {
    if (!headers) return [];
    try {
      if (headers instanceof Headers) return Array.from(headers.entries());
      if (Array.isArray(headers)) return headers;
      return Object.entries(headers);
    } catch (_) {
      return [];
    }
  }

  function inspectRequest(input, init) {
    const entries = [
      ...headerEntries(input instanceof Request ? input.headers : null),
      ...headerEntries(init?.headers)
    ];
    for (const [key, value] of entries) {
      const name = String(key).toLowerCase();
      if (name === "authorization" && value) session.authorization = String(value);
      if (name === "x-csrf-token" && value) session.csrf = String(value);
      if (name === "x-client-transaction-id" && value) session.transaction = String(value);
      if (name === "x-twitter-active-user" && value) session.activeUser = String(value);
      if (name === "x-twitter-auth-type" && value) session.authType = String(value);
    }
    const cookie = document.cookie.match(/(?:^|;\s*)ct0=([^;]+)/)?.[1];
    if (cookie) session.csrf = decodeURIComponent(cookie);
    if (session.authorization || session.csrf) refreshSessionFingerprint();
  }

  function text(value) {
    return value == null ? "" : String(value);
  }

  function getId(obj) {
    return text(obj?.rest_id || obj?.id_str || obj?.id || obj?.user_id);
  }

  function getLegacy(obj) {
    return obj?.legacy || obj?.user_results?.result?.legacy || obj;
  }

  function getHandle(obj) {
    const legacy = getLegacy(obj);
    return text(obj?.core?.screen_name || legacy?.screen_name || obj?.screen_name || obj?.username);
  }

  function getName(obj) {
    const legacy = getLegacy(obj);
    return text(obj?.core?.name || legacy?.name || obj?.name);
  }

  function getAvatar(obj) {
    const legacy = getLegacy(obj);
    return text(obj?.avatar?.image_url || obj?.profile_image_url_https || legacy?.profile_image_url_https);
  }

  function getLocation(obj) {
    for (const value of [obj?.location?.location, obj?.location, getLegacy(obj)?.location]) {
      if (typeof value === "string") return value;
    }
    return "";
  }

  function getCount(...values) {
    for (const value of values) {
      if (value == null || !["number", "string"].includes(typeof value) || (typeof value === "string" && !value.trim())) continue;
      const number = Number(value);
      if (Number.isSafeInteger(number) && number >= 0) return number;
    }
    return null;
  }

  function looksLikeUser(obj) {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
    const id = getId(obj);
    const handle = getHandle(obj);
    return Boolean(id && handle && (obj.legacy || obj.core || obj.profile_image_url_https || obj.user_results));
  }

  function extractUsers(payload) {
    const found = new Map();
    const walk = (node, depth) => {
      if (!node || depth > 18 || typeof node !== "object") return;
      if (Array.isArray(node)) {
        for (const child of node) walk(child, depth + 1);
        return;
      }
      if (looksLikeUser(node)) {
        const id = getId(node);
        const legacy = getLegacy(node);
        const user = {
          id,
          handle: getHandle(node),
          name: getName(node),
          bio: text(node?.profile_bio?.description || legacy?.description || node?.description),
          location: getLocation(node),
          avatar: getAvatar(node),
          followers: getCount(node?.relationship_counts?.followers, legacy?.followers_count, node?.public_metrics?.followers_count),
          following: getCount(node?.relationship_counts?.following, legacy?.friends_count, node?.public_metrics?.following_count),
          posts: getCount(node?.tweet_counts?.tweets, legacy?.statuses_count, node?.public_metrics?.tweet_count),
          statsVersion: 2,
          verified: Boolean(node?.is_blue_verified || node?.verification?.verified || legacy?.verified || legacy?.is_blue_verified),
          protected: Boolean(legacy?.protected || node?.protected),
          mutual: Boolean(
            node?.relationship_perspectives?.followed_by ||
            node?.relationship?.source?.followed_by ||
            node?.relationship?.followed_by ||
            legacy?.followed_by
          ),
          capturedAt: Date.now()
        };
        const previous = found.get(id);
        if (previous) {
          for (const key of METRICS) if (previous[key] == null) previous[key] = user[key];
        } else found.set(id, user);
      }
      for (const value of Object.values(node)) walk(value, depth + 1);
    };
    walk(payload, 0);
    return Array.from(found.values());
  };

  function isRelevantUrl(url) {
    // Do not use the page path as a fallback here. X issues many unrelated
    // GraphQL requests while its Following page is open (profiles, suggestions,
    // lists, prefetches, etc.), and their user objects are not followed accounts.
    return GRAPHQL_RE.test(url || "") && FOLLOWING_RE.test(url || "");
  }

  function rememberLookupRequest(value) {
    try {
      const url = new URL(value, location.origin);
      if (url.origin !== location.origin || !/^\/i\/api\/graphql\/[\w-]+\/UserByScreenName$/.test(url.pathname)) return;
      const variables = JSON.parse(url.searchParams.get("variables") || "null");
      if (!variables || !/^[a-zA-Z0-9_]{1,15}$/.test(variables.screen_name || "")) return;
      lookupTemplate = url.href;
      post("X_LOOKUP_READY", { ready: true });
      return true;
    } catch (_) {}
  }

  function wrapFetch() {
    const originalFetch = window.fetch;
    window.fetch = async function patchedFetch(input, init) {
      const url = typeof input === "string" ? input : input?.url || "";
      inspectRequest(input, init);
      const requestGeneration = captureGeneration;
      const response = await originalFetch.apply(this, arguments);
      const profile = Boolean(response.ok && rememberLookupRequest(url));
      if (isRelevantUrl(url) || profile) {
        response.clone().json().then((payload) => {
          const users = extractUsers(payload);
          if (users.length) emitUsers(users, url, requestGeneration, profile);
        }).catch(() => {});
      }
      return response;
    };
  }

  function wrapXhr() {
    const open = XMLHttpRequest.prototype.open;
    const send = XMLHttpRequest.prototype.send;
    const setHeader = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.open = function patchedOpen(method, url) {
      this.__xCuratorUrl = String(url || "");
      return open.apply(this, arguments);
    };
    XMLHttpRequest.prototype.setRequestHeader = function patchedSetHeader(name, value) {
      const key = String(name).toLowerCase();
      if (key === "authorization") session.authorization = String(value);
      if (key === "x-csrf-token") session.csrf = String(value);
      if (key === "x-client-transaction-id") session.transaction = String(value);
      return setHeader.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function patchedSend() {
      const url = this.__xCuratorUrl || "";
      const requestGeneration = captureGeneration;
      this.addEventListener("load", () => {
        if (this.status < 200 || this.status >= 300) return;
        const profile = Boolean(rememberLookupRequest(url));
        if (!isRelevantUrl(url) && !profile) return;
        try {
          const users = extractUsers(JSON.parse(this.responseText));
          if (users.length) emitUsers(users, url, requestGeneration, profile);
        } catch (_) {}
      });
      inspectRequest(null, { headers: { "x-csrf-token": document.cookie.match(/(?:^|;\s*)ct0=([^;]+)/)?.[1] || "" } });
      return send.apply(this, arguments);
    };
  }

  function sessionHeaders() {
    const csrf = session.csrf || document.cookie.match(/(?:^|;\s*)ct0=([^;]+)/)?.[1] || "";
    const headers = {
      accept: "*/*",
      "content-type": "application/json",
      "x-csrf-token": decodeURIComponent(csrf),
      "x-twitter-active-user": session.activeUser || "yes",
      "x-twitter-auth-type": session.authType || "OAuth2Session"
    };
    if (session.authorization) headers.authorization = session.authorization;
    if (session.transaction) headers["x-client-transaction-id"] = session.transaction;
    return headers;
  }

  async function lookupUser({ requestId, handle }) {
    const reply = (result) => post("X_LOOKUP_RESULT", { requestId, ...result });
    if (!/^[a-zA-Z0-9_]{1,15}$/.test(handle || "")) return reply({ ok: false, message: "用户名格式无效" });
    if (!lookupTemplate) return reply({ ok: false, halt: true, message: "请先打开任意 X 个人主页，等待资料加载后再解析名单" });
    if (!session.authorization || !session.csrf) return reply({ ok: false, halt: true, message: "尚未连接登录会话，请刷新 X 页面后打开个人主页" });
    if (lookupRunning) return reply({ ok: false, halt: true, message: "已有账号查询正在进行，请稍后重试" });
    lookupRunning = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const url = new URL(lookupTemplate);
      const variables = JSON.parse(url.searchParams.get("variables"));
      variables.screen_name = handle;
      url.searchParams.set("variables", JSON.stringify(variables));
      const response = await fetch(url.href, { credentials: "include", headers: sessionHeaders(), signal: controller.signal });
      const parsed = await response.json().catch(() => null);
      const errors = Array.isArray(parsed?.errors) ? parsed.errors : [];
      const codes = errors.map((error) => Number(error?.code));
      const status = codes.includes(88) ? 429 : codes.some((code) => [32, 89].includes(code)) ? 401 : codes.some((code) => [326, 353].includes(code)) ? 403 : response.status;
      const retryable = [400, 401, 403, 429].includes(status) || status >= 500;
      const retryHeader = response.headers.get("retry-after");
      const retryAfterMs = retryHeader ? Math.max(0, /^\d+$/.test(retryHeader) ? Number(retryHeader) * 1000 : Date.parse(retryHeader) - Date.now()) || 0 : 0;
      if (retryable) return reply({ ok: false, halt: true, retryable: true, status, retryAfterMs, message: errors[0]?.message || `X 暂停或拒绝了账号查询（HTTP ${status}），请等待冷却后重试` });
      if (status === 404) {
        lookupTemplate = null;
        return reply({ ok: false, halt: true, status, message: "账号查询接口已失效，请刷新页面并重新打开个人主页" });
      }
      if (!response.ok || !parsed) return reply({ ok: false, halt: true, status, message: "X 返回了无法识别的账号查询响应，请刷新个人主页后重试" });
      const user = extractUsers(parsed).find((entry) => entry.handle.toLowerCase() === handle.toLowerCase() && /^\d+$/.test(entry.id));
      if (!user) return reply({ ok: false, status, message: errors[0]?.message || parsed?.data?.user?.result?.reason || "账号不存在、已停用或当前不可访问" });
      reply({ ok: true, user, status });
    } catch (error) {
      reply({ ok: false, halt: true, retryable: true, status: 0, message: error?.name === "AbortError" ? "账号查询超时，请稍后重试" : "账号查询网络异常，请稍后重试" });
    } finally {
      clearTimeout(timer);
      lookupRunning = false;
    }
  }

  async function addMember({ requestId, listId, userId }) {
    const startedAt = Date.now();
    const headers = sessionHeaders();
    const body = {
      variables: { listId: String(listId), userId: String(userId) },
      features: {
        graphql_timeline_v2_bookmark_timeline: true,
        responsive_web_graphql_exclude_directive_enabled: true,
        verified_backsplash_enabled: true,
        responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
        longform_notetweets_rich_text_read_enabled: true
      }
    };
    try {
      const response = await fetch(ADD_ENDPOINT, {
        method: "POST",
        credentials: "include",
        headers,
        body: JSON.stringify(body)
      });
      const raw = await response.text();
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch (_) {}
      const errors = Array.isArray(parsed?.errors) ? parsed.errors : [];
      const errorMessages = errors.map((error) => String(error?.message || "")).filter(Boolean).slice(0, 3);
      const errorCodes = errors.map((error) => String(error?.code ?? error?.extensions?.code ?? "")).filter(Boolean).slice(0, 3);
      const errorPaths = errors.map((error) => Array.isArray(error?.path) ? error.path.join(".") : "").filter(Boolean).slice(0, 3);
      const responseShape = parsed?.data && typeof parsed.data === "object" ? Object.keys(parsed.data).slice(0, 12).join("|") : "";
      const listData = parsed?.data?.list;
      const hasListData = Boolean(listData && typeof listData === "object" && (listData.id || listData.id_str || listData.member_count != null || listData.members_context));
      const auxiliaryOnly = errors.length > 0 && errors.every((error) => {
        const path = Array.isArray(error?.path) ? error.path.join(".") : "";
        return path === "list.default_banner_media_results.result" || path.includes("default_banner_media");
      });
      const errorText = errorMessages.join(" ").toLowerCase();
      let kind = "failed";
      if (response.ok && hasListData && (errors.length === 0 || auxiliaryOnly)) kind = "succeeded";
      else if (response.ok && /already[\s_-]*(a\s+)?member|already\s+in\s+(the\s+)?list|duplicate/.test(errorText)) kind = "already_member";
      else if (response.ok && parsed?.data && !errors.length) kind = "succeeded";
      const retryable = response.status === 400 || response.status === 403 || response.status === 429 || response.status >= 500;
      post("X_ADD_RESULT", {
        requestId,
        ok: kind === "succeeded" || kind === "already_member",
        resultKind: kind,
        retryable,
        status: response.status,
        message: errorMessages[0] || (kind === "failed" ? raw.slice(0, 240) : ""),
        errorCode: errorCodes[0] || "",
        errorPath: errorPaths[0] || "",
        responseShape,
        durationMs: Date.now() - startedAt
      });
    } catch (error) {
      post("X_ADD_RESULT", { requestId, ok: false, resultKind: "failed", retryable: true, status: 0, message: error?.message || "network error", errorCode: "NETWORK", errorPath: "", responseShape: "", durationMs: Date.now() - startedAt });
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== SOURCE) return;
    if (event.data.kind === "ADD_MEMBER") addMember(event.data);
    if (event.data.kind === "LOOKUP_USER") lookupUser(event.data);
    if (event.data.kind === "REQUEST_SNAPSHOT") {
      post("X_SNAPSHOT", { users: Array.from(capturedUsers.values()).slice(-5000), captureGeneration });
      post("X_PROFILE_USERS", { users: Array.from(profileUsers.values()), captureGeneration });
      if (lookupTemplate) post("X_LOOKUP_READY", { ready: true });
      if (session.authorization || session.csrf) refreshSessionFingerprint();
    }
    if (event.data.kind === "CLEAR_CAPTURED_USERS") {
      capturedUsers.clear();
      profileUsers.clear();
      captureGeneration += 1;
      post("X_CAPTURE_CLEARED", { captureGeneration });
      post("X_SNAPSHOT", { users: [], captureGeneration });
    }
  });

  wrapFetch();
  wrapXhr();
  post("X_HOOK_READY", { ready: true });
})();
