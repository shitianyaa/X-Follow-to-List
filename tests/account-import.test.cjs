const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");

const source = (name) => readFileSync(join(__dirname, "../extension-dist/src", name), "utf8");
const imports = { URL };
vm.runInNewContext(source("account-import.js"), imports);
const parse = (text) => JSON.parse(JSON.stringify(imports.XListImport.parse(text)));

test("parses comma, whitespace, Chinese punctuation and profile links with case-insensitive deduplication", () => {
  assert.deepEqual(parse("@Alice, bob\nhttps://x.com/CAROL?s=21，https://twitter.com/alice; dave\tEve、frank；www.x.com/grace"), {
    handles: ["Alice", "bob", "CAROL", "dave", "Eve", "frank", "grace"], invalid: [], duplicates: 1
  });
});

test("reads the extension's exported CSV, including quotes, commas, BOM and multiline biographies", () => {
  assert.deepEqual(parse('\uFEFFUSERID,handle,name,bio,location,followers,following,posts\r\n9007199254740993,alice,"Alice, A","Hello\n""world""",,1,2,3\r\n2,bob,Bob,,,0,0,0'), {
    handles: ["alice", "bob"], invalid: [], duplicates: 0
  });
  assert.deepEqual(parse("profile_url\nhttps://x.com/alice\nhttps://twitter.com/bob/").handles, ["alice", "bob"]);
  assert.deepEqual(parse("alice,username").handles, ["alice", "username"]);
});

test("rejects invalid usernames, non-profile URLs and unrelated hosts without fetching them", () => {
  const values = ["https://evil.example/alice", "https://x.com.evil.example/bob", "https://x.com/alice/status/1", "https://x.com/home", "https://user:pass@x.com/alice", "@bad-name", "a".repeat(16), "<script>"];
  assert.deepEqual(parse(values.join(",")), { handles: [], invalid: values, duplicates: 0 });
  assert.deepEqual(parse(" , \n"), { handles: [], invalid: [], duplicates: 0 });
  assert.throws(() => parse('"alice'), /引号/);
});

test("bounds input size and unique accounts", () => {
  assert.throws(() => parse("x".repeat(1024 * 1024 + 1)), /过大/);
  assert.equal(parse(Array.from({ length: 5000 }, (_, i) => `user${i}`).join(",")).handles.length, 5000);
  assert.throws(() => parse(Array.from({ length: 5001 }, (_, i) => `user${i}`).join(",")), /5,000/);
});

function hookHarness() {
  const messages = [], calls = [], listeners = [];
  let respond = () => new Response(JSON.stringify({ data: {} }), { headers: { "content-type": "application/json" } });
  class FakeXhr {
    constructor() { this.listeners = []; this.status = 200; this.responseText = "{}"; }
    open() {}
    setRequestHeader() {}
    addEventListener(kind, listener) { if (kind === "load") this.listeners.push(listener); }
    send() { this.listeners.forEach((listener) => listener()); }
  }
  const window = {
    addEventListener(kind, listener) { if (kind === "message") listeners.push(listener); },
    postMessage(data) { messages.push(data); listeners.forEach((listener) => listener({ source: window, data })); },
    async fetch(input, init) { calls.push({ url: String(input), init }); return respond(input, init); }
  };
  const context = {
    window, document: { cookie: "ct0=test-csrf" }, location: { origin: "https://x.com" },
    XMLHttpRequest: FakeXhr, Headers, Request, URL, AbortController, TextEncoder, crypto: webcrypto,
    setTimeout, clearTimeout, fetch: (...args) => window.fetch(...args)
  };
  vm.runInNewContext(source("page-hook.js"), context);
  const send = (kind, detail = {}) => window.postMessage({ source: "x-list-curator", kind, ...detail });
  const templateUrl = new URL("https://x.com/i/api/graphql/live-query-id/UserByScreenName");
  templateUrl.searchParams.set("variables", JSON.stringify({ screen_name: "seed", withSafetyModeUserFields: true }));
  templateUrl.searchParams.set("features", JSON.stringify({ observed_feature: true }));
  return {
    window, messages, calls, send, context, templateUrl,
    respond(fn) { respond = fn; },
    async prime() { await window.fetch(templateUrl.href, { headers: { authorization: "test-only-auth", "x-csrf-token": "test-csrf" } }); }
  };
}

