const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

class Element {
  constructor(tag = "") {
    this.tag = tag;
    this.children = [];
    this.listeners = {};
    this.attributes = {};
    this.value = "";
    this.textContent = "";
    this.checked = false;
  }

  attachShadow() {
    this.shadowRoot = new Element("shadow");
    return this.shadowRoot;
  }

  set innerHTML(value) {
    this.html = value;
    this.children = [];
  }

  append(...children) {
    this.children.push(...children);
  }

  setAttribute(name, value) {
    this.attributes[name] = value;
  }

  addEventListener(name, callback) {
    this.listeners[name] = callback;
  }

  dispatchEvent(event) {
    this.lastEvent = event;
    return true;
  }

  setCustomValidity(message) {
    this.error = message;
  }

  reportValidity() {
    return !this.error;
  }

  trigger(name) {
    this.listeners[name]();
  }
}

function elements(root) {
  return [root, ...root.children.filter((child) => child instanceof Element).flatMap(elements)];
}

function setup(config = {}) {
  const registry = new Map();
  const document = { createElement: (tag) => new Element(tag) };
  class CustomEvent {
    constructor(type, options) {
      this.type = type;
      Object.assign(this, options);
    }
  }
  const context = {
    HTMLElement: Element,
    document,
    CustomEvent,
    customElements: {
      get: (name) => registry.get(name),
      define: (name, element) => registry.set(name, element),
    },
    window: {},
    console: { info: () => {} },
  };
  const source = readFileSync(
    resolve(__dirname, "../../custom_components/kdev_family_calendar/www/family-calendar-card.js"),
    "utf8"
  );
  vm.runInNewContext(source, context);
  const Card = registry.get("family-calendar-card");
  const Editor = registry.get("family-calendar-card-editor");
  const editor = new Editor();
  editor.setConfig({ type: "custom:family-calendar-card", instance: "test", ...config });
  return { Card, editor };
}

function field(editor, label) {
  const wrapper = elements(editor.shadowRoot).find(
    (element) => element.tag === "label" && element.children[0]?.textContent === label
  );
  assert.ok(wrapper, `Missing field: ${label}`);
  return wrapper.children[1];
}

function aria(editor, label) {
  const input = elements(editor.shadowRoot).find((element) => element.attributes["aria-label"] === label);
  assert.ok(input, `Missing input: ${label}`);
  return input;
}

function button(editor, label) {
  const result = elements(editor.shadowRoot).find(
    (element) => element.tag === "button" && element.textContent === label
  );
  assert.ok(result, `Missing button: ${label}`);
  return result;
}

test("card picker provides distinct instance names and an editor", () => {
  const { Card } = setup();
  assert.notEqual(Card.getStubConfig().instance, Card.getStubConfig().instance);
  assert.equal(Card.getConfigElement().tag, "family-calendar-card-editor");
});

test("optional settings can be set and cleared without altering other configuration", () => {
  const { editor } = setup({ unknown: { value: 7 }, layout: "timeline", entity: "sensor.custom" });
  const view = field(editor, "View");
  view.value = "week";
  view.trigger("change");
  assert.equal(editor.lastEvent.type, "config-changed");
  assert.equal(editor.lastEvent.detail.config.view, "week");
  assert.equal(editor.lastEvent.detail.config.layout, "timeline");
  assert.equal(editor.lastEvent.detail.config.unknown.value, 7);
  view.value = "";
  view.trigger("change");
  assert.equal(Object.hasOwn(editor.lastEvent.detail.config, "view"), false);
  const sensor = field(editor, "Configuration sensor");
  sensor.value = "sensor.other";
  sensor.trigger("change");
  assert.equal(editor.lastEvent.detail.config.entity, "sensor.other");
  assert.equal(Object.hasOwn(editor.lastEvent.detail.config, "config_entity"), false);
  const days = field(editor, "Fixed number of days");
  days.value = "3";
  days.trigger("change");
  assert.equal(editor.lastEvent.detail.config.days, 3);
  const size = field(editor, "Family button size");
  size.value = "large";
  size.trigger("change");
  assert.equal(editor.lastEvent.detail.config.button_size, "large");
  const firstDay = field(editor, "First day shown");
  firstDay.value = "sunday";
  firstDay.trigger("change");
  assert.equal(editor.lastEvent.detail.config.first_day, "sunday");
  firstDay.value = "current_day";
  firstDay.trigger("change");
  assert.equal(editor.lastEvent.detail.config.first_day, "current_day");
});

