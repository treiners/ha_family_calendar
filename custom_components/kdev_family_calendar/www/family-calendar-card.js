/** Bundled Home Assistant calendar card. NEW */

const CARD_VERSION = "1.0.0";
const SUBSCRIPTION_RETRY_DELAY = 10000;

console.info(
  `%c FAMILY-CALENDAR-CARD %c v${CARD_VERSION} `,
  "color: white; background: #444; font-weight: 700;",
  "color: #444; background: white; font-weight: 700;"
);

const DEFAULT_ICON_KEYWORDS = {
  trash: "mdi:trash-can",
  bin: "mdi:trash-can",
  recycling: "mdi:recycle",
  haircut: "mdi:content-cut",
  piano: "mdi:piano",
  violin: "mdi:violin",
  soccer: "mdi:soccer",
  football: "mdi:football",
  swim: "mdi:swim",
  doctor: "mdi:stethoscope",
  dentist: "mdi:tooth",
  birthday: "mdi:cake-variant",
  school: "mdi:school",
};

class FamilyCalendarCard extends HTMLElement {
  static getConfigElement() {
    return document.createElement("family-calendar-card-editor");
  }

  static getStubConfig() {
    return { instance: `calendar-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` };
  }

  constructor() {
    super();
    // Shadow root is required for :host CSS variables to work at all,
    // and keeps our CSS classes (.fc-event, .fc-day, etc.) isolated
    // from other cards' global card_mod / theme CSS on the page.
    this._root = this.attachShadow({ mode: "open" });
    this._subscriptions = [];
    this._subscriptionGeneration = 0;
    this._subscriptionRetry = null;
    this._errandsGeneration = 0;
    this._errandsUnsubscribe = null;
    this._errandsState = null;
    this._errandsCanManage = false;
    this._errandsCanAct = false;
    this._errandsView = false;
    this._errandsBusy = false;
  }

  setConfig(config) {
    if (typeof config.instance !== "string" || !config.instance.trim()) {
      throw new Error("family-calendar-card requires a stable, unique instance name.");
    }
    if (config.first_day !== undefined && !["current_day", "sunday", "monday"].includes(config.first_day)) {
      throw new Error("first_day must be current_day, sunday, or monday.");
    }
    this._clearSubscriptions();
    this._clearErrands();
    this._config = config;
    this._instance = config.instance.trim();
    this._sensorEntity = config.config_entity || config.entity || "sensor.family_calendar_configuration";
    this._preferences = this._loadPreferences();
    this._fixedDays = Number.isInteger(config.days) && config.days > 0 ? config.days : null;
    this._yamlLocks = new Set(
      ["view", "layout", "multi_day", "event_style", "start_hour", "end_hour", "hour_height", "theme"].filter((key) =>
        Object.hasOwn(config, key)
      )
    );
    this._calendarList = [];
    this._settings = {};
    this._days = [];
    this._hiddenList = this._preferences.hidden_calendars || [];
    this._subscriptionError = "";
    this._errandsError = "";
    this._errandsState = null;
    this._errandsCanManage = false;
    this._errandsCanAct = false;
    this._errandsView = false;
    this._errandsPerson = null;
    this._errandsPending = null;
    this._errandFormRevision = null;
    this._calendarEvents = {};
    this._built = false;
    this._anchorDate = null;
  }

  set hass(hass) {
    this._hass = hass;
    const stateObj = hass.states[this._sensorEntity] || this._findConfigurationState(hass);

    if (!stateObj) {
      this._clearSubscriptions();
      this._clearErrands();
      this._root.innerHTML = `<ha-card><div class="fc-error">Entity not found: ${this._sensorEntity}</div></ha-card>`;
      this._built = false;
      return;
    }

    this._calendarList = Array.isArray(stateObj.attributes.calendars) ? stateObj.attributes.calendars : [];
    this._settings = stateObj.attributes.defaults || {};
    if (!this._built) {
      this._buildShell();
      this._built = true;
    }

    this._applySettings();
    this._applyTheme();
    this._renderToggles();
    this._renderNav();
    this._render();
    this._renderErrands();
    void this._ensureSubscriptions();
    void this._ensureErrands(stateObj.entity_id);
  }

  _findConfigurationState(hass) {
    if (this._config.config_entity || this._config.entity) {
      return undefined;
    }
    return Object.values(hass.states).find(
      (state) =>
        state.entity_id.startsWith("sensor.") &&
        Array.isArray(state.attributes?.calendars) &&
        state.attributes?.defaults !== undefined
    );
  }

  disconnectedCallback() {
    this._clearSubscriptions();
    this._clearErrands();
  }

  connectedCallback() {
    if (!this._hass || !this._config) return;
    const state = this._hass.states[this._sensorEntity] || this._findConfigurationState(this._hass);
    if (state) void this._ensureErrands(state.entity_id);
    void this._ensureSubscriptions();
  }

  _clearSubscriptions() {
    this._subscriptionGeneration += 1;
    clearTimeout(this._subscriptionRetry);
    this._subscriptionRetry = null;
    this._subscriptions.forEach((unsubscribe) => unsubscribe());
    this._subscriptions = [];
    this._subscriptionKey = null;
  }

  _clearErrands() {
    this._errandsGeneration += 1;
    clearTimeout(this._errandsRetry);
    this._errandsRetry = null;
    this._errandsUnsubscribe?.();
    this._errandsUnsubscribe = null;
    this._errandsKey = null;
    this._errandsEntry = null;
    this._errandsConnection = null;
    this._errandsCanManage = false;
    this._errandsCanAct = false;
  }

  async _ensureErrands(sensor) {
    if (!this._hass?.connection || !sensor) return;
    if (this._errandsKey === sensor && this._errandsConnection === this._hass.connection) return;
    if (this._errandsKey && this._errandsKey !== sensor) {
      this._errandsState = null;
      this._errandsPending = null;
    }
    this._clearErrands();
    this._errandsKey = sensor;
    this._errandsConnection = this._hass.connection;
    const generation = this._errandsGeneration;
    try {
      const registry = await this._hass.callWS({ type: "config/entity_registry/get", entity_id: sensor });
      if (!registry?.config_entry_id) throw new Error("Configuration sensor is not linked to an integration.");
      if (generation !== this._errandsGeneration) return;
      this._errandsEntry = registry.config_entry_id;
      const unsubscribe = await this._hass.connection.subscribeMessage(
        (message) => {
          if (generation !== this._errandsGeneration) return;
          if (!message.available) {
            this._errandsCanManage = false;
            this._errandsCanAct = false;
            this._errandsState = null;
            this._errandsError = message.error === "unauthorized"
              ? "You do not have permission to view all family errands."
              : "Errands are unavailable. Reload the integration or try again.";
            this._refreshErrands();
            clearTimeout(this._errandsRetry);
            this._errandsRetry = setTimeout(() => {
              this._errandsKey = null;
              void this._ensureErrands(sensor);
            }, SUBSCRIPTION_RETRY_DELAY);
            return;
          }
          this._errandsError = "";
          this._errandsCanManage = message.can_manage === true;
          this._errandsCanAct = message.can_act === true;
          this._setErrandsState(message.data);
        },
        { type: "kdev_family_calendar/errands/subscribe", entry_id: registry.config_entry_id }
      );
      if (generation !== this._errandsGeneration) unsubscribe();
      else this._errandsUnsubscribe = unsubscribe;
    } catch (error) {
      if (generation !== this._errandsGeneration) return;
      this._errandsState = null;
      this._errandsError = `Could not connect to errands: ${error?.message || error}`;
      this._refreshErrands();
      this._errandsRetry = setTimeout(() => {
        this._errandsKey = null;
        void this._ensureErrands(sensor);
      }, SUBSCRIPTION_RETRY_DELAY);
    }
  }

  _setErrandsState(state) {
    if (!state || (this._errandsState && state.revision < this._errandsState.revision)) return;
    this._errandsState = state;
    this._refreshErrands();
  }

  _refreshErrands() {
    if (!this._built) return;
    this._renderErrands();
    this._renderToggles();
    const error = this._root.querySelector("#fc-errand-form-error");
    if (error) {
      error.textContent = this._errandsError;
      error.hidden = !this._errandsError;
    }
    const recovery = this._root.querySelector("#fc-errand-recovery");
    if (recovery) recovery.hidden = !this._errandsPending;
  }

  async _sendErrands(message, retry = false) {
    if (this._errandsBusy || !this._errandsState || !this._errandsEntry || (this._errandsPending && !retry)) return false;
    this._errandsBusy = true;
    this._errandsError = "";
    const request = retry ? this._errandsPending : {
      ...message,
      entry_id: this._errandsEntry,
      revision: this._errandFormRevision ?? this._errandsState.revision,
    };
    this._refreshErrands();
    try {
      const state = await this._hass.callWS(request);
      this._errandsPending = null;
      this._setErrandsState(state);
      return true;
    } catch (error) {
      this._errandsError = `Could not save: ${error?.message || error}`;
      this._errandsPending = request;
      return false;
    } finally {
      this._errandsBusy = false;
      this._refreshErrands();
    }
  }

