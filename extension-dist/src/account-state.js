(function attachAccountState(global) {
  const MAX_USERS = 5000;
  const SOURCES = ["custom", "following", "legacy"];
  const METRICS = ["followers", "following", "posts"];

  function count(value) {
    if (value == null || !["number", "string"].includes(typeof value) || (typeof value === "string" && !value.trim())) return null;
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 ? number : null;
  }

  function normalizeUser(raw) {
    const id = String(raw?.id || raw?.rest_id || raw?.id_str || "").trim();
    const handle = String(raw?.handle || raw?.screen_name || "").replace(/^@/, "").trim();
    if (!/^\d+$/.test(id) || !/^[a-zA-Z0-9_]{1,15}$/.test(handle)) return null;
    const location = typeof raw.location === "object" ? raw.location?.location : raw.location;
    const user = {
      id, handle,
      name: String(raw.name || handle).trim(),
      bio: String(raw.bio || "").trim(),
      location: typeof location === "string" && location !== "[object Object]" ? location.trim() : "",
      avatar: String(raw.avatar || "").trim(),
      verified: Boolean(raw.verified), protected: Boolean(raw.protected), mutual: Boolean(raw.mutual),
      capturedAt: Number(raw.capturedAt) || Date.now(),
      statsVersion: 2
    };
    for (const key of METRICS) {
      const value = count(raw[key]);
      // Old caches used zero for missing data, so their zeros cannot be trusted.
      user[key] = raw.statsVersion === 2 || value !== 0 ? value : null;
    }
    return user;
  }

  function validCollections(value) {
    return value && typeof value === "object" && !Array.isArray(value) && SOURCES.every((source) => Array.isArray(value[source]));
  }

  function cleanIds(ids, users) {
    const known = new Set(users.map((user) => user.id));
    return Array.from(new Set((Array.isArray(ids) ? ids : []).map(String))).filter((id) => known.has(id));
  }

  function hydrate(saved) {
    const users = Array.from(new Map((saved.users || []).map(normalizeUser).filter(Boolean).map((user) => [user.id, user])).values()).slice(0, MAX_USERS);
    const collections = { custom: [], following: [], legacy: [] };
    if (validCollections(saved.collections)) {
      for (const source of SOURCES) collections[source] = cleanIds(saved.collections[source], users);
    } else {
      collections.legacy = users.map((user) => user.id);
    }
    const activeSource = SOURCES.includes(saved.activeSource) ? saved.activeSource : collections.legacy.length ? "legacy" : "custom";
    const visible = new Set(SOURCES.flatMap((source) => collections[source]));
    const selectedIds = cleanIds(saved.selectedIds, users).filter((id) => visible.has(id));
    return { users, collections, activeSource, selectedIds };
  }

  function pruneSelection(state) {
    const visible = new Set(SOURCES.flatMap((source) => state.collections[source]));
    state.selectedIds = state.selectedIds.filter((id) => visible.has(id));
  }

  function replaceSource(state, source, ids) {
    state.collections[source] = cleanIds(ids, state.users);
    if (source !== "legacy") {
      const classified = new Set(state.collections[source]);
      state.collections.legacy = state.collections.legacy.filter((id) => !classified.has(id));
    }
    pruneSelection(state);
  }

  function merge(state, incoming, source) {
    const users = new Map(state.users.map((user) => [user.id, user]));
    const ids = source ? new Set(state.collections[source]) : null;
    let overflow = 0;
    for (const raw of incoming || []) {
      const user = normalizeUser(raw);
      if (!user) continue;
      const previous = users.get(user.id);
      // Profile visits update cached accounts without changing source membership.
      if (!source && !previous) continue;
      if (!previous && users.size >= MAX_USERS) { overflow++; continue; }
      if (previous) {
        for (const key of METRICS) if (user[key] == null) user[key] = previous[key];
      }
      users.set(user.id, { ...previous, ...user });
      ids?.add(user.id);
    }
    state.users = Array.from(users.values());
    if (ids) replaceSource(state, source, Array.from(ids));
    return { overflow };
  }

  function clearSource(state, source) {
    state.collections[source] = [];
    pruneSelection(state);
  }

  function clearAll(state) {
    state.users = [];
    state.selectedIds = [];
    for (const source of SOURCES) state.collections[source] = [];
  }

  function sourceUsers(state) {
    const users = new Map(state.users.map((user) => [user.id, user]));
    return state.collections[state.activeSource].map((id) => users.get(id)).filter(Boolean);
  }

  function matchesRanges(user, filters) {
    for (const [key, suffix] of [["followers", "Followers"], ["following", "Following"], ["posts", "Posts"]]) {
      const min = filters[`min${suffix}`], max = filters[`max${suffix}`];
      const hasMin = min !== "" && min != null;
      const hasMax = max !== "" && max != null;
      if ((hasMin || hasMax) && user[key] == null) return false;
      if (hasMin && user[key] < Number(min)) return false;
      if (hasMax && user[key] > Number(max)) return false;
    }
    return true;
  }

  global.XListAccounts = { MAX_USERS, SOURCES, normalizeUser, validCollections, hydrate, replaceSource, merge, clearSource, clearAll, sourceUsers, matchesRanges };
})(globalThis);
