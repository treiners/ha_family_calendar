const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function createCard(subscribeMessage) {
  const timers = new Map();
  let nextTimer = 0;
  const elements = new Map();
  class HTMLElement {
    attachShadow() {
      return {};
    }
  }
  const context = {
    HTMLElement,
    customElements: {
      get: (name) => elements.get(name),
      define: (name, element) => elements.set(name, element),
    },
    window: {},
    localStorage: { getItem: () => null },
    console: { info: () => {}, error: () => {} },
    setTimeout: (callback, delay) => {
      const id = ++nextTimer;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
  };
  const source = readFileSync(
    resolve(__dirname, "../../custom_components/kdev_family_calendar/www/family-calendar-card.js"),
    "utf8"
  );
  vm.runInNewContext(source, context);
  const Card = elements.get("family-calendar-card");
  const card = new Card();
  card.setConfig({ instance: "test" });
  card._hass = { connection: { subscribeMessage } };
  card._calendarList = [
    { entity_id: "calendar.ready", name: "Ready" },
    { entity_id: "calendar.starting", name: "Starting" },
  ];
  card._getViewRange = () => ({
    start: new Date("2026-01-01T00:00:00Z"),
    end: new Date("2026-01-08T00:00:00Z"),
  });
  card._buildDays = () => {};
  card._render = () => {};
  card._renderToggles = () => {};
  return { card, timers };
}

async function fireTimer(timers) {
  const [id, timer] = timers.entries().next().value;
  timers.delete(id);
  timer.callback();
  await new Promise((resolve) => setImmediate(resolve));
}

test("retries a calendar that is not ready without disturbing successful subscriptions", async () => {
  const calls = [];
  let attempts = 0;
  let readyUnsubscribed = false;
  const { card, timers } = createCard(async (_callback, message) => {
    calls.push(message.entity_id);
    if (message.entity_id === "calendar.starting" && ++attempts === 1) {
      throw new Error("Calendar entity not found");
    }
    return () => {
      if (message.entity_id === "calendar.ready") readyUnsubscribed = true;
    };
  });

  await card._ensureSubscriptions();
  assert.match(card._subscriptionError, /Calendar entity not found/);
  assert.equal(timers.size, 1);
  assert.equal([...timers.values()][0].delay, 10000);

  await fireTimer(timers);
  assert.deepEqual(calls, ["calendar.ready", "calendar.starting", "calendar.starting"]);
  assert.equal(readyUnsubscribed, false);
  assert.equal(card._subscriptionError, "");
  assert.equal(card._subscriptions.length, 2);
  assert.equal(timers.size, 0);
});

test("disconnect cancels scheduled retries and unsubscribes successful calendars", async () => {
  let unsubscribed = 0;
  const { card, timers } = createCard(async (_callback, message) => {
    if (message.entity_id === "calendar.starting") throw new Error("Not ready");
    return () => unsubscribed++;
  });

  await card._ensureSubscriptions();
  assert.equal(timers.size, 1);
  card.disconnectedCallback();
  assert.equal(timers.size, 0);
  assert.equal(unsubscribed, 1);
});

test("keeps retrying a calendar until it becomes available", async () => {
  let attempts = 0;
  const { card, timers } = createCard(async (_callback, message) => {
    if (message.entity_id === "calendar.starting" && ++attempts < 3) throw new Error("Not ready");
    return () => {};
  });

  await card._ensureSubscriptions();
  await fireTimer(timers);
  assert.match(card._subscriptionError, /Not ready/);
  assert.equal(timers.size, 1);
  await fireTimer(timers);
  assert.equal(attempts, 3);
  assert.equal(card._subscriptionError, "");
  assert.equal(timers.size, 0);
});

test("a stale subscription is cancelled even when the same range is requested again", async () => {
  let resolveFirst;
  let calls = 0;
  let staleUnsubscribed = 0;
  const { card, timers } = createCard(() => {
    calls++;
    if (calls === 1) {
      return new Promise((resolve) => {
        resolveFirst = resolve;
      });
    }
    return Promise.resolve(() => {});
  });
  card._calendarList = [{ entity_id: "calendar.ready", name: "Ready" }];

  const first = card._ensureSubscriptions();
  await card._ensureSubscriptions(true);
  resolveFirst(() => staleUnsubscribed++);
  await first;
  assert.equal(staleUnsubscribed, 1);
  assert.equal(card._subscriptions.length, 1);
  assert.equal(timers.size, 0);
});