  _applyErrand(command, args) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return this._sendErrands({
      type: "kdev_family_calendar/errands/apply",
      command,
      args,
      operation_id: Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""),
    });
  }

  async _resolveErrandError() {
    try {
      const state = await this._hass.callWS({
        type: "kdev_family_calendar/errands/get",
        entry_id: this._errandsEntry,
      });
      this._errandsPending = null;
      this._errandsError = "";
      this._setErrandsState(state);
      if (this._errandFormRevision !== null) this._closeModal();
    } catch (error) {
      this._errandsError = `Could not refresh errands: ${error?.message || error}`;
      this._refreshErrands();
    }
  }

  _loadPreferences() {
    try {
      return JSON.parse(localStorage.getItem(`family-calendar:${this._instance}`) || "{}");
    } catch (error) {
      console.warn("Family Calendar could not read this card's saved preferences.", error);
      return {};
    }
  }

  _savePreferences() {
    this._preferences = {
      ...this._preferences,
      view: this._viewMode,
      layout: this._layout === "spaced" ? "timeline" : "condensed",
      multi_day: this._multiDay,
      event_style: this._eventStyle,
      start_hour: this._startHour,
      end_hour: this._endHour,
      hour_height: this._hourHeight,
      anchor_date: this._anchorDate,
      hidden_calendars: this._hiddenList,
    };
    try {
      localStorage.setItem(`family-calendar:${this._instance}`, JSON.stringify(this._preferences));
    } catch (error) {
      console.warn("Family Calendar could not save this card's preferences.", error);
    }
  }

  _applySettings() {
    const saved = this._preferences;
    const defaults = this._settings;
    this._viewMode = this._fixedDays
      ? "custom"
      : this._yamlLocks.has("view")
        ? this._normalizeView(this._config.view)
        : this._normalizeView(saved.view || defaults.view || "week");
    const layout = this._yamlLocks.has("layout") ? this._config.layout : saved.layout || defaults.layout || "condensed";
    this._layout = layout === "timeline" || layout === "spaced" ? "spaced" : "condensed";
    const multiDay = this._yamlLocks.has("multi_day") ? this._config.multi_day : saved.multi_day;
    this._multiDay = multiDay === "banners" ? "banners" : "segments";
    const eventStyle = this._yamlLocks.has("event_style") ? this._config.event_style : saved.event_style;
    this._eventStyle = eventStyle === "filled" ? "filled" : "bar";
    this._startHour = Number(
      this._yamlLocks.has("start_hour") ? this._config.start_hour : (saved.start_hour ?? defaults.start_hour ?? 7)
    );
    this._endHour = Number(
      this._yamlLocks.has("end_hour") ? this._config.end_hour : (saved.end_hour ?? defaults.end_hour ?? 19)
    );
    this._hourHeight = Number(
      this._yamlLocks.has("hour_height")
        ? this._config.hour_height
        : (saved.hour_height ?? defaults.hour_height ?? 48)
    );
    if (this._endHour <= this._startHour) {
      this._endHour = this._startHour + 1;
    }
    this._theme = this._yamlLocks.has("theme") ? this._config.theme : (defaults.theme || "system");
    if (!this._anchorDate) {
      this._anchorDate = this._defaultAnchor(this._viewMode, this._dateToISO(new Date()));
    }
    const configuredIds = this._calendarList.map((calendar) => calendar.entity_id);
    this._hiddenList = Array.isArray(saved.hidden_calendars)
      ? saved.hidden_calendars.filter((entityId) => configuredIds.includes(entityId))
      : [];
  }

  _normalizeView(view) {
    const normalized = String(view).toLowerCase().replaceAll(" ", "_");
    return ["day", "three_day", "week", "month"].includes(normalized) ? normalized : "week";
  }

  _defaultAnchor(view, date) {
    const anchor = new Date(`${date}T00:00:00`);
    if (view === "month") {
      anchor.setDate(1);
    } else if (
      view === "week" &&
      !this._fixedDays &&
      this._config.first_day !== undefined &&
      this._config.first_day !== "current_day"
    ) {
      const firstDay = this._config.first_day === "sunday" ? 0 : 1;
      anchor.setDate(anchor.getDate() - ((anchor.getDay() - firstDay + 7) % 7));
    }
    return this._dateToISO(anchor);
  }

  _applyTheme() {
    if (!this._built) return;
    const dark = this._theme === "dark" || (this._theme === "system" && Boolean(this._hass.themes?.darkMode));
    const prefix = dark ? "dark_" : "light_";
    const card = this._root.querySelector("ha-card");
    card.style.setProperty("--fc-paper", this._settings[`${prefix}day_color`] || "var(--secondary-background-color)");
    card.style.setProperty("--fc-paper-today", this._settings[`${prefix}today_color`] || "var(--primary-color)");
    card.style.setProperty("--card-background-color", this._settings[`${prefix}card_color`] || "var(--card-background-color)");
  }

  _getViewRange() {
    const start = new Date(`${this._anchorDate}T00:00:00`);
    if (this._viewMode === "month" && !this._fixedDays) {
      const monthStart = new Date(start.getFullYear(), start.getMonth(), 1);
      const monthEnd = new Date(start.getFullYear(), start.getMonth() + 1, 0);
      const firstDay = this._config.first_day === "sunday" ? 0 : 1;
      const gridStart = new Date(monthStart);
      gridStart.setDate(gridStart.getDate() - ((gridStart.getDay() - firstDay + 7) % 7));
      const gridEnd = new Date(monthEnd);
      gridEnd.setDate(gridEnd.getDate() + 7 - ((gridEnd.getDay() - firstDay + 7) % 7));
      return { start: gridStart, end: gridEnd, month: start.getMonth() };
    }
    const dayCount = this._fixedDays || ({ day: 1, three_day: 3, week: 7 }[this._viewMode] || 7);
    const end = new Date(start);
    end.setDate(end.getDate() + dayCount);
    return { start, end, month: start.getMonth() };
  }

  async _ensureSubscriptions(force = false) {
    if (!this._hass) return;
    if (!this._calendarList.length) {
      this._clearSubscriptions();
      this._subscriptionError = "";
      this._calendarEvents = {};
      this._buildDays();
      this._render();
      return;
    }
    const range = this._getViewRange();
    const start = range.start.toISOString();
    const end = range.end.toISOString();
    const key = `${JSON.stringify(this._calendarList)}|${start}|${end}`;
    if (!force && this._subscriptionKey === key) return;

    this._clearSubscriptions();
    this._subscriptionKey = key;
    this._subscriptionError = "";
    this._calendarEvents = {};
    this._buildDays(range);
    this._render();

    await this._subscribeCalendars(this._calendarList, range, start, end, this._subscriptionGeneration);
  }

  async _subscribeCalendars(calendars, range, start, end, generation) {
    const results = await Promise.all(
      calendars.map(async (calendar) => {
        try {
          const unsubscribe = await this._hass.connection.subscribeMessage(
            (message) => {
              if (this._subscriptionGeneration !== generation) return;
              this._calendarEvents[calendar.entity_id] = (message.events || []).map((event) =>
                this._normalizeEvent(calendar, event)
              );
              this._buildDays(range);
              this._renderToggles();
              this._render();
            },
            {
              type: "calendar/event/subscribe",
              entity_id: calendar.entity_id,
              start,
              end,
            }
          );
          if (this._subscriptionGeneration !== generation) {
            unsubscribe();
          } else {
            this._subscriptions.push(unsubscribe);
          }
          return null;
        } catch (error) {
          return { calendar, error };
        }
      })
    );

    if (this._subscriptionGeneration !== generation) return;
    const failed = results.filter((result) => result !== null);
    const errorMessage = failed.length
      ? `Could not load ${failed[0].calendar.name}: ${failed[0].error?.message || failed[0].error}`
      : "";
    if (errorMessage && errorMessage !== this._subscriptionError) {
      console.error("Family Calendar calendar subscription failed.", failed[0].error);
    }
    this._subscriptionError = errorMessage;
    this._render();
    if (failed.length) {
      this._subscriptionRetry = setTimeout(() => {
        this._subscriptionRetry = null;
        void this._subscribeCalendars(
          failed.map((result) => result.calendar),
          range,
          start,
          end,
          generation
        );
      }, SUBSCRIPTION_RETRY_DELAY);
    }
  }

  get _iconKeywords() {
    const configured = {};
    for (const item of this._settings.icon_keywords || []) {
      if (item?.keyword && item?.icon) configured[item.keyword] = item.icon;
    }
    return { ...DEFAULT_ICON_KEYWORDS, ...configured, ...(this._config.icon_keywords || {}) };
  }

  get _dayMarkers() {
    if (Array.isArray(this._config.day_markers)) return this._config.day_markers;
    return Array.isArray(this._settings.day_markers) ? this._settings.day_markers : [];
  }

  _matchIcon(summary) {
    const text = String(summary || "").toLowerCase();
    for (const [keyword, icon] of Object.entries(this._iconKeywords)) {
      if (text.includes(keyword.toLowerCase())) return icon;
    }
    return "";
  }

  _normalizeEvent(calendar, event) {
    return {
      ...event,
      summary: event.summary || "Untitled event",
      all_day: Boolean(event.all_day),
      calendar_entity: calendar.entity_id,
      person: calendar.name,
      color: calendar.color,
      text_color: calendar.text_color || this._contrastColor(calendar.color),
      icon: this._matchIcon(event.summary) || (event.all_day ? "mdi:calendar" : "mdi:clock-outline"),
    };
  }

  _buildDays(range = this._getViewRange()) {
    const days = [];
    const current = new Date(range.start);
    while (current < range.end) {
      const date = this._dateToISO(current);
      days.push({
        date,
        events: [],
        in_month: current.getMonth() === range.month,
      });
      current.setDate(current.getDate() + 1);
    }

    Object.values(this._calendarEvents).flat().forEach((event) => {
      const eventStart = this._eventDate(event.start, event.all_day);
      const eventEnd = this._eventDate(event.end, event.all_day);
      if (!eventStart || !eventEnd) {
        console.error("Family Calendar received an event with an invalid date.", event);
        return;
      }
      days.forEach((day) => {
        const dayStart = new Date(`${day.date}T00:00:00`);
        const dayEnd = new Date(dayStart);
        dayEnd.setDate(dayEnd.getDate() + 1);
        if (eventStart < dayEnd && eventEnd > dayStart) day.events.push(event);
      });
    });
    days.forEach((day) => day.events.sort((left, right) => new Date(left.start) - new Date(right.start)));
    this._days = days;
  }

  _contrastColor(color) {
    const match = /^#([0-9a-f]{6})$/i.exec(String(color));
    if (!match) return "#000000";
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(match[1].slice(i, i + 2), 16));
    return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? "#000000" : "#ffffff";
  }

  _eventStyleAttr(ev) {
    return this._eventStyle === "filled"
      ? `background:${ev.color}; border-left-color:${ev.color}; --fc-ev-text:${ev.text_color}`
      : `border-left-color:${ev.color}`;
  }

  _isMultiDay(ev) {
    const start = this._eventDate(ev.start, ev.all_day);
    const end = this._eventDate(ev.end, ev.all_day);
    if (!start || !end) return false;
    const lastMoment = new Date(Math.max(start.getTime(), end.getTime() - 1));
    return this._dateToISO(start) !== this._dateToISO(lastMoment);
  }

  _eventDate(value, allDay) {
    if (typeof value !== "string") return null;
    if (allDay && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
      const [year, month, day] = value.split("-").map(Number);
      return new Date(year, month - 1, day);
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  _buildShell() {
    this._root.innerHTML = `
      <style>${FamilyCalendarCard.styles}</style>
      <ha-card>
        <div class="fc-header-row">
          <div class="fc-toggles" id="fc-toggles"></div>
          <button class="fc-mode-btn" id="fc-errands-toggle" type="button">Errands</button>
          <button class="fc-reload-btn" id="fc-reload-btn" title="Refresh events">
            <ha-icon icon="mdi:refresh"></ha-icon>
          </button>
          <button class="fc-add-btn" id="fc-add-btn" title="Add event">
            <ha-icon icon="mdi:calendar-plus"></ha-icon>
          </button>
        </div>
        <div class="fc-nav-row" id="fc-nav-row"></div>
        <div class="fc-error" id="fc-error" hidden></div>
        <div class="fc-week" id="fc-week"></div>
        <div class="fc-errands" id="fc-errands" hidden></div>
        <div class="fc-modal" id="fc-modal" hidden>
          <div class="fc-modal-backdrop" id="fc-modal-backdrop"></div>
          <div class="fc-modal-panel">
            <button class="fc-modal-close" id="fc-modal-close" aria-label="Close">&times;</button>
            <div class="fc-modal-body" id="fc-modal-body"></div>
          </div>
        </div>
        <div class="fc-footer">family-calendar-card v${CARD_VERSION}</div>
      </ha-card>
    `;
    this._root.querySelector("#fc-modal-close").addEventListener("click", () => this._closeModal());
    this._root.querySelector("#fc-modal-backdrop").addEventListener("click", () => this._closeModal());
    this._root.querySelector("#fc-reload-btn").addEventListener("click", (e) => {
      const btn = e.currentTarget;
      btn.classList.add("fc-spin");
      void this._ensureSubscriptions(true);
      setTimeout(() => btn.classList.remove("fc-spin"), 1000);
    });
    this._root.querySelector("#fc-add-btn").addEventListener("click", () => this._showEventForm());
    this._root.querySelector("#fc-errands-toggle").addEventListener("click", () => {
      this._errandsView = !this._errandsView;
      this._renderErrands();
      this._renderToggles();
    });
  }

  _closeModal() {
    this._root.querySelector("#fc-modal").hidden = true;
    this._errandFormRevision = null;
  }

  _openModal(ev) {
    const body = this._root.querySelector("#fc-modal-body");
    const startLabel = this._formatTime(ev.start, ev.all_day);
    const endLabel = this._formatTime(ev.end, ev.all_day);
    const timeLine = ev.all_day ? "All day" : `${startLabel} - ${endLabel}`;
    const features = this._calendarFeatures(ev.calendar_entity);
    const recurring = Boolean(ev.rrule || ev.recurrence_id);
    const canModify = Boolean(ev.uid) && !recurring;
    const canEdit = canModify && Boolean(features & 4);
    const canDelete = canModify && Boolean(features & 2);
    body.innerHTML = `
      <div class="fc-modal-tag" style="background:${this._escape(ev.color)}; color:${this._escape(ev.text_color)}">${this._escape(ev.person)}</div>
      <h3 class="fc-modal-title">${this._escape(ev.summary)}</h3>
      <div class="fc-modal-row"><ha-icon icon="mdi:clock-outline"></ha-icon><span>${timeLine}</span></div>
      ${ev.location ? `<div class="fc-modal-row"><ha-icon icon="mdi:map-marker"></ha-icon><span>${this._escape(ev.location)}</span></div>` : ""}
      ${ev.description ? `<div class="fc-modal-desc">${this._escape(ev.description)}</div>` : ""}
      ${recurring ? `<div class="fc-modal-note">Recurring events cannot be changed from this card.</div>` : ""}
      <div class="fc-modal-actions">
        ${canEdit ? `<button class="fc-modal-action" id="fc-modal-edit">Edit</button>` : ""}
        ${canDelete ? `<button class="fc-modal-delete" id="fc-modal-delete">Delete event</button>` : ""}
      </div>
      <div class="fc-form-error" id="fc-form-error" hidden></div>
    `;
    this._root.querySelector("#fc-modal").hidden = false;

    body.querySelector("#fc-modal-edit")?.addEventListener("click", () => this._showEventForm(ev));
    const deleteBtn = body.querySelector("#fc-modal-delete");
    deleteBtn?.addEventListener("click", () => this._deleteEvent(ev));
  }

  _calendarFeatures(entityId) {
    return Number(this._hass.states[entityId]?.attributes?.supported_features || 0);
  }

  async _deleteEvent(ev) {
    if (!ev.uid || ev.rrule || ev.recurrence_id || !(this._calendarFeatures(ev.calendar_entity) & 2)) return;
    if (!confirm(`Delete "${ev.summary}"? This can't be undone.`)) return;
    try {
      await this._hass.connection.sendMessagePromise({
        type: "calendar/event/delete",
        entity_id: ev.calendar_entity,
        uid: ev.uid,
      });
      this._closeModal();
      await this._ensureSubscriptions(true);
    } catch (error) {
      const errorEl = this._root.querySelector("#fc-form-error");
      errorEl.textContent = `Delete failed: ${error.message || error}`;
      errorEl.hidden = false;
      console.error("Family Calendar could not delete the event.", error);
    }
  }

  _showEventForm(event = null, prefillStart = null) {
    const eligible = this._calendarList.filter((calendar) =>
      calendar.entity_id === (event?.calendar_entity || calendar.entity_id) &&
      Boolean(this._calendarFeatures(calendar.entity_id) & (event ? 4 : 1))
    );
    if (!eligible.length) {
      this._subscriptionError = event
        ? "This calendar does not support editing events."
        : "None of the selected calendars supports creating events.";
      this._render();
      return;
    }
    const calendar = eligible.find((item) => item.entity_id === event?.calendar_entity) || eligible[0];
    const allDay = Boolean(event?.all_day);
    const now = prefillStart || new Date();
    const defaultEnd = new Date(now.getTime() + 60 * 60 * 1000);
    const startDate = event ? this._dateInput(event.start, allDay) : this._dateToISO(now);
    const endDate = event
      ? this._dateInput(event.end, allDay, allDay)
      : this._dateToISO(defaultEnd);
    const startTime = event && !allDay ? this._dateTimeInput(event.start) : this._dateTimeInput(now.toISOString());
    const endTime = event && !allDay ? this._dateTimeInput(event.end) : this._dateTimeInput(defaultEnd.toISOString());
    const body = this._root.querySelector("#fc-modal-body");
    body.innerHTML = `
      <h3 class="fc-modal-title">${event ? "Edit event" : "Add event"}</h3>
      <form id="fc-event-form" class="fc-event-form">
        <label>Calendar
          <select name="entity_id" required ${event ? "disabled" : ""}>
            ${eligible
              .map(
                (item) =>
                  `<option value="${this._escape(item.entity_id)}" ${item.entity_id === calendar.entity_id ? "selected" : ""}>${this._escape(item.name)}</option>`
              )
              .join("")}
          </select>
        </label>
        <label>Title<input name="summary" value="${this._escape(event?.summary || "")}" required maxlength="255"></label>
        <label class="fc-event-allday"><input name="all_day" type="checkbox" ${allDay ? "checked" : ""}> All day</label>
        <div class="fc-event-date-fields" ${allDay ? "" : "hidden"}>
          <label>Start date<input name="start_date" type="date" value="${startDate}" required></label>
          <label>End date<input name="end_date" type="date" value="${endDate}" required></label>
        </div>
        <div class="fc-event-time-fields" ${allDay ? "hidden" : ""}>
          <label>Start time<input name="start_time" type="datetime-local" value="${startTime}" required></label>
          <label>End time<input name="end_time" type="datetime-local" value="${endTime}" required></label>
        </div>
        <label>Description<textarea name="description" rows="3">${this._escape(event?.description || "")}</textarea></label>
        <label>Location<input name="location" value="${this._escape(event?.location || "")}"></label>
        <div class="fc-form-error" id="fc-form-error" hidden></div>
        <button class="fc-modal-action" type="submit">${event ? "Save changes" : "Create event"}</button>
      </form>
    `;
    this._root.querySelector("#fc-modal").hidden = false;
    const form = body.querySelector("#fc-event-form");
    form.querySelector('[name="start_date"]').required = allDay;
    form.querySelector('[name="end_date"]').required = allDay;
    form.querySelector('[name="start_time"]').required = !allDay;
    form.querySelector('[name="end_time"]').required = !allDay;
    form.querySelector('[name="all_day"]').addEventListener("change", (e) => {
      const isAllDay = e.target.checked;
      form.querySelector(".fc-event-date-fields").hidden = !isAllDay;
      form.querySelector(".fc-event-time-fields").hidden = isAllDay;
      form.querySelector('[name="start_date"]').required = isAllDay;
      form.querySelector('[name="end_date"]').required = isAllDay;
      form.querySelector('[name="start_time"]').required = !isAllDay;
      form.querySelector('[name="end_time"]').required = !isAllDay;
    });
    const startTimeInput = form.querySelector('[name="start_time"]');
    startTimeInput.addEventListener("change", () => {
      const start = new Date(startTimeInput.value);
      if (Number.isNaN(start.getTime())) return;
      form.querySelector('[name="end_time"]').value = this._dateTimeInput(new Date(start.getTime() + 60 * 60 * 1000).toISOString());
    });
    const startDateInput = form.querySelector('[name="start_date"]');
    startDateInput.addEventListener("change", () => {
      const endDateInput = form.querySelector('[name="end_date"]');
      if (!endDateInput.value || endDateInput.value < startDateInput.value) endDateInput.value = startDateInput.value;
    });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      void this._submitEventForm(form, event);
    });
  }

  _dateInput(value, allDay, exclusiveEnd = false) {
    const date = this._eventDate(value, allDay);
    if (!date) return "";
    if (allDay && exclusiveEnd) date.setDate(date.getDate() - 1);
    return this._dateToISO(date);
  }

  _dateTimeInput(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const pad = (number) => String(number).padStart(2, "0");
    return `${this._dateToISO(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  async _submitEventForm(form, existingEvent) {
    const values = new FormData(form);
    const errorEl = form.querySelector("#fc-form-error");
    const summary = String(values.get("summary") || "").trim();
    const allDay = values.get("all_day") === "on";
    let start;
    let end;
    if (allDay) {
      start = String(values.get("start_date"));
      const lastDay = String(values.get("end_date"));
      if (!this._isValidDate(start) || !this._isValidDate(lastDay)) {
        errorEl.textContent = "Enter a valid start date and end date.";
        errorEl.hidden = false;
        return;
      }
      const exclusiveEnd = new Date(`${lastDay}T00:00:00`);
      exclusiveEnd.setDate(exclusiveEnd.getDate() + 1);
      end = this._dateToISO(exclusiveEnd);
    } else {
      const startDate = new Date(String(values.get("start_time")));
      const endDate = new Date(String(values.get("end_time")));
      if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
        errorEl.textContent = "Enter a valid start and end time.";
        errorEl.hidden = false;
        return;
      }
      start = startDate.toISOString();
      end = endDate.toISOString();
    }
    if (!summary || new Date(start) >= new Date(end)) {
      errorEl.textContent = "Enter a title and an end time after the start time.";
      errorEl.hidden = false;
      return;
    }
    const event = {
      summary,
      dtstart: start,
      dtend: end,
      description: String(values.get("description") || ""),
      location: String(values.get("location") || ""),
    };
    const entityId = existingEvent?.calendar_entity || String(values.get("entity_id"));
    try {
      if (existingEvent) {
        await this._hass.connection.sendMessagePromise({
          type: "calendar/event/update",
          entity_id: entityId,
          uid: existingEvent.uid,
          event,
        });
      } else {
        await this._hass.connection.sendMessagePromise({
          type: "calendar/event/create",
          entity_id: entityId,
          event,
        });
      }
      this._closeModal();
      await this._ensureSubscriptions(true);
    } catch (error) {
      errorEl.textContent = `Could not save the event: ${error.message || error}`;
      errorEl.hidden = false;
      console.error("Family Calendar could not save the event.", error);
    }
  }

  _openListModal(events) {
    const body = this._root.querySelector("#fc-modal-body");
    let html = `<h3 class="fc-modal-title">Outside visible hours</h3><div class="fc-modal-list">`;
    let i = 0;
    while (i < events.length) {
      const ev = events[i];
      const timeLabel = this._formatTime(ev.start, ev.all_day);
      html += `
        <div class="fc-modal-list-row" data-list-idx="${i}">
          <span class="fc-modal-list-dot" style="background:${ev.color}"></span>
          <span class="fc-modal-list-title">${this._escape(ev.summary)}</span>
          <span class="fc-modal-list-time">${timeLabel}</span>
        </div>
      `;
      i += 1;
    }
    html += `</div>`;
    body.innerHTML = html;
    const rows = body.querySelectorAll(".fc-modal-list-row");
    rows.forEach((row) => {
      row.addEventListener("click", () => {
        const idx = parseInt(row.dataset.listIdx, 10);
        this._openModal(events[idx]);
      });
    });
    this._root.querySelector("#fc-modal").hidden = false;
  }

  _escape(str) {
    const div = document.createElement("div");
    div.textContent = str || "";
    return div.innerHTML;
  }

  _escapeAttr(value) {
    return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
  }

  _formatTime(raw, allDay) {
    if (!raw) return "";
    if (allDay) return "All day";
    const d = new Date(raw);
    if (isNaN(d.getTime())) return raw;
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  _hoursSinceMidnight(iso, day = null) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return 0;
    if (!day) return d.getHours() + d.getMinutes() / 60;
    const hours = (d - new Date(`${day}T00:00:00`)) / 3600000;
    return this._clamp(hours, 0, 24);
  }

  _clamp(val, min, max) {
    if (val < min) return min;
    if (val > max) return max;
    return val;
  }

  /**
   * Assigns side-by-side column positions to overlapping timed events for
   * one day, so concurrent events don't render on top of each other.
   * Returns an array parallel to `events`, each entry {colIndex, colCount}.
   */
  _layoutOverlaps(events, day = null) {
    const withRange = events.map((ev) => {
      const trueStart = this._hoursSinceMidnight(ev.start, day);
      const trueEnd = this._hoursSinceMidnight(ev.end, day);
      return {
        ev,
        trueStart,
        trueEnd,
        start: this._clamp(trueStart, this._startHour, this._endHour),
        end: this._clamp(trueEnd, this._startHour, this._endHour),
      };
    });
    // Ensure a minimum visible sliver even for zero-length-after-clamp events.
    withRange.forEach((item) => {
      if (item.end - item.start < 0.25) {
        item.end = Math.min(this._endHour, item.start + 0.25);
      }
    });
    withRange.sort((a, b) => a.start - b.start);

    const result = new Map();
    let clusterStart = 0;
    let clusterEnd = -Infinity;

    let i = 0;
    while (i < withRange.length) {
      const item = withRange[i];
      if (item.start >= clusterEnd) {
        // flush previous cluster's column count
        this._assignClusterColumns(withRange.slice(clusterStart, i), result);
        clusterStart = i;
        clusterEnd = item.end;
      } else if (item.end > clusterEnd) {
        clusterEnd = item.end;
      }
      i += 1;
    }
    this._assignClusterColumns(withRange.slice(clusterStart), result);

    return events.map(
      (ev) => result.get(ev) || { colIndex: 0, colCount: 1, start: 0, end: 0, clippedTop: false, clippedBottom: false }
    );
  }

  _assignClusterColumns(clusterItems, resultMap) {
    if (clusterItems.length === 0) return;
    const columnEnds = []; // columnEnds[i] = end time of last event in column i
    const assigned = [];

    let i = 0;
    while (i < clusterItems.length) {
      const item = clusterItems[i];
      let col = 0;
      while (col < columnEnds.length && columnEnds[col] > item.start) {
        col += 1;
      }
      columnEnds[col] = item.end;
      assigned.push({ item, col });
      i += 1;
    }

    const colCount = columnEnds.length;
    assigned.forEach(({ item, col }) => {
      resultMap.set(item.ev, {
        colIndex: col,
        colCount,
        start: item.start,
        end: item.end,
        clippedTop: item.trueStart < this._startHour,
        clippedBottom: item.trueEnd > this._endHour,
        trueEnd: item.trueEnd,
      });
    });
  }

  _getCalendarList() {
    return this._calendarList.map((calendar) => ({
      entity: calendar.entity_id,
      person: calendar.name,
      color: calendar.color,
    }));
  }

  _renderErrands() {
    const panel = this._root.querySelector("#fc-errands");
    if (!panel) return;
    const visible = this._errandsView;
    panel.hidden = !visible;
    this._root.querySelector("#fc-week").hidden = visible;
    this._root.querySelector("#fc-nav-row").hidden = visible;
    this._root.querySelector("#fc-add-btn").hidden = visible;
    this._root.querySelector("#fc-reload-btn").hidden = visible;
    this._root.querySelector("#fc-error").hidden = visible || !this._subscriptionError;
    this._root.querySelector("#fc-errands-toggle").textContent = visible ? "Calendar" : "Errands";
    if (!visible) return;

    const state = this._errandsState;
    const people = state?.people.filter((person) => person.enabled !== false &&
      this._calendarList.some((calendar) => calendar.entity_id === person.calendar_entity)
    ) || [];
    if (!people.some((person) => person.id === this._errandsPerson)) this._errandsPerson = people[0]?.id || null;
    const person = people.find((item) => item.id === this._errandsPerson);
    const calendar = this._calendarList.find((item) => item.entity_id === person?.calendar_entity);
    const occurrences = state?.occurrences.filter((item) => item.person_id === person?.id) || [];
    const active = occurrences.filter((item) => item.status === "open" || item.status === "pending");
    const balance = state && person
      ? state.transactions.filter((item) => item.person_id === person.id).reduce((sum, item) => sum + item.amount, 0)
      : 0;
    const locked = this._errandsBusy || Boolean(this._errandsPending);
    const disabled = locked ? "disabled" : "";
    panel.innerHTML = `
      ${this._errandsError ? `<div class="fc-error" role="alert">${this._escape(this._errandsError)}</div>` : ""}
      ${this._errandsPending ? `<div class="fc-errand-actions">
        <button type="button" data-action="retry">Retry same request</button>
        <button type="button" data-action="refresh">Refresh and dismiss</button>
        <span>Refresh to check whether the change was saved before trying a new action.</span>
      </div>` : ""}
      ${!state ? `<p>${this._errandsError ? "Waiting for errands to become available." : "Loading errands…"}</p>` : `
        <div class="fc-errand-toolbar">
          <strong>${person ? `${this._escape(calendar?.name)} · ★ ${balance}` : "Family errands"}</strong>
          ${this._errandsCanManage ? `<button type="button" data-action="people" ${disabled}>People</button>
          <button type="button" data-action="library" ${disabled}>Library</button>` : ""}
          ${person ? `${this._errandsCanManage ? `<button type="button" data-action="add" ${disabled}>Add errand</button>
            <button type="button" data-action="manage" ${disabled}>Manage</button>` : ""}
            ${this._errandsCanAct ? `<button type="button" data-action="deduct" ${disabled}>Use stars</button>` : ""}
            ${this._errandsCanManage ? `<button type="button" data-action="history" ${disabled}>History</button>` : ""}` : ""}
        </div>
        ${!person ? `<p>${this._errandsCanManage ? "Choose which calendars represent people using the People button." : "No family members are available for errands."}</p>` : `
          <p class="fc-errand-hint">${person.approval_required ? "Completed errands need confirmation." : "Stars are awarded immediately."}</p>
          <div class="fc-errand-grid">
            ${active.length ? active.map((item) => `
              <article class="fc-errand-tile">
                <strong>${this._escape(item.name)}</strong>
                <span>★ ${item.stars}${item.day ? ` · ${this._escape(item.day)}` : ""}</span>
                <span>${item.status === "pending" ? "Waiting for confirmation" : "Ready to do"}</span>
                <div class="fc-errand-actions">
                  ${item.status === "open"
                    ? this._errandsCanAct ? `<button type="button" data-action="complete" data-id="${this._escapeAttr(item.id)}" ${disabled}>Done</button>` : ""
                    : this._errandsCanManage ? `<button type="button" data-action="approve" data-id="${this._escapeAttr(item.id)}" ${disabled}>Confirm</button>
                       <button type="button" data-action="undo_completion" data-id="${this._escapeAttr(item.id)}" ${disabled}>Undo</button>` : ""}
                  ${this._errandsCanManage && state.assignments.find((assignment) => assignment.id === item.assignment_id)?.active
                    ? `<button type="button" data-action="edit" data-id="${this._escapeAttr(item.assignment_id)}" ${disabled}>Edit</button>` : ""}
                </div>
              </article>`).join("") : "<p>No errands to do.</p>"}
          </div>`}
      `}
    `;
    panel.querySelectorAll("[data-action]").forEach((button) => button.addEventListener("click", () => {
      const { action, id } = button.dataset;
      if (action === "people") this._showErrandPeople();
      else if (action === "library") this._showErrandLibrary();
      else if (action === "add") this._showErrandForm();
      else if (action === "manage") this._showErrandManage(person);
      else if (action === "edit") this._showErrandForm(state.assignments.find((item) => item.id === id));
      else if (action === "history") this._showErrandHistory(person);
      else if (action === "deduct") this._showErrandDeduction(person);
      else if (action === "retry") void this._sendErrands(null, true);
      else if (action === "refresh") void this._resolveErrandError();
      else void this._applyErrand(action, { id });
    }));
  }

  _errandModal(title, content) {
    const body = this._root.querySelector("#fc-modal-body");
    this._errandFormRevision = this._errandsState.revision;
    body.innerHTML = `<h3 class="fc-modal-title">${this._escape(title)}</h3>
      <div id="fc-errand-form-error" class="fc-error" role="alert" ${this._errandsError ? "" : "hidden"}>${this._escape(this._errandsError)}</div>
      <div id="fc-errand-recovery" class="fc-errand-actions" ${this._errandsPending ? "" : "hidden"}>
        <button type="button" id="fc-errand-retry">Retry same request</button>
        <button type="button" id="fc-errand-refresh">Refresh and discard form</button>
      </div>${content}`;
    this._root.querySelector("#fc-modal").hidden = false;
    body.querySelector("#fc-errand-retry").addEventListener("click", async () => {
      if (await this._sendErrands(null, true)) this._closeModal();
    });
    body.querySelector("#fc-errand-refresh").addEventListener("click", () => void this._resolveErrandError());
    return body;
  }

  _showErrandPeople() {
    const state = this._errandsState;
    const detached = state.people.filter((person) =>
      !this._calendarList.some((calendar) => calendar.entity_id === person.calendar_entity)
    );
    const body = this._errandModal("People and confirmation", `
      <p>Choose which calendars can earn stars. Confirmation is not locked.</p>
      ${this._calendarList.map((calendar, index) => {
        const person = state.people.find((item) => item.calendar_entity === calendar.entity_id);
        return `<form class="fc-errand-form" data-person-index="${index}">
          <strong>${this._escape(calendar.name)}</strong>
          ${person ? "" : `<label>Link existing person or add new
            <select name="person_id"><option value="">Add new person</option>
              ${detached.map((item) => `<option value="${this._escapeAttr(item.id)}">${this._escape(item.calendar_entity)}</option>`).join("")}
            </select></label>`}
          <label><input type="checkbox" name="enabled" ${person?.enabled !== false ? "checked" : ""}> Show in errands</label>
          <label><input type="checkbox" name="approval" ${person?.approval_required ? "checked" : ""}> Require confirmation</label>
          <button type="submit">${person ? "Save" : "Enable errands"}</button>
        </form>`;
      }).join("")}
    `);
    body.querySelectorAll("form").forEach((form) => form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const calendar = this._calendarList[Number(form.dataset.personIndex)];
      const current = state.people.find((item) => item.calendar_entity === calendar.entity_id);
      const personId = current?.id || form.querySelector('[name="person_id"]')?.value;
      const message = {
        type: "kdev_family_calendar/errands/set_person",
        calendar_entity: calendar.entity_id,
        approval_required: form.querySelector('[name="approval"]').checked,
        enabled: form.querySelector('[name="enabled"]').checked,
      };
      if (personId) message.person_id = personId;
      if (await this._sendErrands(message)) this._showErrandPeople();
    }));
  }

  _showErrandForm(assignment = null, template = null) {
    const state = this._errandsState;
    const schedule = assignment?.schedule || { kind: "once", weekdays: [] };
    const onceOnly = assignment?.schedule.kind === "once";
    const recurringOnly = assignment && !onceOnly;
    const body = this._errandModal(assignment ? "Edit errand" : "Add errand", `
      <form class="fc-errand-form" id="fc-errand-form">
        <label>Name <input name="name" required maxlength="200" value="${this._escapeAttr(assignment?.name || template?.name || "")}"></label>
        <label>Stars <input name="stars" type="number" min="1" max="1000000" required value="${assignment?.stars || template?.stars || 1}"></label>
        ${assignment ? "" : `<fieldset><legend>Assign to</legend>${state.people.filter((person) => person.enabled !== false &&
          this._calendarList.some((calendar) => calendar.entity_id === person.calendar_entity)
        ).map((person) => `<label><input type="checkbox" name="person" value="${this._escapeAttr(person.id)}"
          ${person.id === this._errandsPerson ? "checked" : ""}>
          ${this._escape(this._calendarList.find((calendar) => calendar.entity_id === person.calendar_entity)?.name)}</label>`).join("")}</fieldset>`}
        <label>Repeat <select name="kind">
          ${!recurringOnly ? `<option value="once" ${schedule.kind === "once" ? "selected" : ""}>One time</option>` : ""}
          ${!onceOnly ? `<option value="daily" ${schedule.kind === "daily" ? "selected" : ""}>Every day</option>
            <option value="weekly" ${schedule.kind === "weekly" ? "selected" : ""}>Selected weekdays</option>` : ""}
        </select></label>
        <fieldset id="fc-errand-days"><legend>Weekdays</legend>
          ${["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].map((day, index) =>
            `<label><input type="checkbox" name="weekday" value="${index}" ${schedule.weekdays.includes(index) ? "checked" : ""}> ${day}</label>`
          ).join("")}
        </fieldset>
        <label id="fc-errand-due">Due date (optional) <input name="due_date" type="date" value="${this._escapeAttr(assignment?.due_date || "")}"></label>
        <button type="submit">${assignment ? "Save changes" : "Assign errand"}</button>
        ${assignment ? `<button type="button" class="fc-modal-delete" id="fc-errand-delete">Delete errand</button>` : ""}
      </form>
    `);
    const form = body.querySelector("#fc-errand-form");
    const kind = form.querySelector('[name="kind"]');
    const updateSchedule = () => {
      body.querySelector("#fc-errand-days").hidden = kind.value !== "weekly";
      body.querySelector("#fc-errand-due").hidden = kind.value !== "once";
    };
    kind.addEventListener("change", updateSchedule);
    updateSchedule();
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const args = {
        name: form.querySelector('[name="name"]').value,
        stars: Number(form.querySelector('[name="stars"]').value),
        schedule: {
          kind: kind.value,
          weekdays: kind.value === "weekly" ? [...form.querySelectorAll('[name="weekday"]:checked')].map((item) => Number(item.value)) : [],
        },
        due_date: kind.value === "once" ? form.querySelector('[name="due_date"]').value || null : null,
      };
      if (assignment) args.id = assignment.id;
      else args.person_ids = [...form.querySelectorAll('[name="person"]:checked')].map((item) => item.value);
      if (!assignment && !args.person_ids.length) {
        const error = body.querySelector("#fc-errand-form-error");
        error.textContent = "Choose at least one person.";
        error.hidden = false;
        return;
      }
      if (kind.value === "weekly" && !args.schedule.weekdays.length) {
        const error = body.querySelector("#fc-errand-form-error");
        error.textContent = "Choose at least one weekday.";
        error.hidden = false;
        return;
      }
      if (await this._applyErrand(assignment ? "edit_assignment" : "assign", args)) this._closeModal();
    });
    body.querySelector("#fc-errand-delete")?.addEventListener("click", async () => {
      if (window.confirm("Delete this errand? Completed history and pending confirmations will be kept.") &&
          await this._applyErrand("delete_assignment", { id: assignment.id })) this._closeModal();
    });
  }

  _showErrandManage(person) {
    const assignments = this._errandsState.assignments.filter((item) => item.person_id === person.id && item.active);
    const body = this._errandModal("Manage errands", `
      ${assignments.length ? assignments.map((item) => `<div class="fc-errand-row">
        <span>${this._escape(item.name)} · ★ ${item.stars} · ${this._escape(item.schedule.kind)}</span>
        <button type="button" data-id="${this._escapeAttr(item.id)}">Edit</button>
      </div>`).join("") : "<p>No active errands.</p>"}
    `);
    body.querySelectorAll("[data-id]").forEach((button) => button.addEventListener("click", () =>
      this._showErrandForm(assignments.find((item) => item.id === button.dataset.id))
    ));
  }

  _showErrandLibrary() {
    const templates = this._errandsState.templates;
    const body = this._errandModal("Errand library", `
      <p>Save reusable ideas here; assigning one does not remove it from the library.</p>
      <div class="fc-errand-grid">${templates.map((item) => `<article class="fc-errand-tile">
        <strong>${this._escape(item.name)}</strong><span>★ ${item.stars}</span>
        <div class="fc-errand-actions">
          <button type="button" data-action="use" data-id="${this._escapeAttr(item.id)}">Assign</button>
          <button type="button" data-action="edit" data-id="${this._escapeAttr(item.id)}">Edit</button>
          <button type="button" data-action="delete" data-id="${this._escapeAttr(item.id)}">Delete</button>
        </div></article>`).join("")}</div>
      <button type="button" id="fc-template-add">Add library item</button>
    `);
    body.querySelector("#fc-template-add").addEventListener("click", () => this._showTemplateForm());
    body.querySelectorAll("[data-action]").forEach((button) => button.addEventListener("click", async () => {
      const item = templates.find((template) => template.id === button.dataset.id);
      if (button.dataset.action === "use") this._showErrandForm(null, item);
      else if (button.dataset.action === "edit") this._showTemplateForm(item);
      else if (window.confirm(`Delete "${item.name}" from the library?`) &&
        await this._applyErrand("delete_template", { id: item.id })) this._showErrandLibrary();
    }));
  }

  _showTemplateForm(template = null) {
    const body = this._errandModal(template ? "Edit library item" : "Add library item", `
      <form class="fc-errand-form">
        <label>Name <input name="name" required maxlength="200" value="${this._escapeAttr(template?.name || "")}"></label>
        <label>Stars <input name="stars" type="number" min="1" max="1000000" required value="${template?.stars || 1}"></label>
        <button type="submit">Save to library</button>
      </form>
    `);
    const form = body.querySelector("form");
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const args = { name: form.querySelector('[name="name"]').value, stars: Number(form.querySelector('[name="stars"]').value) };
      if (template) args.id = template.id;
      if (await this._applyErrand("save_template", args)) this._showErrandLibrary();
    });
  }

  _showErrandDeduction(person) {
    const body = this._errandModal("Use stars", `
      <p>Stars can be deducted even when this makes the balance negative.</p>
      <form class="fc-errand-form">
        <label>Stars <input name="stars" type="number" min="1" max="1000000" required value="1"></label>
        <label>Reason <input name="reason" required maxlength="200"></label>
        <button type="submit">Deduct stars</button>
      </form>
    `);
    const form = body.querySelector("form");
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (await this._applyErrand("deduct", {
        person_id: person.id,
        stars: Number(form.querySelector('[name="stars"]').value),
        reason: form.querySelector('[name="reason"]').value,
      })) this._closeModal();
    });
  }

  _showErrandHistory(person) {
    const state = this._errandsState;
    const transactions = state.transactions.filter((item) => item.person_id === person.id).slice().reverse();
    const completed = state.occurrences.filter((item) => item.person_id === person.id && item.status === "completed");
    const body = this._errandModal("History and corrections", `
      <h4>Completed errands</h4>
      ${completed.length ? completed.map((item) => `<div class="fc-errand-row">
        <span>${this._escape(item.name)} · ★ ${item.stars}${item.day ? ` · ${this._escape(item.day)}` : ""}</span>
        <button type="button" data-command="undo_completion" data-id="${this._escapeAttr(item.id)}">Undo completion</button>
      </div>`).join("") : "<p>No completed errands.</p>"}
      <h4>Star history</h4>
      ${transactions.length ? transactions.map((item) => `<div class="fc-errand-row">
        <span>${item.amount > 0 ? "+" : ""}${item.amount} ★ · ${this._escape(item.reason)} · ${this._escape(item.created_at)}</span>
        ${item.kind === "deduction" && !state.transactions.some((other) =>
          other.kind === "deduction_reversal" && other.reference === item.id
        ) ? `<button type="button" data-command="undo_deduction" data-id="${this._escapeAttr(item.id)}">Undo deduction</button>` : ""}
      </div>`).join("") : "<p>No star transactions.</p>"}
    `);
    body.querySelectorAll("[data-command]").forEach((button) => button.addEventListener("click", async () => {
      if (await this._applyErrand(button.dataset.command, { id: button.dataset.id })) this._showErrandHistory(person);
    }));
  }

  _renderToggles() {
    const toggleEl = this._root.querySelector("#fc-toggles");
    const calendars = this._getCalendarList();
    let html = "";
    let i = 0;
    while (i < calendars.length) {
      const cal = calendars[i];
      const isHidden = this._hiddenList.includes(cal.entity);
      const person = this._errandsState?.people.find((item) => item.enabled !== false && item.calendar_entity === cal.entity);
      const balance = person
        ? this._errandsState.transactions.filter((item) => item.person_id === person.id).reduce((sum, item) => sum + item.amount, 0)
        : null;
      html += `
        <button class="fc-toggle ${!this._errandsView && isHidden ? "fc-toggle--off" : ""} ${this._errandsView && person?.id === this._errandsPerson ? "fc-toggle--selected" : ""} ${this._config.button_size === "large" ? "fc-toggle--large" : ""}" data-entity="${this._escapeAttr(cal.entity)}" style="--fc-toggle-color:${this._escapeAttr(cal.color)}">
          <span class="fc-toggle-dot"></span>${this._escape(cal.person)}${balance === null ? "" : ` <span aria-label="${balance} stars">★ ${balance}</span>`}
        </button>
      `;
      i += 1;
    }
    toggleEl.innerHTML = html;
    const btns = toggleEl.querySelectorAll(".fc-toggle");
    btns.forEach((btn) => {
      btn.addEventListener("click", () => {
        if (this._errandsView) {
          const person = this._errandsState?.people.find((item) => item.enabled !== false && item.calendar_entity === btn.dataset.entity);
          if (person) {
            this._errandsPerson = person.id;
            this._renderErrands();
            this._renderToggles();
          }
        } else this._toggleCalendar(btn.dataset.entity);
      });
    });
    const addButton = this._root.querySelector("#fc-add-btn");
    addButton.disabled = !this._calendarList.some((calendar) => this._calendarFeatures(calendar.entity_id) & 1);
  }

  _toggleCalendar(entityId) {
    this._hiddenList = this._hiddenList.includes(entityId)
      ? this._hiddenList.filter((id) => id !== entityId)
      : [...this._hiddenList, entityId];
    this._savePreferences();
    this._renderToggles();
    this._render();
  }

  _visibleEvents(events) {
    return events.filter((ev) => !this._hiddenList.includes(ev.calendar_entity));
  }

  _dateToISO(d) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  _isValidDate(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00`);
    return !Number.isNaN(date.getTime()) && this._dateToISO(date) === value;
  }

  _setView(payload) {
    if (payload.mode && !this._fixedDays && !this._yamlLocks.has("view")) {
      this._viewMode = this._normalizeView(payload.mode);
      this._anchorDate = this._defaultAnchor(this._viewMode, this._dateToISO(new Date()));
    }
    if (payload.start_date) {
      const date = new Date(`${payload.start_date}T00:00:00`);
      if (!Number.isNaN(date.getTime())) {
        this._anchorDate = this._defaultAnchor(this._viewMode, payload.start_date);
      }
    }
    this._savePreferences();
    this._renderNav();
    this._render();
    void this._ensureSubscriptions();
  }

  _shiftAnchor(direction) {
    const anchor = new Date(this._anchorDate + "T00:00:00");
    const newDate = new Date(anchor);
    if (this._viewMode === "day") {
      newDate.setDate(anchor.getDate() + direction);
    } else if (this._viewMode === "three_day") {
      newDate.setDate(anchor.getDate() + direction * 3);
    } else if (this._fixedDays) {
      newDate.setDate(anchor.getDate() + direction * this._fixedDays);
    } else if (this._viewMode === "month") {
      newDate.setDate(1); // avoid month-length edge cases (e.g. Jan 31 -> Feb 31)
      newDate.setMonth(anchor.getMonth() + direction);
    } else {
      newDate.setDate(anchor.getDate() + direction * 7);
    }
    this._setView({ start_date: this._dateToISO(newDate) });
  }

  _renderNav() {
    const navEl = this._root.querySelector("#fc-nav-row");
    const isMonth = this._viewMode === "month";
    const modes = [
      ["day", "Day"],
      ["three_day", "3 days"],
      ["week", "Week"],
      ["month", "Month"],
    ];
    let optionsHtml = "";
    let m = 0;
    while (m < modes.length) {
      const sel = modes[m][0] === this._viewMode ? "selected" : "";
      optionsHtml += `<option value="${modes[m][0]}" ${sel}>${modes[m][1]}</option>`;
      m += 1;
    }

    const fixedView = this._fixedDays || this._yamlLocks.has("view");
    const modeControlHtml = fixedView
      ? `<span class="fc-nav-mode-label">${this._fixedDays ? `${this._fixedDays} days` : modes.find((mode) => mode[0] === this._viewMode)[1]}</span>`
      : `<select class="fc-nav-select" id="fc-nav-mode">${optionsHtml}</select>`;

    navEl.innerHTML = `
      <button class="fc-nav-btn" id="fc-nav-prev" title="Previous"><ha-icon icon="mdi:chevron-left"></ha-icon></button>
      <button class="fc-nav-btn fc-nav-today" id="fc-nav-today" title="Go to today">Today</button>
      <input type="date" class="fc-nav-date" id="fc-nav-date" value="${this._anchorDate}">
      <button class="fc-nav-btn" id="fc-nav-next" title="Next"><ha-icon icon="mdi:chevron-right"></ha-icon></button>
      ${modeControlHtml}
      ${
        isMonth || this._yamlLocks.has("layout")
          ? ""
          : `<button class="fc-nav-btn fc-nav-layout-btn" id="fc-nav-layout" title="Toggle layout">
              <ha-icon icon="${this._layout === "spaced" ? "mdi:view-day" : "mdi:view-agenda"}"></ha-icon>
            </button>`
      }
      ${
        isMonth || this._yamlLocks.has("event_style")
          ? ""
          : `<button class="fc-nav-btn" id="fc-nav-style" title="Event style: ${this._eventStyle === "filled" ? "filled" : "colored bar"}">
              <ha-icon icon="${this._eventStyle === "filled" ? "mdi:square-rounded" : "mdi:square-rounded-outline"}"></ha-icon>
            </button>`
      }
      ${
        isMonth || this._layout !== "spaced" || this._yamlLocks.has("multi_day")
          ? ""
          : `<button class="fc-nav-btn" id="fc-nav-multiday" title="${
              this._multiDay === "banners" ? "Multi-day events: banners" : "Multi-day events: per day"
            }">
              <ha-icon icon="${this._multiDay === "banners" ? "mdi:arrow-expand-horizontal" : "mdi:view-column"}"></ha-icon>
            </button>`
      }
    `;

    navEl.querySelector("#fc-nav-prev").addEventListener("click", () => this._shiftAnchor(-1));
    navEl.querySelector("#fc-nav-today").addEventListener("click", () => {
      const today = this._dateToISO(new Date());
      this._setView({ start_date: this._fixedDays ? today : this._defaultAnchor(this._viewMode, today) });
    });
    navEl.querySelector("#fc-nav-next").addEventListener("click", () => this._shiftAnchor(1));
    navEl.querySelector("#fc-nav-date").addEventListener("change", (e) => this._setView({ start_date: e.target.value }));
    const modeSelect = navEl.querySelector("#fc-nav-mode");
    if (modeSelect) {
      modeSelect.addEventListener("change", (e) => this._setView({ mode: e.target.value }));
    }

    const styleBtn = navEl.querySelector("#fc-nav-style");
    if (styleBtn) {
      styleBtn.addEventListener("click", () => {
        this._eventStyle = this._eventStyle === "filled" ? "bar" : "filled";
        this._savePreferences();
        this._render();
        this._renderNav();
      });
    }

    const multiDayBtn = navEl.querySelector("#fc-nav-multiday");
    if (multiDayBtn) {
      multiDayBtn.addEventListener("click", () => {
        this._multiDay = this._multiDay === "banners" ? "segments" : "banners";
        this._savePreferences();
        this._render();
        this._renderNav();
      });
    }

    const layoutBtn = navEl.querySelector("#fc-nav-layout");
    if (layoutBtn) {
      layoutBtn.addEventListener("click", () => {
        this._layout = this._layout === "spaced" ? "condensed" : "spaced";
        this._savePreferences();
        this._render();
        this._renderNav();
      });
    }
  }

  _render() {
    const errorEl = this._root.querySelector("#fc-error");
    if (errorEl) {
      errorEl.textContent = this._subscriptionError;
      errorEl.hidden = this._errandsView || !this._subscriptionError;
    }
    if (this._viewMode === "month" && !this._fixedDays) {
      this._renderMonth();
    } else if (this._layout === "spaced") {
      this._renderSpaced();
    } else {
      this._renderCondensed();
    }
  }

  /**
   * Pulls events matching a configured day_markers keyword out of the
   * given list (case-insensitive substring match against summary),
   * returning { markers, remaining }. markers is [{icon, color}], deduped
   * and capped at 2 for display. Matched events are excluded from
   * `remaining` since the marker icon replaces the need to show them.
   */
  _extractDayMarkers(events) {
    if (this._dayMarkers.length === 0) {
      return { markers: [], remaining: events };
    }
    const markers = [];
    const remaining = [];
    let i = 0;
    while (i < events.length) {
      const ev = events[i];
      const summaryLower = (ev.summary || "").toLowerCase();
      let matched = null;
      let m = 0;
      while (m < this._dayMarkers.length) {
        const marker = this._dayMarkers[m];
        if (marker.keyword && summaryLower.includes(marker.keyword.toLowerCase())) {
          matched = marker;
          break;
        }
        m += 1;
      }
      if (matched) {
        const alreadyHave = markers.some((mk) => mk.icon === matched.icon && mk.color === matched.color);
        if (!alreadyHave) {
          markers.push({ icon: matched.icon, color: matched.color || "" });
        }
      } else {
        remaining.push(ev);
      }
      i += 1;
    }
    // Display cap stays at 2 (readability in a small header), independent
    // of how many keyword->icon combinations are configured overall.
    return { markers: markers.slice(0, 2), remaining };
  }

  _readableMarkerColor(color) {
    const luminance = (value) => {
      const match = /^#([0-9a-f]{6})$/i.exec(String(value));
      if (!match) return null;
      const [r, g, b] = [0, 2, 4].map((i) => parseInt(match[1].slice(i, i + 2), 16));
      return 0.299 * r + 0.587 * g + 0.114 * b;
    };
    const iconLuminance = luminance(color);
    if (iconLuminance === null) return "";
    const dark = this._theme === "dark" || (this._theme === "system" && Boolean(this._hass.themes?.darkMode));
    const paperLuminance = luminance(this._settings[`${dark ? "dark" : "light"}_day_color`]);
    if (paperLuminance !== null && Math.abs(iconLuminance - paperLuminance) < 60) return "";
    return color;
  }

  _dayMarkersHtml(markers) {
    if (markers.length === 0) return "";
    let html = '<span class="fc-day-markers">';
    let i = 0;
    while (i < markers.length) {
      const mk = markers[i];
      const color = this._readableMarkerColor(mk.color);
      const style = color ? ` style="color:${color}"` : "";
      html += `<ha-icon icon="${mk.icon}" class="fc-day-marker-icon"${style}></ha-icon>`;
      i += 1;
    }
    html += "</span>";
    return html;
  }

  _renderCondensed() {
    const days = this._days;
    const todayStr = this._dateToISO(new Date());
    const weekEl = this._root.querySelector("#fc-week");

    let html = "";
    let i = 0;
    while (i < days.length) {
      const day = days[i];
      const dateObj = new Date(day.date + "T00:00:00");
      const isToday = day.date === todayStr;
      const weekday = dateObj.toLocaleDateString([], { weekday: "short" });
      const dayNum = dateObj.getDate();

      let eventsHtml = "";
      const visible = this._visibleEvents(day.events);
      const { markers, remaining } = this._extractDayMarkers(visible);
      let j = 0;
      while (j < remaining.length) {
        const ev = remaining[j];
        const idx = day.events.indexOf(ev);
        const timeLabel = ev.all_day ? "All day" : this._formatTime(ev.start, false);
        eventsHtml += `
          <div class="fc-event ${this._eventStyle === "filled" ? "fc-ev-filled" : ""}" style="${this._eventStyleAttr(ev)}" data-day="${i}" data-idx="${idx}">
            <ha-icon icon="${ev.icon}" class="fc-event-icon"></ha-icon>
            <div class="fc-event-text">
              <div class="fc-event-title">${this._escape(ev.summary)}</div>
              <div class="fc-event-time">${timeLabel}</div>
            </div>
          </div>
        `;
        j += 1;
      }

      html += `
        <div class="fc-day ${isToday ? "fc-today" : ""}">
          <div class="fc-day-header">
            <span class="fc-day-header-left">
              <span class="fc-weekday">${weekday}</span>
              ${this._dayMarkersHtml(markers)}
            </span>
            <span class="fc-daynum">${dayNum}</span>
          </div>
          <div class="fc-day-events">${eventsHtml || '<div class="fc-empty">Nothing scheduled</div>'}</div>
        </div>
      `;
      i += 1;
    }
    weekEl.innerHTML = html;
    weekEl.classList.remove("fc-week--spaced");
    weekEl.classList.remove("fc-week--month");

    const eventEls = weekEl.querySelectorAll(".fc-event");
    eventEls.forEach((el) => {
      el.addEventListener("click", () => {
        const dayIdx = parseInt(el.dataset.day, 10);
        const evIdx = parseInt(el.dataset.idx, 10);
        this._openModal(days[dayIdx].events[evIdx]);
      });
    });
  }

  _renderSpaced() {
    const days = this._days;
    const todayStr = this._dateToISO(new Date());
    const weekEl = this._root.querySelector("#fc-week");
    const startHour = this._startHour;
    const endHour = this._endHour;
    const hourHeight = this._hourHeight;
    const totalHeight = (endHour - startHour) * hourHeight;

    // All-day rows must be the SAME height on every day (and match the
    // gutter spacer), or the timeline below shifts per-column whenever a
    // day has more/fewer all-day events than its neighbours.
    const HEADER_HEIGHT = 40; // px, day-header block (weekday + date)
    const CHIP_ROW_HEIGHT = 22; // px, per all-day chip including gap
    const bannerMode = this._multiDay === "banners";
    const isBannerEvent = (ev) => bannerMode && this._isMultiDay(ev);
    let maxAllDayCount = 0;
    const banners = [];
    const seen = new Set();
    let d = 0;
    while (d < days.length) {
      const { remaining } = this._extractDayMarkers(this._visibleEvents(days[d].events));
      const count = remaining.filter((ev) => ev.all_day && !isBannerEvent(ev)).length;
      if (count > maxAllDayCount) maxAllDayCount = count;
      remaining.filter(isBannerEvent).forEach((ev) => {
        if (seen.has(ev)) return;
        seen.add(ev);
        banners.push({ ev, first: d, last: d });
      });
      banners.forEach((b) => {
        if (days[d].events.includes(b.ev)) b.last = d;
      });
      d += 1;
    }
    banners.sort((a, b) => a.first - b.first || b.last - b.first - (a.last - a.first));
    const laneEnds = [];
    banners.forEach((b) => {
      let lane = laneEnds.findIndex((end) => end < b.first);
      if (lane === -1) lane = laneEnds.length;
      laneEnds[lane] = b.last;
      b.lane = lane;
    });
    const bannerLanes = laneEnds.length;
    const bannerHeight = bannerLanes * CHIP_ROW_HEIGHT;
    const chipsHeight = maxAllDayCount * CHIP_ROW_HEIGHT;
    const alldayRowHeight = bannerHeight + chipsHeight > 0 ? bannerHeight + chipsHeight : 6;
    const spacerHeight = HEADER_HEIGHT + alldayRowHeight;

    // Shared hour gutter down the left side.
    let gutterHtml = `<div class="fc-hour-gutter-spacer" style="height:${spacerHeight}px"></div><div class="fc-hour-labels" style="height:${totalHeight}px">`;
    let h = startHour;
    while (h <= endHour) {
      const top = (h - startHour) * hourHeight;
      const label = new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: "numeric" });
      gutterHtml += `<div class="fc-hour-label" style="top:${top}px">${label}</div>`;
      h += 1;
    }
    gutterHtml += `</div>`;

    let html = `<div class="fc-hour-gutter">${gutterHtml}</div>`;
    let i = 0;
    while (i < days.length) {
      const day = days[i];
      const dateObj = new Date(day.date + "T00:00:00");
      const isToday = day.date === todayStr;
      const weekday = dateObj.toLocaleDateString([], { weekday: "short" });
      const dayNum = dateObj.getDate();

      const dayVisibleRaw = this._visibleEvents(day.events);
      const { markers, remaining: dayVisible } = this._extractDayMarkers(dayVisibleRaw);
      const allDayEvents = dayVisible.filter((ev) => ev.all_day && !isBannerEvent(ev));
      const allTimedEvents = dayVisible.filter((ev) => !ev.all_day && !isBannerEvent(ev));
      // Events fully outside the visible window get pulled out of the
      // timeline entirely (rendering them clamped at the edge caused
      // them to collide/hide each other) and surfaced as a single
      // "+N more" chip that opens a list popup instead.
      const timedEvents = allTimedEvents.filter((ev) => {
        const s = this._hoursSinceMidnight(ev.start, day.date);
        const e = this._hoursSinceMidnight(ev.end, day.date);
        return e > startHour && s < endHour;
      });
      const outsideEvents = allTimedEvents.filter((ev) => !timedEvents.includes(ev));
      const layout = this._layoutOverlaps(timedEvents, day.date);

      let allDayHtml = "";
      let j = 0;
      while (j < allDayEvents.length) {
        const ev = allDayEvents[j];
        const idx = day.events.indexOf(ev);
        allDayHtml += `
          <div class="fc-allday-chip" style="background:${ev.color}; color:${ev.text_color}" data-day="${i}" data-idx="${idx}">
            <ha-icon icon="${ev.icon}" class="fc-event-icon"></ha-icon>
            <span>${this._escape(ev.summary)}</span>
          </div>
        `;
        j += 1;
      }

      let timelineHtml = "";
      j = 0;
      while (j < timedEvents.length) {
        const ev = timedEvents[j];
        const pos = layout[j];
        const idx = day.events.indexOf(ev);
        const top = (pos.start - startHour) * hourHeight + 1;
        const height = Math.max((pos.end - pos.start) * hourHeight - 2, 16);
        const widthPct = 100 / pos.colCount;
        const leftPct = pos.colIndex * widthPct;
        const startsToday = this._dateToISO(new Date(ev.start)) === day.date;
        const startLabel = startsToday ? this._formatTime(ev.start, false) : "\u2190 continues";
        // When clipped at the bottom, the visible box ends at the window
        // edge, not the event's real end time - show both so the true
        // duration isn't hidden.
        const endsToday = this._dateToISO(new Date(ev.end)) === day.date || new Date(ev.end).getHours() + new Date(ev.end).getMinutes() === 0;
        const timeLabel = pos.clippedBottom || !endsToday
          ? `${startLabel} \u2013 ${endsToday ? this._formatTime(ev.end, false) : "\u2192"}`
          : startLabel;
        const clipClasses = [
          pos.clippedTop ? "fc-tl-event--clip-top" : "",
          pos.clippedBottom ? "fc-tl-event--clip-bottom" : "",
        ]
          .filter(Boolean)
          .join(" ");
        timelineHtml += `
          <div class="fc-tl-event ${clipClasses} ${this._eventStyle === "filled" ? "fc-ev-filled" : ""}" data-day="${i}" data-idx="${idx}" style="
            top:${top}px; height:${height}px;
            left:calc(${leftPct}% + 2px); width:calc(${widthPct}% - 4px);
            ${this._eventStyleAttr(ev)};
          ">
            <div class="fc-tl-event-title">${this._escape(ev.summary)}</div>
            <div class="fc-tl-event-time">${timeLabel}</div>
          </div>
        `;
        j += 1;
      }

      let nowLineHtml = "";
      if (isToday) {
        const now = new Date();
        const nowHours = now.getHours() + now.getMinutes() / 60;
        if (nowHours >= startHour && nowHours <= endHour) {
          const top = (nowHours - startHour) * hourHeight;
          nowLineHtml = `<div class="fc-now-line" style="top:${top}px"></div>`;
        }
      }

      let overflowHtml = "";
      if (outsideEvents.length > 0) {
        overflowHtml = `<div class="fc-overflow-chip" data-day="${i}">+${outsideEvents.length} more</div>`;
      }

      html += `
        <div class="fc-day fc-day--spaced ${isToday ? "fc-today" : ""}" style="grid-column:${i + 2}; grid-row:1">
          <div class="fc-day-header">
            <span class="fc-day-header-left">
              <span class="fc-weekday">${weekday}</span>
              ${this._dayMarkersHtml(markers)}
            </span>
            <span class="fc-daynum">${dayNum}</span>
          </div>
          <div class="fc-allday-row" style="height:${alldayRowHeight}px; padding-top:${bannerHeight}px">${allDayHtml}</div>
          <div class="fc-timeline" style="height:${totalHeight}px; background-size: 100% ${hourHeight}px;">
            ${timelineHtml}
            ${nowLineHtml}
          </div>
          ${overflowHtml}
        </div>
      `;
      i += 1;
    }
    banners.forEach((b) => {
      const startsBefore = (this._eventDate(b.ev.start, b.ev.all_day) || 0) < new Date(`${days[0].date}T00:00:00`);
      const rangeEnd = new Date(`${days[days.length - 1].date}T00:00:00`);
      rangeEnd.setDate(rangeEnd.getDate() + 1);
      const endsAfter = (this._eventDate(b.ev.end, b.ev.all_day) || 0) > rangeEnd;
      const idx = days[b.first].events.indexOf(b.ev);
      html += `
        <div class="fc-banner ${startsBefore ? "fc-banner--cont-start" : ""} ${endsAfter ? "fc-banner--cont-end" : ""}"
          data-day="${b.first}" data-idx="${idx}" style="
          grid-column:${b.first + 2} / span ${b.last - b.first + 1}; grid-row:1;
          margin-top:${HEADER_HEIGHT + b.lane * CHIP_ROW_HEIGHT}px; background:${b.ev.color}; color:${b.ev.text_color};
        ">
          <ha-icon icon="${b.ev.icon}" class="fc-event-icon"></ha-icon>
          <span>${this._escape(b.ev.summary)}</span>
        </div>
      `;
    });
    weekEl.innerHTML = html;
    weekEl.classList.remove("fc-week--month");
    weekEl.classList.add("fc-week--spaced");

    const clickEls = weekEl.querySelectorAll(".fc-tl-event, .fc-allday-chip, .fc-banner");
    clickEls.forEach((el) => {
      el.addEventListener("click", () => {
        const dayIdx = parseInt(el.dataset.day, 10);
        const evIdx = parseInt(el.dataset.idx, 10);
        this._openModal(days[dayIdx].events[evIdx]);
      });
    });

    weekEl.querySelectorAll(".fc-timeline").forEach((el, dayIdx) => {
      el.addEventListener("click", (e) => {
        if (e.target !== el) return;
        const hours = startHour + e.offsetY / hourHeight;
        const start = new Date(`${days[dayIdx].date}T00:00:00`);
        start.setMinutes(Math.floor(hours * 2) * 30);
        this._showEventForm(null, start);
      });
    });

    const overflowEls = weekEl.querySelectorAll(".fc-overflow-chip");
    overflowEls.forEach((el) => {
      el.addEventListener("click", () => {
        const dayIdx = parseInt(el.dataset.day, 10);
        const dayVisibleRaw = this._visibleEvents(days[dayIdx].events);
        const { remaining } = this._extractDayMarkers(dayVisibleRaw);
        const allTimed = remaining.filter((ev) => !ev.all_day && !(this._multiDay === "banners" && this._isMultiDay(ev)));
        const outside = allTimed.filter((ev) => {
          const s = this._hoursSinceMidnight(ev.start, days[dayIdx].date);
          const e = this._hoursSinceMidnight(ev.end, days[dayIdx].date);
          return !(e > startHour && s < endHour);
        });
        this._openListModal(outside);
      });
    });
  }

  _renderMonth() {
    const days = this._days;
    const todayStr = this._dateToISO(new Date());
    const weekEl = this._root.querySelector("#fc-week");
    weekEl.classList.remove("fc-week--spaced");
    weekEl.classList.add("fc-week--month");

    const WEEKDAY_LABELS = this._config.first_day === "sunday"
      ? ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
      : ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    let html = "";
    let w = 0;
    while (w < WEEKDAY_LABELS.length) {
      html += `<div class="fc-month-weekday-label">${WEEKDAY_LABELS[w]}</div>`;
      w += 1;
    }

    let i = 0;
    while (i < days.length) {
      const day = days[i];
      const dateObj = new Date(day.date + "T00:00:00");
      const isToday = day.date === todayStr;
      const dayNum = dateObj.getDate();
      const visible = this._visibleEvents(day.events);
      const maxShown = 3;
      const shown = visible.slice(0, maxShown);
      const extra = visible.length - shown.length;

      let chipsHtml = "";
      let j = 0;
      while (j < shown.length) {
        const ev = shown[j];
        chipsHtml += `
          <div class="fc-month-chip">
            <span class="fc-month-chip-dot" style="background:${ev.color}"></span>
            <span class="fc-month-chip-title">${this._escape(ev.summary)}</span>
          </div>
        `;
        j += 1;
      }
      if (extra > 0) {
        chipsHtml += `<div class="fc-month-chip fc-month-chip--more">+${extra} more</div>`;
      }

      html += `
        <div class="fc-month-cell ${isToday ? "fc-today" : ""} ${day.in_month ? "" : "fc-month-cell--out"}" data-day="${i}">
          <div class="fc-month-daynum">${dayNum}</div>
          <div class="fc-month-chips">${chipsHtml}</div>
        </div>
      `;
      i += 1;
    }
    weekEl.innerHTML = html;

    const cells = weekEl.querySelectorAll(".fc-month-cell");
    cells.forEach((cell) => {
      cell.addEventListener("click", () => {
        const dayIdx = parseInt(cell.dataset.day, 10);
        const dayEvents = this._visibleEvents(days[dayIdx].events);
        if (dayEvents.length === 0) return;
        this._openListModal(dayEvents);
      });
    });
  }

  getCardSize() {
    return 6;
  }

  getGridOptions() {
    return { columns: "full", min_columns: 6 };
  }
}

