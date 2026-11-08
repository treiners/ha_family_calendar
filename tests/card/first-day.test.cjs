const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function createCard(options = {}) {
  const registry = new Map();
  class HTMLElement {
    attachShadow() {
      return {};
    }
  }
  const context = {
    HTMLElement,
    customElements: {
      get: (name) => registry.get(name),
      define: (name, element) => registry.set(name, element),
    },
    window: {},
    localStorage: { getItem: () => null, setItem: () => {} },
    clearTimeout: () => {},
    console: { info: () => {} },
  };
  const source = readFileSync(
    resolve(__dirname, "../../custom_components/kdev_family_calendar/www/family-calendar-card.js"),
    "utf8"
  );
  vm.runInNewContext(source, context);
  const Card = registry.get("family-calendar-card");
  const card = new Card();
  card.setConfig({ instance: "test", ...options });
  card._settings = {};
  card._applySettings();
  card._renderNav = () => {};
  card._render = () => {};
  card._ensureSubscriptions = async () => {};
  return card;
}

function range(card) {
  const result = card._getViewRange();
  return [card._dateToISO(result.start), card._dateToISO(result.end)];
}

test("week aligns chosen dates and navigation to the configured weekday", () => {
  for (const [firstDay, start] of [
    ["sunday", "2026-03-01"],
    ["monday", "2026-03-02"],
    ["current_day", "2026-03-04"],
    [undefined, "2026-03-04"],
  ]) {
    const card = createCard({ first_day: firstDay, view: "week" });
    card._setView({ start_date: "2026-03-04" });
    assert.equal(card._anchorDate, start);
    const end = new Date(`${start}T00:00:00`);
    end.setDate(end.getDate() + 7);
    assert.deepEqual(range(card), [start, card._dateToISO(end)]);
    card._shiftAnchor(1);
    assert.equal(card._anchorDate, card._dateToISO(end));
    card._shiftAnchor(-1);
    assert.equal(card._anchorDate, start);
  }
});

test("today button and switching to week use the chosen weekday", () => {
  const card = createCard({ first_day: "sunday" });
  card._setView({ mode: "week" });
  const today = card._dateToISO(new Date());
  const expected = card._defaultAnchor("week", today);
  assert.equal(card._anchorDate, expected);

  const controls = new Map();
  const nav = {
    set innerHTML(_html) {
      controls.clear();
    },
    querySelector(selector) {
      if (!controls.has(selector)) {
        controls.set(selector, { addEventListener: (event, fn) => controls.set(`${selector}:${event}`, fn) });
      }
      return controls.get(selector);
    },
  };
  card._root.querySelector = () => nav;
  delete card._renderNav;
  card._anchorDate = "2024-01-01";
  card._renderNav();
  controls.get("#fc-nav-today:click")();
  assert.equal(card._anchorDate, expected);
});

test("month grid aligns its boundaries and labels, with Monday as the default", () => {
  for (const [firstDay, expected, firstLabel] of [
    ["sunday", ["2026-02-01", "2026-03-01"], "Sun"],
    ["monday", ["2026-01-26", "2026-03-02"], "Mon"],
    ["current_day", ["2026-01-26", "2026-03-02"], "Mon"],
    [undefined, ["2026-01-26", "2026-03-02"], "Mon"],
  ]) {
    const card = createCard({ first_day: firstDay, view: "month" });
    card._setView({ start_date: "2026-02-18" });
    assert.deepEqual(range(card), expected);
    const week = { classList: { add: () => {}, remove: () => {} }, querySelectorAll: () => [] };
    card._root.querySelector = () => week;
    card._days = [];
    card._renderMonth();
    assert.match(week.innerHTML, new RegExp(`^<div class="fc-month-weekday-label">${firstLabel}</div>`));
    card._shiftAnchor(1);
    assert.equal(card._anchorDate, "2026-03-01");
    card._setView({ start_date: "2026-05-20" });
    assert.equal(range(card)[1], firstDay === "sunday" ? "2026-06-07" : "2026-06-01");
  }
});

test("day, three-day and fixed-length views retain the selected date", () => {
  for (const options of [{ view: "day" }, { view: "three_day" }, { days: 7 }]) {
    const card = createCard({ ...options, first_day: "monday" });
    card._setView({ start_date: "2026-03-04" });
    assert.equal(card._anchorDate, "2026-03-04");
  }
});

test("invalid first-day values report a configuration error", () => {
  assert.throws(() => createCard({ first_day: "tuesday" }), /first_day must be/);
});

test("header appearance uses selected theme and falls back for older settings", () => {
  const card = createCard();
  const properties = new Map();
  card._built = true;
  card._root.querySelector = () => ({ style: { setProperty: (key, value) => properties.set(key, value) } });
  card._hass = { themes: { darkMode: false } };
  card._settings = { weekday_font_size: 20, light_header_color: "#abcdef", dark_header_color: "#123456" };
  card._theme = "light";
  card._applyTheme();
  assert.equal(properties.get("--fc-weekday-size"), "20px");
  assert.equal(properties.get("--fc-header-background"), "#abcdef");
  card._theme = "dark";
  card._applyTheme();
  assert.equal(properties.get("--fc-header-background"), "#123456");
  card._settings = {};
  card._applyTheme();
  assert.equal(properties.get("--fc-weekday-size"), "16px");
  assert.equal(properties.get("--fc-header-background"), "transparent");
});