test("the editor exposes every scalar card option", () => {
  const { editor } = setup();
  for (const label of [
    "Instance name",
    "Configuration sensor",
    "Fixed number of days",
    "View",
    "First day shown",
    "Layout",
    "Multi-day events",
    "Event style",
    "Timeline start hour",
    "Timeline end hour",
    "Timeline hour height (pixels)",
    "Theme",
    "Family button size",
  ]) {
    assert.ok(field(editor, label));
  }
});

test("family button size changes only the configured card", () => {
  const { Card } = setup();
  function render(size) {
    const card = new Card();
    const toggles = { innerHTML: "", querySelectorAll: () => [] };
    const add = {};
    card._root.querySelector = (selector) => (selector === "#fc-toggles" ? toggles : add);
    card._calendarList = [{ entity_id: "calendar.family", name: "Family", color: "#123456" }];
    card._hiddenList = [];
    card._config = size ? { button_size: size } : {};
    card._calendarFeatures = () => 1;
    card._renderToggles();
    return toggles.innerHTML;
  }
  assert.doesNotMatch(render(), /fc-toggle--large/);
  assert.doesNotMatch(render("normal"), /fc-toggle--large/);
  assert.match(render("large"), /fc-toggle--large/);
});

test("icon mappings retain their order and reject duplicate keywords", () => {
  const { editor } = setup({ icon_keywords: { first: "mdi:first", second: "mdi:second" } });
  const first = aria(editor, "Icon keyword");
  first.value = "second";
  first.trigger("change");
  assert.match(first.error, /already exists/);
  assert.equal(editor.lastEvent, undefined);
  first.value = "renamed";
  first.trigger("change");
  assert.deepEqual(Object.keys(editor.lastEvent.detail.config.icon_keywords), ["renamed", "second"]);
  aria(editor, "New icon keyword").value = "third";
  aria(editor, "New keyword icon").value = "mdi:third";
  button(editor, "Add icon").trigger("click");
  assert.equal(editor.lastEvent.detail.config.icon_keywords.third, "mdi:third");
  button(editor, "Remove third").trigger("click");
  assert.equal(Object.hasOwn(editor.lastEvent.detail.config.icon_keywords, "third"), false);
});

test("custom day markers distinguish an empty override from integration defaults", () => {
  const { editor } = setup();
  const override = field(editor, "Override integration day markers");
  override.checked = true;
  override.trigger("change");
  assert.equal(editor.lastEvent.detail.config.day_markers.length, 0);
  aria(editor, "New marker keyword").value = "birthday";
  aria(editor, "New marker icon").value = "mdi:cake";
  aria(editor, "New marker color").value = "#abcdef";
  button(editor, "Add marker").trigger("click");
  assert.equal(editor.lastEvent.detail.config.day_markers[0].color, "#abcdef");
  button(editor, "Remove marker 1").trigger("click");
  assert.equal(editor.lastEvent.detail.config.day_markers.length, 0);
  const reset = field(editor, "Override integration day markers");
  reset.checked = false;
  reset.trigger("change");
  assert.equal(Object.hasOwn(editor.lastEvent.detail.config, "day_markers"), false);
});

test("editing a marker retains extra fields and other settings", () => {
  const { editor } = setup({ day_markers: [{ keyword: "trash", icon: "mdi:delete", extra: "kept" }], theme: "dark" });
  const color = aria(editor, "Marker 1 color");
  color.value = "#123456";
  color.trigger("change");
  assert.equal(editor.lastEvent.detail.config.day_markers[0].extra, "kept");
  assert.equal(editor.lastEvent.detail.config.day_markers[0].color, "#123456");
  assert.equal(editor.lastEvent.detail.config.theme, "dark");
});
