/** Bundled Home Assistant calendar card. */

const CARD_VERSION = "1.0.0";

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
  constructor() {
    super();
    // Shadow root is required for :host CSS variables to work at all,
    // and keeps our CSS classes (.fc-event, .fc-day, etc.) isolated
    // from other cards' global card_mod / theme CSS on the page.
    this._root = this.attachShadow({ mode: "open" });
  }

  setConfig(config) {
    if (typeof config.instance !== "string" || !config.instance.trim()) {
      throw new Error("family-calendar-card requires a stable, unique instance name.");
    }
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
    this._subscriptions = [];
    this._calendarEvents = {};
    this._subscriptionKey = null;
    this._built = false;
  }

  set hass(hass) {
    this._hass = hass;
    const stateObj = hass.states[this._sensorEntity];

    if (!stateObj) {
      this._clearSubscriptions();
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
    void this._ensureSubscriptions();
  }

  disconnectedCallback() {
    this._clearSubscriptions();
  }

  _clearSubscriptions() {
    this._subscriptions.forEach((unsubscribe) => unsubscribe());
    this._subscriptions = [];
    this._subscriptionKey = null;
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
    this._anchorDate = this._defaultAnchor(this._viewMode, this._dateToISO(new Date()));
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
    } else if (view === "week") {
      anchor.setDate(anchor.getDate() - ((anchor.getDay() + 6) % 7));
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
      const gridStart = new Date(monthStart);
      gridStart.setDate(gridStart.getDate() - ((gridStart.getDay() + 6) % 7));
      const gridEnd = new Date(monthEnd);
      gridEnd.setDate(gridEnd.getDate() + ((8 - gridEnd.getDay()) % 7 || 7));
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

    this._subscriptionKey = key;
    this._subscriptionError = "";
    this._subscriptions.forEach((unsubscribe) => unsubscribe());
    this._subscriptions = [];
    this._calendarEvents = {};
    this._buildDays(range);
    this._render();

    const subscriptions = await Promise.all(
      this._calendarList.map(async (calendar) => {
        try {
          return await this._hass.connection.subscribeMessage(
            (message) => {
              if (this._subscriptionKey !== key) return;
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
        } catch (error) {
          if (this._subscriptionKey === key) {
            this._subscriptionError = `Could not load ${calendar.name}: ${error.message || error}`;
            console.error("Family Calendar calendar subscription failed.", error);
            this._render();
          }
          return null;
        }
      })
    );

    const active = subscriptions.filter((unsubscribe) => unsubscribe !== null);
    if (this._subscriptionKey === key) {
      this._subscriptions = active;
    } else {
      active.forEach((unsubscribe) => unsubscribe());
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
  }

  _closeModal() {
    this._root.querySelector("#fc-modal").hidden = true;
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

  _renderToggles() {
    const toggleEl = this._root.querySelector("#fc-toggles");
    const calendars = this._getCalendarList();
    let html = "";
    let i = 0;
    while (i < calendars.length) {
      const cal = calendars[i];
      const isHidden = this._hiddenList.includes(cal.entity);
      html += `
        <button class="fc-toggle ${isHidden ? "fc-toggle--off" : ""}" data-entity="${cal.entity}" style="--fc-toggle-color:${cal.color}">
          <span class="fc-toggle-dot"></span>${this._escape(cal.person)}
        </button>
      `;
      i += 1;
    }
    toggleEl.innerHTML = html;
    const btns = toggleEl.querySelectorAll(".fc-toggle");
    btns.forEach((btn) => {
      btn.addEventListener("click", () => this._toggleCalendar(btn.dataset.entity));
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
        this._anchorDate = this._viewMode === "month" ? this._defaultAnchor("month", payload.start_date) : payload.start_date;
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
      errorEl.hidden = !this._subscriptionError;
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

  _dayMarkersHtml(markers) {
    if (markers.length === 0) return "";
    let html = '<span class="fc-day-markers">';
    let i = 0;
    while (i < markers.length) {
      const mk = markers[i];
      const style = mk.color ? ` style="color:${mk.color}"` : "";
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

    const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
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

customElements.define("family-calendar-card", FamilyCalendarCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "family-calendar-card",
  name: "Family Calendar Card",
  description: "Weekly calendar view with color-coded events, icons, and a click-to-detail popup.",
});
