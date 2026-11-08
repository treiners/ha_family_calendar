const assert = require("node:assert/strict");
const { webcrypto } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function setup() {
  const elements = new Map();
  const controls = new Map();
  class Element {
    attachShadow() {
      return {
        querySelector(selector) {
          if (!controls.has(selector)) controls.set(selector, { hidden: false, querySelectorAll: () => [] });
          return controls.get(selector);
        },
      };
    }
  }
  const document = {
    createElement() {
      return {
        set textContent(value) {
          this.innerHTML = String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
        },
      };
    },
  };
  const context = {
    HTMLElement: Element,
    document,
    crypto: webcrypto,
    Uint8Array,
    window: {},
    localStorage: { getItem: () => null },
    customElements: {
      get: (name) => elements.get(name),
      define: (name, value) => elements.set(name, value),
    },
    console: { info: () => {}, error: () => {} },
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(
    readFileSync(resolve(__dirname, "../../custom_components/kdev_family_calendar/www/family-calendar-card.js"), "utf8"),
    context
  );
  const card = new (elements.get("family-calendar-card"))();
  card.setConfig({ instance: "test" });
  card._built = true;
  card._calendarList = [{ entity_id: "calendar.family", name: "Family", color: "#123456" }];
  card._hiddenList = [];
  card._calendarFeatures = () => 0;
  card._errandsCanManage = true;
  card._errandsCanAct = true;
  return { card, controls };
}

function snapshot() {
  return {
    revision: 1,
    people: [{ id: "p1", calendar_entity: "calendar.family", approval_required: true }],
    templates: [],
    assignments: [{ id: "a1", person_id: "p1", active: true }],
    occurrences: [{ id: "o1", assignment_id: "a1", person_id: "p1", status: "open", name: "Feed pet", stars: 2 }],
    transactions: [],
  };
}

test("shared subscriptions update two cards and are cleaned up independently", async () => {
  const first = setup().card;
  const second = setup().card;
  const callbacks = [];
  let closed = 0;
  const hass = {
    callWS: async () => ({ config_entry_id: "entry" }),
    connection: {
      subscribeMessage: async (callback) => {
        callbacks.push(callback);
        return () => closed++;
      },
    },
  };
  first._hass = second._hass = hass;
  await Promise.all([first._ensureErrands("sensor.family"), second._ensureErrands("sensor.family")]);
  callbacks.forEach((callback) => callback({ available: true, data: snapshot(), can_manage: true, can_act: true }));
  assert.equal(first._errandsState.revision, 1);
  assert.equal(second._errandsState.occurrences[0].name, "Feed pet");
  first.disconnectedCallback();
  assert.equal(closed, 1);
  const updated = snapshot();
  updated.revision = 2;
  updated.occurrences[0].status = "pending";
  callbacks.forEach((callback) => callback({ available: true, data: updated, can_manage: true, can_act: true }));
  assert.equal(first._errandsState.revision, 1);
  assert.equal(second._errandsState.occurrences[0].status, "pending");
  second.disconnectedCallback();
  assert.equal(closed, 2);
});

test("a stale subscription is cancelled after disconnect", async () => {
  const { card } = setup();
  let finish;
  let closed = 0;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  card._hass = {
    callWS: async () => ({ config_entry_id: "entry" }),
    connection: { subscribeMessage: () => new Promise((resolve) => { finish = resolve; markStarted(); }) },
  };
  const pending = card._ensureErrands("sensor.family");
  await started;
  card.disconnectedCallback();
  finish(() => closed++);
  await pending;
  assert.equal(closed, 1);
});

test("uncertain writes retry the same operation and revision and prevent duplicate taps", async () => {
  const { card } = setup();
  const calls = [];
  card._errandsState = snapshot();
  card._errandsEntry = "entry";
  card._hass = {
    callWS: async (message) => {
      calls.push(message);
      if (calls.length === 1) throw new Error("Connection lost");
      return { ...snapshot(), revision: 2 };
    },
  };
  assert.equal(await card._applyErrand("complete", { id: "o1" }), false);
  assert.match(card._errandsError, /Connection lost/);
  assert.equal(await card._applyErrand("complete", { id: "o1" }), false);
  assert.equal(calls.length, 1);
  assert.equal(await card._sendErrands(null, true), true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], calls[1]);
  assert.match(calls[0].operation_id, /^[a-f0-9]{32}$/);
  assert.equal(card._errandsPending, null);
});

