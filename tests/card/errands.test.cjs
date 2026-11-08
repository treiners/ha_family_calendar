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
    CSS: { supports: (_property, value) => ["#202020", "#00ff00", "red"].includes(value) },
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
  return { card, controls, context };
}

function snapshot() {
  return {
    revision: 1,
    people: [{ id: "p1", calendar_entity: "calendar.family", approval_required: true }],
    templates: [],
    rewards: [],
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

test("errand tile colours follow star bands at every boundary", () => {
  const { card, controls } = setup();
  const state = snapshot();
  state.occurrences = [1, 2, 3, 4, 5, 1000000].map((stars) => ({
    ...state.occurrences[0],
    id: `o${stars}`,
    name: `Task ${stars}`,
    stars,
  }));
  card._errandsState = state;
  card._errandsView = true;
  card._renderErrands();
  const html = controls.get("#fc-errands").innerHTML;
  for (const [stars, band] of [[1, "low"], [2, "low"], [3, "medium"], [4, "medium"], [5, "high"], [1000000, "high"]]) {
    assert.match(html, new RegExp(`fc-errand-stars-${band}">[\\s\\S]*?<strong>Task ${stars}</strong>\\s*<span>★ ${stars}`));
  }
});

test("errands display selected and default icons safely", () => {
  const { card, controls } = setup();
  const state = snapshot();
  state.occurrences.push({ ...state.occurrences[0], id: "o2", name: "Custom", icon: 'mdi:cat" onclick="bad' });
  card._errandsState = state;
  card._errandsView = true;
  card._renderErrands();
  const html = controls.get("#fc-errands").innerHTML;
  assert.match(html, /icon="mdi:clipboard-check-outline"/);
  assert.match(html, /icon="mdi:cat&quot; onclick=&quot;bad"/);
  assert.match(html, /<strong>Custom<\/strong>[\s\S]*?<\/div>\s*<ha-icon class="fc-errand-icon" icon="mdi:cat/);
});

test("library tiles place icons to the right of their text", () => {
  const { card } = setup();
  card._errandsState = { ...snapshot(), templates: [{ id: "t1", name: "Library task", stars: 3, icon: "mdi:cat" }] };
  let html;
  card._errandModal = (_title, content) => {
    html = content;
    return { querySelector: () => ({ addEventListener: () => {} }), querySelectorAll: () => [] };
  };
  card._showErrandLibrary();
  assert.match(html, /<strong>Library task<\/strong>[\s\S]*?<\/div>\s*<ha-icon class="fc-errand-icon" icon="mdi:cat"/);
});

test("day markers preserve valid colors even when they match the background", () => {
  const { card } = setup();
  card._settings = { dark_day_color: "#202020" };
  card._theme = "dark";
  const html = card._dayMarkersHtml([
    { icon: "mdi:trash-can", color: "#202020" },
    { icon: "mdi:recycle", color: "red" },
    { icon: 'mdi:cat" onclick="bad', color: 'red; background: url("bad")' },
    { icon: "mdi:bin", color: "" },
  ]);
  assert.match(html, /icon="mdi:trash-can" class="fc-day-marker-icon" style="color:#202020"/);
  assert.match(html, /icon="mdi:recycle" class="fc-day-marker-icon" style="color:red"/);
  assert.match(html, /icon="mdi:cat&quot; onclick=&quot;bad" class="fc-day-marker-icon"><\/ha-icon>/);
  assert.match(html, /icon="mdi:bin" class="fc-day-marker-icon"><\/ha-icon>/);
});

test("the icon selector retains the initial value and submits selections", async () => {
  const { card, context } = setup();
  context.customElements.define("ha-form", class {});
  const picker = { addEventListener: (name, callback) => { picker.callback = callback; } };
  const createElement = context.document.createElement;
  context.document.createElement = (tag) => tag === "ha-form" ? picker : createElement(tag);
  card._hass = {};
  const input = { value: "mdi:cat", parentElement: { hidden: false }, addEventListener: () => {} };
  const buttons = ["family_calendar:room_cleanup", "family_calendar:homework"].map((id) => ({
    dataset: { icon: id },
    setAttribute: (key, value) => { if (key === "aria-pressed") buttons.find((button) => button.dataset.icon === id).pressed = value; },
    addEventListener: (_name, callback) => { buttons.find((button) => button.dataset.icon === id).click = callback; },
  }));
  const container = {
    set innerHTML(value) { assert.match(value, /mdi:cat/); },
    querySelector: () => input,
    querySelectorAll: () => buttons,
    prepend: (element) => { container.picker = element; },
  };
  const form = { isConnected: true, querySelector: () => container };
  await card._mountErrandIconPicker(form, "mdi:cat");
  assert.equal(container.picker, picker);
  assert.equal(picker.data.icon, "mdi:cat");
  assert.equal(input.parentElement.hidden, true);
  picker.callback({ detail: { value: { icon: "mdi:dog" } } });
  assert.equal(input.value, "mdi:dog");
  picker.callback({ detail: { value: {} } });
  assert.equal(input.value, "");
  buttons[0].click();
  assert.equal(input.value, "family_calendar:room_cleanup");
  assert.equal(buttons[0].pressed, "true");
  assert.equal(buttons[1].pressed, "false");
  assert.equal(picker.data.icon, "");
  picker.callback({ detail: { value: {} } });
  assert.equal(input.value, "family_calendar:room_cleanup");
  picker.callback({ detail: { value: { icon: "mdi:dog" } } });
  assert.equal(input.value, "mdi:dog");
  assert.equal(buttons[0].pressed, "false");
  buttons[1].click();
  buttons[1].click();
  assert.equal(input.value, "");
});

test("family illustrations render as bundled artwork in errands and library tiles", () => {
  const { card, controls } = setup();
  const state = snapshot();
  state.occurrences[0].icon = "family_calendar:room_cleanup";
  state.templates = [{ id: "t1", name: "Homework", stars: 2, icon: "family_calendar:homework" }];
  card._errandsState = state;
  card._errandsView = true;
  card._renderErrands();
  assert.match(controls.get("#fc-errands").innerHTML, /<svg class="fc-errand-icon" viewBox="0 0 64 64"/);
  let html;
  card._errandModal = (_title, content) => {
    html = content;
    return { querySelector: () => ({ addEventListener: () => {} }), querySelectorAll: () => [] };
  };
  card._showErrandLibrary();
  assert.match(html, /<strong>Homework<\/strong>[\s\S]*?<svg class="fc-errand-icon"/);
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
  for (const action of ["people", "library", "rewards", "add", "manage", "history", "approve", "undo_completion", "edit"]) {
    assert.doesNotMatch(html, new RegExp(`data-action="${action}"`));
  }
  card._errandsCanAct = false;
  card._renderErrands();
  assert.doesNotMatch(controls.get("#fc-errands").innerHTML, /data-action="(?:complete|deduct)"/);
});

test("saved rewards display fixed prices and submit their identifier, while free text remains available", async () => {
  const { card } = setup();
  card._errandsState = { ...snapshot(), rewards: [{ id: "r1", name: "<Book>", stars: 5 }] };
  const submitted = [];
  const forms = new Map();
  const form = (value) => ({
    addEventListener: (_event, callback) => { form.callback = callback; },
    querySelector: () => ({ value }),
  });
  const redeem = form("r1");
  const deduct = {
    addEventListener: (_event, callback) => { deduct.callback = callback; },
    querySelector: (selector) => ({ value: selector.includes("stars") ? "2" : "Other reward" }),
  };
  let html;
  card._errandModal = (_title, content) => {
    html = content;
    forms.set("#fc-redeem-form", redeem);
    forms.set("#fc-deduct-form", deduct);
    return { querySelector: (selector) => forms.get(selector) };
  };
  card._applyErrand = async (command, args) => { submitted.push({ command, ...args }); return false; };
  card._showErrandDeduction({ id: "p1" });
  assert.match(html, /&lt;Book&gt; · ★ 5/);
  assert.match(html, /Other reason/);
  await form.callback({ preventDefault() {} });
  await deduct.callback({ preventDefault() {} });
  assert.equal(submitted[0].command, "redeem_reward");
  assert.equal(submitted[0].reward_id, "r1");
  assert.equal(submitted[0].person_id, "p1");
  assert.equal(submitted[1].command, "deduct");
  assert.equal(submitted[1].stars, 2);
  assert.equal(submitted[1].reason, "Other reward");
});

test("reward management shows escaped names and submits a name and price", async () => {
  const { card, controls } = setup();
  card._errandsState = { ...snapshot(), rewards: [{ id: "r1", name: "<Book>", stars: 5 }] };
  card._errandsView = true;
  card._renderErrands();
  assert.match(controls.get("#fc-errands").innerHTML, /data-action="rewards"/);
  let html;
  const form = {
    addEventListener: (_event, callback) => { form.callback = callback; },
    querySelector: (selector) => ({ value: selector === '[name="name"]' ? "30 min TV" : "4" }),
  };
  card._errandModal = (_title, content) => {
    html = content;
    return {
      querySelector: (selector) => selector === "form" ? form : { addEventListener: () => {} },
      querySelectorAll: () => [],
    };
  };
  card._showRewards();
  assert.match(html, /&lt;Book&gt; · ★ 5/);
  assert.match(html, /data-action="edit"/);
  assert.match(html, /data-action="delete"/);
  card._showRewardForm();
  assert.match(html, /Stars needed/);
  let submitted;
  card._applyErrand = async (command, args) => { submitted = { command, ...args }; return false; };
  await form.callback({ preventDefault() {} });
  assert.equal(submitted.command, "save_reward");
  assert.equal(submitted.name, "30 min TV");
  assert.equal(submitted.stars, 4);
});
