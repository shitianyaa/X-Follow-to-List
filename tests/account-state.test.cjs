const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const context = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../extension-dist/src/account-state.js"), "utf8"), context);
const accounts = context.XListAccounts;
const plain = (value) => JSON.parse(JSON.stringify(value));
const profile = (id, handle, fields = {}) => ({ id, handle, statsVersion: 2, ...fields });
const state = () => ({ ...plain(accounts.hydrate({})), job: { queue: [{ userId: "1" }], cooldownUntil: 123 }, history: [{ id: "old-job" }], lookupCooldownUntil: 456 });

test("migrates mixed old accounts into history while preserving selection and known positive counts", () => {
  const loaded = accounts.hydrate({ users: [{ id: "1", handle: "alice", followers: 0, following: 20, posts: 0, location: "[object Object]" }], selectedIds: ["1", "missing"] });
  assert.deepEqual(plain(loaded.collections), { custom: [], following: [], legacy: ["1"] });
  assert.deepEqual(plain(loaded.selectedIds), ["1"]);
  assert.equal(loaded.activeSource, "legacy");
  assert.equal(loaded.users[0].followers, null);
  assert.equal(loaded.users[0].following, 20);
  assert.equal(loaded.users[0].posts, null);
  assert.equal(loaded.users[0].location, "");
});

test("preserves genuine zero counts and missing values distinctly across a save/reload", () => {
  const s = state();
  accounts.merge(s, [profile("1", "alice", { followers: 0, following: null, posts: 12 })], "custom");
  const loaded = accounts.hydrate(plain(s));
  assert.equal(loaded.users[0].followers, 0);
  assert.equal(loaded.users[0].following, null);
  assert.equal(loaded.users[0].posts, 12);
  assert.deepEqual(plain(loaded.collections.custom), ["1"]);
});

test("two source lists share one profile and classify historical accounts without extra copies", () => {
  const s = { ...state(), ...plain(accounts.hydrate({ users: [profile("1", "alice")], selectedIds: ["1"] })) };
  accounts.merge(s, [profile("1", "alice", { followers: 123 })], "following");
  accounts.replaceSource(s, "custom", ["1"]);
  assert.equal(s.users.length, 1);
  assert.deepEqual(plain(s.collections), { custom: ["1"], following: ["1"], legacy: [] });
  assert.deepEqual(plain(s.selectedIds), ["1"]);
});

test("clearing a source retains the shared cache, other memberships, task and cooldowns", () => {
  const s = state();
  accounts.merge(s, [profile("1", "alice"), profile("2", "bob")], "custom");
  accounts.merge(s, [profile("1", "alice")], "following");
  s.selectedIds = ["1", "2"];
  accounts.clearSource(s, "custom");
  assert.equal(s.users.length, 2);
  assert.deepEqual(plain(s.collections), { custom: [], following: ["1"], legacy: [] });
  assert.deepEqual(plain(s.selectedIds), ["1"]);
  assert.equal(s.job.cooldownUntil, 123);
  assert.equal(s.lookupCooldownUntil, 456);
  accounts.clearAll(s);
  assert.equal(s.users.length, 0);
  assert.deepEqual(plain(s.selectedIds), []);
  assert.equal(s.history.length, 1);
  assert.equal(s.job.queue[0].userId, "1");
  assert.equal(s.lookupCooldownUntil, 456);
});

test("a new custom list replaces only that membership and keeps other selections", () => {
  const s = state();
  accounts.merge(s, [profile("1", "alice"), profile("2", "bob")], "custom");
  accounts.merge(s, [profile("3", "carol")], "following");
  s.selectedIds = ["1", "2", "3"];
  accounts.replaceSource(s, "custom", ["2", "2", "missing"]);
  assert.deepEqual(plain(s.collections.custom), ["2"]);
  assert.deepEqual(plain(s.selectedIds), ["2", "3"]);
  assert.equal(s.users.length, 3);
});

test("unknown statistics cannot match numeric ranges, while a real zero can", () => {
  assert.equal(accounts.matchesRanges({ followers: null }, {}), true);
  assert.equal(accounts.matchesRanges({ followers: null }, { minFollowers: "0" }), false);
  assert.equal(accounts.matchesRanges({ followers: null }, { maxFollowers: "100" }), false);
  assert.equal(accounts.matchesRanges({ followers: 0 }, { minFollowers: "0", maxFollowers: "10" }), true);
  assert.equal(accounts.matchesRanges({ following: 5, posts: 9 }, { minFollowing: "6" }), false);
  assert.equal(accounts.matchesRanges({ posts: 10 }, { maxPosts: "9" }), false);
});

test("partial responses keep known counts and fresh responses can replace a known count with zero", () => {
  const s = state();
  accounts.merge(s, [profile("1", "alice", { followers: 123, posts: 456 })], "following");
  accounts.merge(s, [profile("1", "alice", { followers: null })], "custom");
  assert.equal(s.users[0].followers, 123);
  assert.equal(s.users[0].posts, 456);
  accounts.merge(s, [profile("1", "alice", { followers: 0 })], "following");
  assert.equal(s.users[0].followers, 0);
});

test("passive profile updates refresh only existing accounts and preserve membership, selections and jobs", () => {
  const s = state();
  accounts.merge(s, [profile("1", "alice", { followers: 123, posts: 456 })], "custom");
  s.selectedIds = ["1"];
  const collections = plain(s.collections), job = plain(s.job);
  accounts.merge(s, [profile("1", "alice", { followers: 0, following: 10 }), profile("2", "bob", { followers: 999 })]);
  assert.equal(s.users.length, 1);
  assert.equal(s.users[0].followers, 0);
  assert.equal(s.users[0].following, 10);
  assert.equal(s.users[0].posts, 456);
  assert.deepEqual(plain(s.collections), collections);
  assert.deepEqual(plain(s.selectedIds), ["1"]);
  assert.deepEqual(plain(s.job), job);
  assert.equal(s.lookupCooldownUntil, 456);
});

test("caps shared cache storage without creating dangling source memberships", () => {
  const s = state();
  accounts.merge(s, Array.from({ length: 5000 }, (_, i) => profile(String(i + 1), `user${i}`)), "following");
  const result = accounts.merge(s, [profile("99999", "overflow")], "custom");
  assert.equal(result.overflow, 1);
  assert.equal(s.users.length, 5000);
  assert.deepEqual(plain(s.collections.custom), []);
});