async function result(harness, requestId) {
  for (let i = 0; i < 50; i++) {
    const found = harness.messages.find((message) => message.kind === "X_LOOKUP_RESULT" && message.requestId === requestId);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail(`Missing lookup result: ${requestId}`);
}

const userPayload = (handle = "alice", id = "9007199254740993") => ({ data: { user: { result: { rest_id: id, core: { screen_name: handle, name: "Alice" }, legacy: { description: "Example", followers_count: 42 } } } } });

test("requires a learned profile request and validates lookup input before making a request", async () => {
  const h = hookHarness();
  h.send("LOOKUP_USER", { requestId: "missing", handle: "alice" });
  assert.match((await result(h, "missing")).message, /个人主页/);
  h.send("LOOKUP_USER", { requestId: "invalid", handle: "../evil" });
  assert.equal((await result(h, "invalid")).ok, false);
  assert.equal(h.calls.length, 0);
  await h.window.fetch(h.templateUrl.href.replace("x.com/", "evil.example/"));
  h.send("LOOKUP_USER", { requestId: "foreign", handle: "alice" });
  assert.match((await result(h, "foreign")).message, /个人主页/);
});

test("replays observed query features, looks up an unfollowed account and preserves the string ID", async () => {
  const h = hookHarness();
  await h.prime();
  h.respond(() => new Response(JSON.stringify(userPayload())));
  h.send("LOOKUP_USER", { requestId: "success", handle: "ALICE" });
  const resolved = await result(h, "success");
  assert.equal(resolved.ok, true);
  assert.equal(resolved.user.id, "9007199254740993");
  assert.equal(resolved.user.followers, 42);
  const request = h.calls.at(-1);
  const url = new URL(request.url);
  assert.deepEqual(JSON.parse(url.searchParams.get("variables")), { screen_name: "ALICE", withSafetyModeUserFields: true });
  assert.deepEqual(JSON.parse(url.searchParams.get("features")), { observed_feature: true });
  assert.equal(request.init.credentials, "include");
  assert.equal(request.init.headers.authorization, "test-only-auth");
  assert.equal(h.messages.some((message) => message.kind === "X_USERS"), false);
  assert.equal(JSON.stringify(h.messages).includes("test-only-auth"), false);
});

test("learns the query through XMLHttpRequest as well as fetch", async () => {
  const h = hookHarness();
  const xhr = new h.context.XMLHttpRequest();
  xhr.open("GET", h.templateUrl.href);
  xhr.setRequestHeader("authorization", "test-only-auth");
  xhr.send();
  h.respond(() => new Response(JSON.stringify(userPayload())));
  h.send("LOOKUP_USER", { requestId: "xhr", handle: "alice" });
  assert.equal((await result(h, "xhr")).ok, true);
});

test("reads current profile counts and nested location without extra requests", async () => {
  const h = hookHarness();
  await h.prime();
  h.respond(() => new Response(JSON.stringify({ data: { user_result_by_screen_name: { result: {
    rest_id: "9007199254740993", core: { screen_name: "alice", name: "Alice" }, legacy: {},
    relationship_counts: { followers: 12345, following: 678 }, tweet_counts: { tweets: 9012 }, location: { location: "Tokyo" }
  } } } })));
  h.send("LOOKUP_USER", { requestId: "modern", handle: "alice" });
  const resolved = await result(h, "modern");
  assert.equal(resolved.ok, true);
  assert.equal(resolved.user.followers, 12345);
  assert.equal(resolved.user.following, 678);
  assert.equal(resolved.user.posts, 9012);
  assert.equal(resolved.user.location, "Tokyo");
  assert.equal(resolved.user.statsVersion, 2);
  assert.equal(h.calls.length, 2);
});

test("distinguishes genuine zero statistics from unavailable statistics", async () => {
  const h = hookHarness();
  await h.prime();
  const user = userPayload().data.user.result;
  user.relationship_counts = { followers: 0, following: 0 };
  user.tweet_counts = { tweets: 0 };
  user.location = { location: "Tokyo" };
  h.respond(() => new Response(JSON.stringify({ data: { user: { result: user } } })));
  h.send("LOOKUP_USER", { requestId: "zero", handle: "alice" });
  const zero = (await result(h, "zero")).user;
  assert.equal(zero.followers, 0);
  assert.equal(zero.following, 0);
  assert.equal(zero.posts, 0);
  delete user.relationship_counts;
  delete user.tweet_counts;
  user.legacy = {};
  h.send("LOOKUP_USER", { requestId: "unknown", handle: "alice" });
  const unknown = (await result(h, "unknown")).user;
  assert.equal(unknown.followers, null);
  assert.equal(unknown.following, null);
  assert.equal(unknown.posts, null);
  assert.equal(unknown.location, "Tokyo");
});

test("merges duplicate user objects in either order without losing counts or genuine zeroes", async () => {
  const h = hookHarness();
  await h.prime();
  const thin = { rest_id: "123", core: { screen_name: "alice", name: "Alice" }, legacy: {} };
  const rich = { ...thin, relationship_counts: { followers: 0, following: 10 }, tweet_counts: { tweets: 5 } };
  for (const [index, users] of [[thin, rich], [rich, thin]].entries()) {
    h.respond(() => new Response(JSON.stringify({ data: { users } })));
    h.send("LOOKUP_USER", { requestId: `duplicate-${index}`, handle: "alice" });
    const { user } = await result(h, `duplicate-${index}`);
    assert.equal(user.followers, 0);
    assert.equal(user.following, 10);
    assert.equal(user.posts, 5);
  }
  assert.equal(h.calls.length, 3);
});

test("partial captures preserve snapshot counts, while profile visits never add Following memberships", async () => {
  const h = hookHarness();
  const user = userPayload().data.user.result;
  const fetchPayload = async (url, users) => {
    h.respond(() => new Response(JSON.stringify({ data: { users } })));
    await h.window.fetch(url);
    await new Promise((resolve) => setTimeout(resolve, 10));
  };
  await fetchPayload("https://x.com/i/api/graphql/id/Following", [user]);
  await fetchPayload("https://x.com/i/api/graphql/id/Following", [{ ...user, legacy: {} }]);
  h.send("REQUEST_SNAPSHOT");
  assert.equal(h.messages.filter((message) => message.kind === "X_SNAPSHOT").at(-1).users[0].followers, 42);
  await fetchPayload(h.templateUrl.href, [{ ...user, relationship_counts: { followers: 0 } }, { ...user, rest_id: "2", core: { screen_name: "bob" } }]);
  const profile = h.messages.filter((message) => message.kind === "X_PROFILE_USERS").at(-1);
  assert.equal(profile.users.length, 2);
  assert.equal(h.messages.filter((message) => message.kind === "X_USERS").length, 2);
  h.send("REQUEST_SNAPSHOT");
  const snapshot = h.messages.filter((message) => message.kind === "X_SNAPSHOT").at(-1);
  assert.equal(snapshot.users.length, 1);
  assert.equal(snapshot.users[0].followers, 0);
  assert.equal(h.calls.length, 3);
});

test("nested legacy duplicates cannot replace modern counts or the parent profile", async () => {
  const h = hookHarness();
  await h.prime();
  h.respond(() => new Response(JSON.stringify({ data: { user: { result: {
    rest_id: "123", core: { screen_name: "alice", name: "Current name" },
    relationship_counts: { followers: 0 },
    legacy: { id_str: "123", screen_name: "alice", name: "Older name", profile_image_url_https: "https://example.test/avatar.png", followers_count: 42 }
  } } } })));
  h.send("LOOKUP_USER", { requestId: "nested", handle: "alice" });
  const { user } = await result(h, "nested");
  assert.equal(user.followers, 0);
  assert.equal(user.name, "Current name");
});

test("captures profile statistics through XHR without classifying the account as Following", () => {
  const h = hookHarness();
  const xhr = new h.context.XMLHttpRequest();
  xhr.open("GET", h.templateUrl.href);
  xhr.responseText = JSON.stringify(userPayload());
  xhr.send();
  assert.equal(h.messages.find((message) => message.kind === "X_PROFILE_USERS").users[0].followers, 42);
  assert.equal(h.messages.some((message) => message.kind === "X_USERS"), false);
  h.send("REQUEST_SNAPSHOT");
  assert.equal(h.messages.filter((message) => message.kind === "X_SNAPSHOT").at(-1).users.length, 0);
});

test("replays early profile responses after the UI loads without losing known statistics or changing source", async () => {
  const h = hookHarness();
  const user = userPayload().data.user.result;
  for (const entry of [user, { ...user, legacy: {} }]) {
    h.respond(() => new Response(JSON.stringify({ data: { user: { result: entry } } })));
    await h.window.fetch(h.templateUrl.href);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  h.messages.length = 0;
  h.send("REQUEST_SNAPSHOT");
  const profile = h.messages.find((message) => message.kind === "X_PROFILE_USERS");
  assert.equal(profile.users.length, 1);
  assert.equal(profile.users[0].followers, 42);
  assert.equal(h.messages.find((message) => message.kind === "X_SNAPSHOT").users.length, 0);
  assert.equal(h.calls.length, 2);
  h.send("CLEAR_CAPTURED_USERS");
  h.messages.length = 0;
  h.send("REQUEST_SNAPSHOT");
  assert.equal(h.messages.find((message) => message.kind === "X_PROFILE_USERS").users.length, 0);
});

test("bounds the page profile snapshot to the latest 5,000 distinct accounts", async () => {
  const h = hookHarness();
  const users = Array.from({ length: 5001 }, (_, i) => ({ rest_id: String(i + 1), core: { screen_name: `user${i}` } }));
  h.respond(() => new Response(JSON.stringify({ data: { users } })));
  await h.window.fetch(h.templateUrl.href);
  await new Promise((resolve) => setTimeout(resolve, 50));
  h.messages.length = 0;
  h.send("REQUEST_SNAPSHOT");
  const profile = h.messages.find((message) => message.kind === "X_PROFILE_USERS");
  assert.equal(profile.users.length, 5000);
  assert.equal(profile.users[0].id, "2");
  assert.equal(h.calls.length, 1);
});

test("a profile response started before clearing cannot update the cleared cache", async () => {
  const h = hookHarness();
  let finish;
  h.respond(() => new Promise((resolve) => { finish = resolve; }));
  const fetching = h.window.fetch(h.templateUrl.href);
  h.send("CLEAR_CAPTURED_USERS");
  finish(new Response(JSON.stringify(userPayload())));
  await fetching;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(h.messages.some((message) => message.kind === "X_PROFILE_USERS"), false);
});

test("halts on HTTP limits and GraphQL challenges, including a Retry-After hint", async () => {
  for (const [status, body, expected] of [[429, {}, 429], [403, {}, 403], [400, {}, 400], [503, {}, 503], [200, { errors: [{ code: 88, message: "Rate limit" }] }, 429], [200, { errors: [{ code: 326, message: "Verify account" }] }, 403]]) {
    const h = hookHarness();
    await h.prime();
    h.respond(() => new Response(JSON.stringify(body), { status, headers: { "retry-after": "900" } }));
    h.send("LOOKUP_USER", { requestId: "limited", handle: "alice" });
    const blocked = await result(h, "limited");
    assert.equal(blocked.halt, true);
    assert.equal(blocked.retryable, true);
    assert.equal(blocked.status, expected);
    assert.equal(blocked.retryAfterMs, 900000);
  }
});

test("does not turn unavailable users or unrelated profile results into imported accounts", async () => {
  const h = hookHarness();
  await h.prime();
  h.respond(() => new Response(JSON.stringify(userPayload("bob"))));
  h.send("LOOKUP_USER", { requestId: "mismatch", handle: "alice" });
  assert.equal((await result(h, "mismatch")).ok, false);
  h.respond(() => new Response(JSON.stringify({ data: { user: { result: { __typename: "UserUnavailable", reason: "Suspended" } } } })));
  h.send("LOOKUP_USER", { requestId: "unavailable", handle: "alice" });
  const unavailable = await result(h, "unavailable");
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.halt, undefined);
  assert.equal(unavailable.message, "Suspended");
});

test("still captures Following responses and adds members using the original mutation", async () => {
  const h = hookHarness();
  h.respond(() => new Response(JSON.stringify(userPayload())));
  await h.window.fetch("https://x.com/i/api/graphql/id/Following");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(h.messages.find((message) => message.kind === "X_USERS").users[0].handle, "alice");
  h.respond(() => new Response(JSON.stringify({ data: { list: { id: "123" } } })));
  h.send("ADD_MEMBER", { requestId: "add", listId: "123", userId: "9007199254740993" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(h.messages.find((message) => message.kind === "X_ADD_RESULT").ok, true);
  assert.equal(new URL(h.calls.at(-1).url).pathname.endsWith("/ListAddMember"), true);
  assert.deepEqual(JSON.parse(h.calls.at(-1).init.body).variables, { listId: "123", userId: "9007199254740993" });
});

test("a Following request started before clearing cannot repopulate the cleared list", async () => {
  const h = hookHarness();
  let finish;
  h.respond(() => new Promise((resolve) => { finish = resolve; }));
  const fetching = h.window.fetch("https://x.com/i/api/graphql/id/Following");
  h.send("CLEAR_CAPTURED_USERS");
  finish(new Response(JSON.stringify(userPayload())));
  await fetching;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(h.messages.some((message) => message.kind === "X_USERS"), false);
  h.send("REQUEST_SNAPSHOT");
  assert.equal(h.messages.filter((message) => message.kind === "X_SNAPSHOT").at(-1).users.length, 0);
});

function importHarness(initialUsers = []) {
  const node = (name) => ({ dataset: { import: name }, value: "", textContent: "", handlers: {}, addEventListener(kind, fn) { this.handlers[kind] = fn; } });
  const refs = Object.fromEntries(["parse", "file", "stop", "status", "errors", "input", "refresh"].map((name) => [name, node(name)]));
  refs.refresh.checked = false;
  const input = node("textarea"), users = [...initialUsers], calls = [], listeners = [], limits = [], toasts = [], lists = [], changes = [];
  const root = { querySelector: () => input, querySelectorAll: () => Object.values(refs) };
  let cooldown = 0, allowed = true;
  let respond = ({ handle }) => ({ ok: true, user: { id: String(calls.length), handle } });
  const context = vm.createContext({ URL, setTimeout, clearTimeout, addEventListener: (_, listener) => listeners.push(listener) });
  const pageGlobal = vm.runInContext("globalThis", context);
  context.postMessage = (request) => {
    calls.push(request.handle);
    Promise.resolve(respond(request)).then((reply) => listeners.forEach((listener) => listener({ source: pageGlobal, data: { source: "x-list-curator", kind: "X_LOOKUP_RESULT", requestId: request.requestId, ...reply } })));
  };
  vm.runInContext(source("account-import.js"), context);
  const controller = context.XListImport.mount({
    root, getUsers: () => users, canImport: () => allowed,
    beginImport: (handles) => lists.push(Array.from(handles)), onStateChange: () => changes.push(true),
    getSettings: () => ({ betweenMin: 0, betweenMax: 0, batchSize: 20, pauseMin: 0, pauseMax: 0 }),
    getCooldown: () => cooldown,
    onRateLimit: (result) => { limits.push(result); cooldown = Date.now() + 60000; },
    mergeUsers: (incoming) => {
      for (const user of incoming) {
        const index = users.findIndex((entry) => entry.id === user.id);
        if (index < 0) users.push(user);
        else users[index] = { ...users[index], ...user };
      }
    }, showToast: (message) => toasts.push(message)
  });
  return {
    refs, input, users, calls, limits, toasts, lists, changes, controller,
    respond(fn) { respond = fn; }, allow(value) { allowed = value; },
    run(text) { input.value = text; return refs.parse.handlers.click(); }
  };
}

test("import preview skips already-collected accounts and retains both successes and failures", async () => {
  const h = importHarness([{ id: "1", handle: "ALICE" }]);
  h.respond(({ handle }) => handle === "missing" ? { ok: false, message: "Unavailable" } : { ok: true, user: { id: "2", handle } });
  await h.run("alice,bob,BOB,bad-name,missing");
  assert.deepEqual(h.calls, ["bob", "missing"]);
  assert.equal(h.users.length, 2);
  assert.deepEqual(h.lists, [["alice", "bob", "missing"]]);
  assert.equal(h.changes.length, 1);
  assert.match(h.refs.status.textContent, /新增 1.*已收录 1.*重复 1.*无效 1.*查询失败 1/);
  assert.match(h.refs.errors.textContent, /bad-name/);
  assert.match(h.refs.errors.textContent, /Unavailable/);
  assert.equal(h.controller.running, false);
  assert.equal(h.input.disabled, false);
});

test("cached-only imports still populate the current custom list without making requests", async () => {
  const h = importHarness([{ id: "1", handle: "alice" }, { id: "2", handle: "bob" }]);
  await h.run("ALICE,bob");
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.lists, [["ALICE", "bob"]]);
  assert.equal(h.controller.running, false);
  h.refs.refresh.checked = true;
  h.controller.reset();
  assert.equal(h.input.value, "");
  assert.equal(h.refs.refresh.checked, false);
});

test("opt-in statistics refresh queries only incomplete cached accounts once and keeps the same IDs", async () => {
  const h = importHarness([
    { id: "1", handle: "alice", followers: null, following: 20, posts: null },
    { id: "2", handle: "bob", followers: 0, following: 0, posts: 0 }
  ]);
  assert.equal(h.refs.refresh.checked, false);
  h.refs.refresh.checked = true;
  h.respond(({ handle }) => ({ ok: true, user: { id: "1", handle, followers: 42, following: 20, posts: null } }));
  await h.run("ALICE,bob,alice");
  assert.deepEqual(h.calls, ["ALICE"]);
  assert.equal(h.users.length, 2);
  assert.equal(h.users[0].followers, 42);
  assert.equal(h.users[0].posts, null);
  assert.match(h.refs.status.textContent, /新增 0.*已收录 2.*补查 1.*重复 1/);
  assert.equal(h.refs.refresh.disabled, false);
});

test("statistics refresh works at cache capacity and still halts on rate limits", async () => {
  const h = importHarness(Array.from({ length: 5000 }, (_, i) => ({ id: String(i), handle: `user${i}`, followers: null })));
  h.refs.refresh.checked = true;
  h.respond(() => ({ ok: false, halt: true, retryable: true, status: 429, message: "Rate limit" }));
  await h.run("user1,user2");
  assert.deepEqual(h.calls, ["user1"]);
  assert.equal(h.users.length, 5000);
  assert.equal(h.limits.length, 1);
  await h.run("user1,user2");
  assert.deepEqual(h.calls, ["user1"]);
});

test("lookup limits stop the queue, save a cooldown and block immediate retries", async () => {
  const h = importHarness();
  h.respond(() => ({ ok: false, halt: true, retryable: true, status: 429, message: "Rate limit" }));
  await h.run("alice,bob");
  assert.deepEqual(h.calls, ["alice"]);
  assert.equal(h.limits.length, 1);
  assert.equal(h.controller.blocked, true);
  await h.run("bob");
  assert.deepEqual(h.calls, ["alice"]);
  assert.match(h.refs.status.textContent, /冷却中/);
});

test("stopping waits for the current request and a later run skips the saved success", async () => {
  const h = importHarness();
  let finish;
  h.respond(() => new Promise((resolve) => { finish = resolve; }));
  const parsing = h.run("alice,bob");
  assert.equal(h.controller.running, true);
  h.refs.stop.handlers.click();
  finish({ ok: true, user: { id: "1", handle: "alice" } });
  await parsing;
  assert.deepEqual(h.calls, ["alice"]);
  assert.equal(h.users.length, 1);
  assert.match(h.refs.status.textContent, /解析已停止/);
  h.respond(({ handle }) => ({ ok: true, user: { id: "2", handle } }));
  await h.run("alice,bob");
  assert.deepEqual(h.calls, ["alice", "bob"]);
});

test("blocks parsing during a task and prevents local account storage overflow", async () => {
  const h = importHarness([{ id: "1", handle: "existing" }]);
  h.allow(false);
  await h.run("alice");
  assert.equal(h.calls.length, 0);
  assert.match(h.toasts[0], /暂停导入任务/);
  h.allow(true);
  await h.run(Array.from({ length: 5000 }, (_, i) => `user${i}`).join(","));
  assert.equal(h.calls.length, 0);
  assert.match(h.refs.status.textContent, /总数将超过/);
});

test("file imports run through the same parser and reject oversized files before reading", async () => {
  const h = importHarness();
  let read = false;
  h.refs.input.files = [{ size: 1024 * 1024 + 1, text: async () => { read = true; return "alice"; } }];
  await h.refs.input.handlers.change();
  assert.equal(read, false);
  assert.equal(h.calls.length, 0);
  h.refs.input.files = [{ size: 20, text: async () => "handle\nalice\nbob" }];
  await h.refs.input.handlers.change();
  assert.deepEqual(h.calls, ["alice", "bob"]);
  assert.equal(h.users.length, 2);
});

test("stale lookup routes and network failures halt safely", async () => {
  const h = hookHarness();
  await h.prime();
  h.respond(() => new Response("{}", { status: 404 }));
  h.send("LOOKUP_USER", { requestId: "stale", handle: "alice" });
  assert.equal((await result(h, "stale")).halt, true);
  h.send("LOOKUP_USER", { requestId: "relearn", handle: "alice" });
  assert.match((await result(h, "relearn")).message, /个人主页/);
  h.respond(() => new Response("{}"));
  await h.prime();
  h.respond(() => { throw new Error("Network failure"); });
  h.send("LOOKUP_USER", { requestId: "network", handle: "alice" });
  const failure = await result(h, "network");
  assert.equal(failure.halt, true);
  assert.equal(failure.retryable, true);
  assert.equal(failure.status, 0);
});