test("a second tap cannot issue another mutation while the first is in flight", async () => {
  const { card } = setup();
  let finish;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  let calls = 0;
  card._errandsState = snapshot();
  card._errandsEntry = "entry";
  card._hass = {
    callWS: () => {
      calls++;
      return new Promise((resolve) => { finish = resolve; markStarted(); });
    },
  };
  const first = card._applyErrand("complete", { id: "o1" });
  await started;
  assert.equal(await card._applyErrand("complete", { id: "o1" }), false);
  assert.equal(calls, 1);
  finish({ ...snapshot(), revision: 2 });
  assert.equal(await first, true);
});

test("forms submit their opening revision rather than silently overwriting newer changes", async () => {
  const { card } = setup();
  card._errandsState = { ...snapshot(), revision: 3 };
  card._errandFormRevision = 1;
  card._errandsEntry = "entry";
  let sent;
  card._hass = {
    callWS: async (message) => {
      sent = message;
      throw new Error("Errands data changed");
    },
  };
  assert.equal(await card._applyErrand("edit_assignment", { id: "a1" }), false);
  assert.equal(sent.revision, 1);
  assert.match(card._errandsError, /data changed/);
});

test("tiles show pending actions, escaped names and only selected calendars", () => {
  const { card, controls } = setup();
  const state = snapshot();
  state.occurrences[0].name = "<script>alert(1)</script>";
  state.occurrences[0].status = "pending";
  state.people.push({ id: "p2", calendar_entity: "calendar.removed", approval_required: false });
  card._errandsState = state;
  card._errandsView = true;
  card._renderErrands();
  const html = controls.get("#fc-errands").innerHTML;
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /Waiting for confirmation/);
  assert.match(html, /data-action="approve"/);
  assert.doesNotMatch(html, /calendar.removed/);
  assert.equal(controls.get("#fc-week").hidden, true);
  card._errandsView = false;
  card._renderErrands();
  assert.equal(controls.get("#fc-week").hidden, false);
});

test("hiding a person removes their tiles and star label without deleting the data", () => {
  const { card, controls } = setup();
  const state = snapshot();
  state.people[0].enabled = false;
  state.transactions.push({ person_id: "p1", amount: 3 });
  card._errandsState = state;
  card._errandsView = true;
  card._renderErrands();
  card._renderToggles();
  assert.match(controls.get("#fc-errands").innerHTML, /Choose which calendars/);
  assert.doesNotMatch(controls.get("#fc-errands").innerHTML, /Feed pet/);
  assert.doesNotMatch(controls.get("#fc-toggles").innerHTML, /3 stars/);
  assert.equal(state.occurrences.length, 1);
  assert.equal(state.transactions[0].amount, 3);
});

test("non-managers can complete and spend but cannot manage or confirm", () => {
  const { card, controls } = setup();
  const state = snapshot();
  state.occurrences.push({ ...state.occurrences[0], id: "o2", status: "pending" });
  card._errandsState = state;
  card._errandsCanManage = false;
  card._errandsView = true;
  card._renderErrands();
  const html = controls.get("#fc-errands").innerHTML;
  assert.match(html, /data-action="complete"/);
  assert.match(html, /data-action="deduct"/);
  for (const action of ["people", "library", "add", "manage", "history", "approve", "undo_completion", "edit"]) {
    assert.doesNotMatch(html, new RegExp(`data-action="${action}"`));
  }
  card._errandsCanAct = false;
  card._renderErrands();
  assert.doesNotMatch(controls.get("#fc-errands").innerHTML, /data-action="(?:complete|deduct)"/);
});