FamilyCalendarCard.styles = `
  *, *::before, *::after {
    box-sizing: border-box;
  }
  :host {
    /* --fc-paper / --fc-paper-today are meant to be set explicitly in
       theme.yaml (calendar-day-default-background-color /
       calendar-today-default-background-color), same pattern as the
       existing calendar-<person>-default-background-color vars.
       Fallbacks below only apply if the theme doesn't define them. */
    --fc-paper: var(--calendar-day-default-background-color, var(--secondary-background-color, rgba(127, 127, 127, 0.08)));
    --fc-paper-today: var(--calendar-today-default-background-color, var(--primary-color, rgba(127, 127, 127, 0.2)));
    --fc-ink: var(--primary-text-color, #212121);
    --fc-ink-soft: var(--secondary-text-color, #727272);
    --fc-hairline: var(--divider-color, rgba(127, 127, 127, 0.4));
    --fc-stamp: var(--primary-color, #212121);
  }
  ha-card {
    background: var(--card-background-color, #fff);
    padding: 12px;
    overflow-x: auto;
  }
  [hidden] { display: none !important; }
  .fc-mode-btn, .fc-errands button, .fc-errand-form button, #fc-errand-recovery button,
  .fc-errand-row button, .fc-errand-tile button, #fc-template-add {
    min-height: 44px;
    padding: 8px 14px;
    border: 1px solid var(--fc-hairline);
    border-radius: 8px;
    background: var(--fc-paper);
    color: var(--fc-ink);
    cursor: pointer;
    font: inherit;
  }
  .fc-errands button:disabled { opacity: 0.5; cursor: not-allowed; }
  .fc-errand-toolbar, .fc-errand-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  .fc-errand-toolbar strong { flex: 1; min-width: 150px; }
  .fc-errand-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 210px), 1fr));
    gap: 10px;
    margin: 12px 0;
  }
  .fc-errand-tile {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 14px;
    border: 1px solid var(--fc-hairline);
    border-radius: 12px;
    background: var(--fc-paper);
  }
  .fc-errand-hint { color: var(--fc-ink-soft); }
  .fc-toggle--selected { outline: 3px solid var(--primary-color, #03a9f4); outline-offset: 2px; }
  .fc-errand-form {
    display: grid;
    gap: 10px;
    padding: 10px 0;
  }
  .fc-errand-form label { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .fc-errand-form input:not([type="checkbox"]), .fc-errand-form select {
    min-height: 44px;
    padding: 8px;
    max-width: 100%;
    background: var(--card-background-color, #fff);
    color: var(--fc-ink);
    border: 1px solid var(--fc-hairline);
    border-radius: 6px;
    font: inherit;
  }
  .fc-errand-form fieldset { display: flex; flex-wrap: wrap; gap: 10px; }
  .fc-errand-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 8px 0;
    border-bottom: 1px solid var(--fc-hairline);
  }
  .fc-modal-body button:not(.fc-modal-delete) { cursor: pointer; }
  .fc-error { padding: 16px; color: var(--error-color, red); }
  .fc-toggles {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 10px;
  }
  .fc-header-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 8px;
  }
  .fc-header-row .fc-toggles {
    flex: 1;
    margin-bottom: 10px;
  }
  .fc-add-btn {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    border: none;
    border-radius: 50%;
    background: var(--fc-paper);
    color: var(--fc-ink);
    cursor: pointer;
  }
  .fc-add-btn:hover {
    background: var(--primary-color, var(--fc-paper));
    color: #fff;
  }
  .fc-add-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  .fc-add-btn ha-icon {
    --mdc-icon-size: 18px;
  }
  .fc-reload-btn {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    border: none;
    border-radius: 50%;
    background: var(--fc-paper);
    color: var(--fc-ink);
    cursor: pointer;
  }
  .fc-reload-btn:hover {
    background: var(--primary-color, var(--fc-paper));
    color: #fff;
  }
  .fc-reload-btn ha-icon {
    --mdc-icon-size: 18px;
  }
  .fc-reload-btn.fc-spin ha-icon {
    animation: fc-spin-anim 0.7s linear;
  }
  @keyframes fc-spin-anim {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }
  .fc-nav-row {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 10px;
    flex-wrap: wrap;
  }
  .fc-nav-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border: none;
    border-radius: 50%;
    background: var(--fc-paper);
    color: var(--fc-ink);
    cursor: pointer;
    flex-shrink: 0;
  }
  .fc-nav-today {
    width: auto;
    padding: 0 12px;
    border-radius: 14px;
    font-size: 0.8em;
    font-weight: 600;
  }
  .fc-nav-btn:hover {
    background: var(--primary-color, var(--fc-paper));
    color: #fff;
  }
  .fc-nav-btn ha-icon {
    --mdc-icon-size: 18px;
  }
  .fc-nav-date,
  .fc-nav-select,
  .fc-nav-mode-label {
    font-family: inherit;
    font-size: 0.82em;
    color: var(--fc-ink);
    background: var(--fc-paper);
    border: none;
    border-radius: 6px;
    padding: 4px 8px;
    height: 28px;
  }
  .fc-nav-mode-label {
    display: flex;
    align-items: center;
    white-space: nowrap;
  }
  .fc-nav-layout-btn {
    margin-left: auto;
  }
  .fc-toggle {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    border: none;
    border-radius: 14px;
    padding: 4px 10px 4px 8px;
    font-size: 0.78em;
    font-weight: 600;
    font-family: inherit;
    color: var(--fc-ink);
    background: var(--fc-paper);
    cursor: pointer;
    transition: opacity 0.15s ease;
  }
  .fc-toggle-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--fc-toggle-color, #999);
    flex-shrink: 0;
  }
  .fc-toggle--large {
    min-height: 44px;
    padding: 8px 16px;
    border-radius: 22px;
    font-size: 1em;
  }
  .fc-toggle--large .fc-toggle-dot {
    width: 14px;
    height: 14px;
  }
  .fc-toggle--off {
    opacity: 0.4;
  }
  .fc-toggle--off .fc-toggle-dot {
    background: transparent;
    box-shadow: inset 0 0 0 2px var(--fc-toggle-color, #999);
  }
  .fc-footer {
    text-align: right;
    font-size: 0.62em;
    color: var(--fc-ink-soft, var(--secondary-text-color, #888));
    opacity: 0.6;
    padding: 4px 6px 0 0;
    user-select: none;
  }
  .fc-week {
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: minmax(150px, 1fr);
    gap: 8px;
  }
  /* ---- Month grid layout ---- */
  .fc-week--month {
    display: grid;
    grid-template-columns: repeat(7, minmax(0, 1fr));
    grid-auto-flow: row;
    gap: 4px;
  }
  .fc-month-weekday-label {
    text-align: center;
    font-size: 0.7em;
    font-weight: 600;
    color: var(--fc-ink-soft);
    padding-bottom: 4px;
  }
  .fc-month-cell {
    background: var(--fc-paper);
    border-radius: 6px;
    padding: 6px;
    min-height: 90px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    cursor: pointer;
  }
  .fc-month-cell.fc-today {
    background: var(--fc-paper-today);
    box-shadow: inset 0 0 0 1px var(--fc-hairline);
  }
  .fc-month-cell--out {
    opacity: 0.45;
  }
  .fc-month-daynum {
    font-size: 0.85em;
    font-weight: 600;
    color: var(--fc-ink);
  }
  .fc-month-chips {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .fc-month-chip {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 0.68em;
    color: var(--fc-ink);
    overflow: hidden;
  }
  .fc-month-chip-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .fc-month-chip-title {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .fc-month-chip--more {
    color: var(--fc-ink-soft);
    font-weight: 600;
  }
  .fc-day {
    background: var(--fc-paper);
    border-radius: 6px;
    padding: 8px 6px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .fc-day.fc-today {
    background: var(--fc-paper-today);
    box-shadow: inset 0 0 0 1px var(--fc-hairline);
  }
  .fc-week--spaced .fc-day-header {
    height: 40px;
    box-sizing: border-box;
  }
  .fc-day-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    padding: 2px 4px 6px 4px;
    border-bottom: 1px solid var(--fc-hairline);
  }
  .fc-day-header-left {
    display: flex;
    align-items: center;
    gap: 5px;
  }
  .fc-day-markers {
    display: inline-flex;
    align-items: center;
    gap: 3px;
  }
  .fc-day-marker-icon {
    --mdc-icon-size: 13px;
    color: var(--fc-ink-soft);
  }
  .fc-weekday {
    font-family: Georgia, 'Times New Roman', serif;
    font-variant: small-caps;
    letter-spacing: 0.08em;
    font-size: 0.8em;
    color: var(--fc-ink-soft);
  }
  .fc-daynum {
    font-weight: 600;
    font-size: 1em;
    color: var(--fc-ink);
    min-width: 22px;
    height: 22px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .fc-today .fc-daynum {
    background: var(--fc-stamp);
    color: #fff;
    border-radius: 50%;
  }
  .fc-day-events {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .fc-empty {
    font-size: 0.8em;
    color: var(--fc-ink-soft);
    padding: 6px 4px;
    font-style: italic;
  }
  .fc-event {
    background: var(--card-background-color, #fff);
    border-left: 5px solid #999;
    border-radius: 4px;
    padding: 5px 6px;
    display: flex;
    align-items: flex-start;
    gap: 6px;
    cursor: pointer;
    transition: transform 0.1s ease, box-shadow 0.1s ease;
  }
  .fc-event:hover {
    transform: translateX(1px);
    box-shadow: 0 1px 4px rgba(0,0,0,0.15);
  }
  .fc-ev-filled .fc-tl-event-title,
  .fc-ev-filled .fc-tl-event-time,
  .fc-ev-filled .fc-event-title,
  .fc-ev-filled .fc-event-time,
  .fc-ev-filled .fc-event-icon {
    color: var(--fc-ev-text);
  }
  .fc-event-icon {
    --mdc-icon-size: 15px;
    color: var(--fc-ink-soft);
    margin-top: 1px;
    flex-shrink: 0;
  }
  .fc-event-title {
    font-size: 0.85em;
    font-weight: 600;
    color: var(--fc-ink);
    line-height: 1.25;
  }
  .fc-event-time {
    font-size: 0.72em;
    color: var(--fc-ink-soft);
  }

  .fc-modal {
    position: fixed;
    inset: 0;
    z-index: 1000;
    display: none;
    align-items: center;
    justify-content: center;
  }
  .fc-modal:not([hidden]) {
    display: flex;
  }
  .fc-modal-backdrop {
    position: absolute;
    inset: 0;
    background: rgba(0,0,0,0.45);
  }
  .fc-modal-panel {
    position: relative;
    background: var(--card-background-color, #fff);
    border-radius: 10px;
    padding: 20px;
    width: min(420px, 88vw);
    max-height: 90vh;
    overflow-y: auto;
    box-shadow: 0 8px 30px rgba(0,0,0,0.3);
  }
  .fc-modal-close {
    position: absolute;
    top: 8px;
    right: 10px;
    background: none;
    border: none;
    font-size: 1.4em;
    color: var(--fc-ink-soft);
    cursor: pointer;
    line-height: 1;
  }
  .fc-modal-tag {
    display: inline-block;
    font-size: 0.7em;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: #000;
    padding: 3px 8px;
    border-radius: 4px;
    margin-bottom: 8px;
  }
  .fc-modal-title {
    margin: 0 0 10px 0;
    font-size: 1.15em;
    color: var(--fc-ink);
  }
  .fc-modal-row {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.9em;
    color: var(--fc-ink-soft);
    margin-bottom: 6px;
  }
  .fc-modal-row ha-icon {
    --mdc-icon-size: 16px;
  }
  .fc-modal-desc {
    margin-top: 10px;
    font-size: 0.88em;
    color: var(--fc-ink);
    white-space: pre-wrap;
  }
  .fc-modal-note,
  .fc-form-error {
    margin-top: 10px;
    color: var(--error-color, #c62828);
    font-size: 0.85em;
  }
  .fc-modal-note {
    color: var(--fc-ink-soft);
  }
  .fc-form-error[hidden] {
    display: none;
  }
  .fc-modal-actions {
    display: flex;
    gap: 8px;
    margin-top: 12px;
  }
  .fc-modal-action {
    border: 0;
    border-radius: 6px;
    padding: 8px 12px;
    background: var(--primary-color, #039be5);
    color: var(--text-primary-color, #fff);
    font: inherit;
    cursor: pointer;
  }
  .fc-event-form {
    display: grid;
    gap: 10px;
    max-height: 70vh;
    overflow-y: auto;
    padding-top: 4px;
  }
  .fc-event-form label {
    display: grid;
    gap: 4px;
    color: var(--fc-ink);
    font-size: 0.85em;
  }
  .fc-event-form input,
  .fc-event-form select,
  .fc-event-form textarea {
    width: 100%;
    border: 1px solid var(--fc-hairline);
    border-radius: 4px;
    padding: 7px;
    background: var(--card-background-color, #fff);
    color: var(--fc-ink);
    font: inherit;
  }
  .fc-event-form .fc-event-allday {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .fc-event-form .fc-event-allday input {
    width: auto;
  }
  .fc-event-time-fields {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }
  .fc-event-time-fields[hidden] {
    display: none;
  }
  .fc-event-date-fields {
    display: grid;
    gap: 10px;
  }
  .fc-event-date-fields[hidden] {
    display: none;
  }
  .fc-modal-delete {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    width: 100%;
    margin-top: 16px;
    padding: 8px;
    border: 1px solid var(--error-color, #e53935);
    border-radius: 6px;
    background: none;
    color: var(--error-color, #e53935);
    font-family: inherit;
    font-size: 0.85em;
    font-weight: 600;
    cursor: pointer;
  }
  .fc-modal-delete:hover {
    background: var(--error-color, #e53935);
    color: #fff;
  }
  .fc-modal-delete ha-icon {
    --mdc-icon-size: 16px;
  }

  /* ---- Spaced (timeline) layout ---- */
  .fc-week--spaced {
    display: grid;
    grid-template-columns: 44px repeat(7, minmax(150px, 1fr));
    align-items: start;
  }
  .fc-hour-gutter {
    grid-column: 1;
  }
  .fc-hour-gutter-spacer {
    /* height set inline per-render to match the tallest all-day row */
  }
  .fc-hour-labels {
    position: relative;
  }
  .fc-hour-label {
    position: absolute;
    right: 8px;
    transform: translateY(-50%);
    font-size: 0.68em;
    color: var(--fc-ink-soft);
    white-space: nowrap;
  }
  .fc-day--spaced {
    display: block;
    padding: 0 4px 8px 4px;
  }
  .fc-allday-row {
    display: flex;
    flex-direction: column;
    gap: 0;
    overflow: hidden;
    margin-bottom: 4px;
  }
  .fc-allday-chip {
    flex: none;
    box-sizing: border-box;
    height: 20px;
    margin-bottom: 2px;
    display: flex;
    align-items: center;
    gap: 4px;
    border-radius: 3px;
    padding: 2px 5px;
    font-size: 0.72em;
    font-weight: 600;
    color: #000;
    cursor: pointer;
  }
  .fc-allday-row {
    box-sizing: border-box;
  }
  .fc-banner {
    position: relative;
    z-index: 2;
    align-self: start;
    display: flex;
    align-items: center;
    gap: 4px;
    height: 19px;
    margin: 0 4px;
    box-sizing: border-box;
    border-radius: 3px;
    padding: 0 6px;
    font-size: 0.72em;
    font-weight: 600;
    color: #000;
    white-space: nowrap;
    overflow: hidden;
    cursor: pointer;
  }
  .fc-banner--cont-start {
    margin-left: 0;
    border-top-left-radius: 0;
    border-bottom-left-radius: 0;
  }
  .fc-banner--cont-end {
    margin-right: 0;
    border-top-right-radius: 0;
    border-bottom-right-radius: 0;
  }
  .fc-banner .fc-event-icon {
    --mdc-icon-size: 12px;
    color: inherit;
  }
  .fc-allday-chip .fc-event-icon {
    --mdc-icon-size: 12px;
    color: inherit;
  }
  .fc-timeline {
    position: relative;
    border-radius: 4px;
    background-image: repeating-linear-gradient(
      to bottom,
      var(--fc-hairline) 0,
      var(--fc-hairline) 1px,
      transparent 1px,
      transparent 100%
    );
    background-repeat: repeat-y;
  }
  .fc-tl-event {
    position: absolute;
    overflow: hidden;
    background: var(--card-background-color, #fff);
    border-left: 5px solid #999;
    border-radius: 3px;
    padding: 3px 5px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.15);
    cursor: pointer;
  }
  .fc-tl-event--clip-top::before,
  .fc-tl-event--clip-bottom::after {
    content: "";
    position: absolute;
    left: 0;
    right: 0;
    height: 10px;
    pointer-events: none;
  }
  .fc-tl-event--clip-top::before {
    top: 0;
    background: linear-gradient(to bottom, var(--fc-ink-soft), transparent);
    opacity: 0.35;
  }
  .fc-ev-filled.fc-tl-event--clip-top::before,
  .fc-ev-filled.fc-tl-event--clip-bottom::after {
    height: 16px;
    opacity: 0.55;
  }
  .fc-ev-filled.fc-tl-event--clip-top::before {
    background: linear-gradient(to bottom, var(--fc-ev-text), transparent);
    border-top: 2px solid var(--fc-ev-text);
  }
  .fc-ev-filled.fc-tl-event--clip-bottom::after {
    background: linear-gradient(to top, var(--fc-ev-text), transparent);
    border-bottom: 2px solid var(--fc-ev-text);
  }
  .fc-tl-event--clip-bottom::after {
    bottom: 0;
    background: linear-gradient(to top, var(--fc-ink-soft), transparent);
    opacity: 0.35;
  }
  .fc-tl-event-title {
    font-size: 0.72em;
    font-weight: 600;
    color: var(--fc-ink);
    line-height: 1.2;
  }
  .fc-tl-event-time {
    font-size: 0.64em;
    color: var(--fc-ink-soft);
  }
  .fc-now-line {
    position: absolute;
    left: 0;
    right: 0;
    height: 2px;
    background: var(--error-color, #e53935);
    z-index: 5;
  }
  .fc-now-line::before {
    content: "";
    position: absolute;
    left: -4px;
    top: -3px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--error-color, #e53935);
  }
  .fc-overflow-chip {
    margin-top: 4px;
    text-align: center;
    font-size: 0.68em;
    font-weight: 600;
    color: var(--fc-ink-soft);
    background: var(--fc-paper);
    border-radius: 10px;
    padding: 3px 0;
    cursor: pointer;
  }
  .fc-overflow-chip:hover {
    color: var(--fc-ink);
  }
  .fc-modal-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-height: 50vh;
    overflow-y: auto;
  }
  .fc-modal-list-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 4px;
    border-radius: 4px;
    cursor: pointer;
  }
  .fc-modal-list-row:hover {
    background: var(--fc-paper);
  }
  .fc-modal-list-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .fc-modal-list-title {
    flex: 1;
    font-size: 0.9em;
    font-weight: 600;
    color: var(--fc-ink);
  }
  .fc-modal-list-time {
    font-size: 0.78em;
    color: var(--fc-ink-soft);
  }
`;

class FamilyCalendarCardEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
  }

  setConfig(config) {
    if (JSON.stringify(this._config) === JSON.stringify(config)) return;
    this._config = { ...config };
    this._render();
  }

  _commit(config) {
    this._config = config;
    this.dispatchEvent(new CustomEvent("config-changed", { detail: { config }, bubbles: true, composed: true }));
  }

  _setOption(key, value) {
    const config = { ...this._config };
    if (value === "") {
      delete config[key];
    } else {
      config[key] = value;
    }
    this._commit(config);
  }

  _input(value, placeholder = "") {
    const input = document.createElement("input");
    input.type = "text";
    input.value = value ?? "";
    input.placeholder = placeholder;
    return input;
  }

  _field(container, label, input, description) {
    const wrapper = document.createElement("label");
    const title = document.createElement("span");
    title.textContent = label;
    wrapper.append(title, input);
    if (description) {
      const help = document.createElement("small");
      help.textContent = description;
      wrapper.append(help);
    }
    container.append(wrapper);
  }

  _select(container, label, key, options, description, defaultValue = "") {
    const select = document.createElement("select");
    const current = this._config[key] ?? defaultValue;
    if (current !== "" && !options.some(([value]) => value === current)) {
      options = [...options, [current, String(current)]];
    }
    for (const [value, text] of options) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      select.append(option);
    }
    select.value = current;
    select.addEventListener("change", () => this._setOption(key, select.value));
    this._field(container, label, select, description);
  }

  _textField(container, label, key, description) {
    const input = this._input(this._config[key]);
    input.addEventListener("change", () => this._setOption(key, input.value.trim()));
    this._field(container, label, input, description);
  }

  _numberField(container, label, key, min, description) {
    const input = this._input(this._config[key]);
    input.type = "number";
    input.step = "1";
    if (min !== null) input.min = String(min);
    input.addEventListener("change", () => {
      if (!input.reportValidity()) return;
      this._setOption(key, input.value === "" ? "" : Number(input.value));
    });
    this._field(container, label, input, description);
  }

  _button(text, action) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = text;
    button.addEventListener("click", action);
    return button;
  }

  _section(title, description) {
    const section = document.createElement("section");
    const heading = document.createElement("h3");
    heading.textContent = title;
    section.append(heading);
    if (description) {
      const help = document.createElement("p");
      help.textContent = description;
      section.append(help);
    }
    this.shadowRoot.append(section);
    return section;
  }

  _iconKeywords() {
    const section = this._section("Event icons", "Add keyword-to-icon mappings for this card.");
    const keywords = this._config.icon_keywords;
    if (keywords != null && (typeof keywords !== "object" || Array.isArray(keywords))) {
      section.append("Invalid icon mappings. Correct them in the YAML editor.");
      return;
    }
    for (const [keyword, icon] of Object.entries(keywords || {})) {
      const row = document.createElement("div");
      row.className = "row";
      const word = this._input(keyword, "Keyword");
      const value = this._input(icon, "Icon, e.g. mdi:pool");
      word.setAttribute("aria-label", "Icon keyword");
      value.setAttribute("aria-label", `Icon for ${keyword}`);
      const save = () => {
        const newKey = word.value.trim();
        const newIcon = value.value.trim();
        const duplicate = newKey !== keyword && Object.hasOwn(this._config.icon_keywords || {}, newKey);
        word.setCustomValidity(!newKey ? "Enter a keyword." : duplicate ? "This keyword already exists." : "");
        value.setCustomValidity(newIcon ? "" : "Enter an icon.");
        if (!word.reportValidity() || !value.reportValidity()) return;
        const entries = Object.entries(this._config.icon_keywords || {}).map(([key, oldIcon]) =>
          key === keyword ? [newKey, newIcon] : [key, oldIcon]
        );
        this._commit({ ...this._config, icon_keywords: Object.fromEntries(entries) });
        this._render();
      };
      word.addEventListener("change", save);
      value.addEventListener("change", save);
      row.append(
        word,
        value,
        this._button(`Remove ${keyword}`, () => {
          const icons = { ...this._config.icon_keywords };
          delete icons[keyword];
          this._commit({ ...this._config, icon_keywords: icons });
          this._render();
        })
      );
      section.append(row);
    }
    const row = document.createElement("div");
    row.className = "row";
    const word = this._input("", "Keyword");
    const icon = this._input("", "Icon, e.g. mdi:pool");
    word.setAttribute("aria-label", "New icon keyword");
    icon.setAttribute("aria-label", "New keyword icon");
    row.append(
      word,
      icon,
      this._button("Add icon", () => {
        const key = word.value.trim();
        const value = icon.value.trim();
        word.setCustomValidity(
          !key
            ? "Enter a keyword."
            : Object.hasOwn(this._config.icon_keywords || {}, key)
              ? "This keyword already exists."
              : ""
        );
        icon.setCustomValidity(value ? "" : "Enter an icon.");
        if (!word.reportValidity() || !icon.reportValidity()) return;
        this._commit({ ...this._config, icon_keywords: { ...this._config.icon_keywords, [key]: value } });
        this._render();
      })
    );
    section.append(row);
  }

  _dayMarkers() {
    const section = this._section(
      "Day markers",
      "Custom markers replace the integration defaults. An empty custom list hides all default markers."
    );
    const markers = this._config.day_markers;
    if (
      markers != null &&
      (!Array.isArray(markers) || markers.some((item) => !item || typeof item !== "object" || Array.isArray(item)))
    ) {
      section.append("Invalid day markers. Correct them in the YAML editor.");
      return;
    }
    const enabled = document.createElement("input");
    enabled.type = "checkbox";
    enabled.checked = Array.isArray(markers);
    enabled.addEventListener("change", () => {
      const config = { ...this._config };
      if (enabled.checked) config.day_markers = [];
      else delete config.day_markers;
      this._commit(config);
      this._render();
    });
    this._field(section, "Override integration day markers", enabled);
    if (!enabled.checked) return;
    for (const [index, marker] of markers.entries()) {
      const row = document.createElement("div");
      row.className = "row";
      const word = this._input(marker.keyword, "Keyword");
      const icon = this._input(marker.icon, "Icon");
      const color = this._input(marker.color, "Color (optional)");
      word.setAttribute("aria-label", `Marker ${index + 1} keyword`);
      icon.setAttribute("aria-label", `Marker ${index + 1} icon`);
      color.setAttribute("aria-label", `Marker ${index + 1} color`);
      const save = () => {
        word.setCustomValidity(word.value.trim() ? "" : "Enter a keyword.");
        icon.setCustomValidity(icon.value.trim() ? "" : "Enter an icon.");
        if (!word.reportValidity() || !icon.reportValidity()) return;
        const updated = { ...this._config.day_markers[index], keyword: word.value.trim(), icon: icon.value.trim() };
        if (color.value.trim()) updated.color = color.value.trim();
        else delete updated.color;
        const next = [...this._config.day_markers];
        next[index] = updated;
        this._commit({ ...this._config, day_markers: next });
      };
      for (const input of [word, icon, color]) input.addEventListener("change", save);
      row.append(
        word,
        icon,
        color,
        this._button(`Remove marker ${index + 1}`, () => {
          this._commit({ ...this._config, day_markers: this._config.day_markers.filter((_, i) => i !== index) });
          this._render();
        })
      );
      section.append(row);
    }
    const row = document.createElement("div");
    row.className = "row";
    const word = this._input("", "Keyword");
    const icon = this._input("", "Icon");
    const color = this._input("", "Color (optional)");
    word.setAttribute("aria-label", "New marker keyword");
    icon.setAttribute("aria-label", "New marker icon");
    color.setAttribute("aria-label", "New marker color");
    row.append(
      word,
      icon,
      color,
      this._button("Add marker", () => {
        word.setCustomValidity(word.value.trim() ? "" : "Enter a keyword.");
        icon.setCustomValidity(icon.value.trim() ? "" : "Enter an icon.");
        if (!word.reportValidity() || !icon.reportValidity()) return;
        const marker = { keyword: word.value.trim(), icon: icon.value.trim() };
        if (color.value.trim()) marker.color = color.value.trim();
        this._commit({ ...this._config, day_markers: [...this._config.day_markers, marker] });
        this._render();
      })
    );
    section.append(row);
  }

  _render() {
    if (!this._config) return;
    this.shadowRoot.innerHTML = `<style>
     :host { display: block; color: var(--primary-text-color); font-family: var(--paper-font-body1_-_font-family, sans-serif); }
     section { margin: 0 0 24px; }
     h3 { margin: 16px 0 8px; }
     p, small { color: var(--secondary-text-color); font-size: 0.9em; }
     label { display: flex; flex-direction: column; gap: 5px; margin: 12px 0; }
     input:not([type="checkbox"]), select { box-sizing: border-box; width: 100%; padding: 10px; color: var(--primary-text-color); background: var(--secondary-background-color); border: 1px solid var(--divider-color); border-radius: 4px; font: inherit; }
     input[type="checkbox"] { align-self: flex-start; }
     button { padding: 8px; color: var(--primary-color); background: transparent; border: 1px solid var(--divider-color); border-radius: 4px; cursor: pointer; }
     .row { display: flex; flex-wrap: wrap; gap: 8px; margin: 8px 0; }
     .row input { flex: 1 1 110px; min-width: 0; }
   </style>`;
    const general = this._section(
      "Card settings",
      "Leave optional settings empty to use integration or browser defaults."
    );
    this._textField(
      general,
      "Instance name",
      "instance",
      "Required and unique per card; used for saved browser preferences."
    );
    const sensorKey =
      Object.hasOwn(this._config, "config_entity") || !Object.hasOwn(this._config, "entity")
        ? "config_entity"
        : "entity";
    this._textField(
      general,
      "Configuration sensor",
      sensorKey,
      "Optional; leave empty to find the integration sensor automatically."
    );
    if (sensorKey === "config_entity" && Object.hasOwn(this._config, "entity")) {
      this._textField(
        general,
        "Legacy configuration sensor",
        "entity",
        "Used when the configuration sensor above is empty."
      );
    }
    this._numberField(general, "Fixed number of days", "days", 1, "Overrides the view selector.");
    const automatic = ["", "Use default / saved preference"];
    this._select(general, "View", "view", [
      automatic,
      ["day", "Day"],
      ["three_day", "3 days"],
      ["week", "Week"],
      ["month", "Month"],
    ]);
    this._select(
      general,
      "First day shown",
      "first_day",
      [
        ["current_day", "Current day"],
        ["sunday", "Sunday"],
        ["monday", "Monday"],
      ],
      "Affects week view and the month grid; other views start on the selected date.",
      "current_day"
    );
    this._select(general, "Layout", "layout", [automatic, ["condensed", "Condensed"], ["timeline", "Timeline"]]);
    this._select(general, "Multi-day events", "multi_day", [
      automatic,
      ["banners", "Banners"],
      ["segments", "Segments"],
    ]);
    this._select(general, "Event style", "event_style", [automatic, ["bar", "Colored bar"], ["filled", "Filled"]]);
    this._numberField(general, "Timeline start hour", "start_hour", null);
    this._numberField(general, "Timeline end hour", "end_hour", null);
    this._numberField(general, "Timeline hour height (pixels)", "hour_height", null);
    this._select(general, "Theme", "theme", [
      ["", "Use integration default"],
      ["system", "System"],
      ["light", "Light"],
      ["dark", "Dark"],
    ]);
    this._select(
      general,
      "Family button size",
      "button_size",
      [
        ["normal", "Normal"],
        ["large", "Large"],
      ],
      "Large buttons have a minimum 44-pixel touch height.",
      "normal"
    );
    const note = document.createElement("p");
    note.textContent =
      "Choosing a view, layout, event style, multi-day style, timeline setting or theme fixes that setting for this card.";
    general.append(note);
    this._iconKeywords();
    this._dayMarkers();
  }
}

if (!customElements.get("family-calendar-card-editor")) {
  customElements.define("family-calendar-card-editor", FamilyCalendarCardEditor);
}

if (!customElements.get("family-calendar-card")) {
  customElements.define("family-calendar-card", FamilyCalendarCard);
}

window.customCards = window.customCards || [];
window.customCards.push({
  type: "family-calendar-card",
  name: "Family Calendar Card",
  description: "Weekly calendar view with color-coded events, icons, and a click-to-detail popup.",
});
