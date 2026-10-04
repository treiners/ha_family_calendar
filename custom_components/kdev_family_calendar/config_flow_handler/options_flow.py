"""Options flow for changing calendars and display defaults."""

from typing import Any

from custom_components.kdev_family_calendar.const import (
    CONF_CALENDAR_COLOR,
    CONF_CALENDAR_NAME,
    CONF_CALENDAR_SETTINGS,
    CONF_CALENDAR_TEXT_COLOR,
    CONF_CALENDARS,
    CONF_DAY_MARKERS,
    CONF_ICON_KEYWORDS,
    DEFAULT_CALENDAR_COLORS,
    DEFAULT_CALENDAR_TEXT_COLOR,
    DEFAULT_SETTINGS,
)
from homeassistant import config_entries

from .schemas import get_calendar_settings_schema, get_markers_schema
from .schemas.options import get_options_schema


class KdevFamilyCalendarOptionsFlow(config_entries.OptionsFlowWithReload):
    """Let the user change calendars and card defaults after setup."""

    def __init__(self) -> None:
        """Initialize the flow state."""
        self._calendars: list[str] = []
        self._calendar_settings: dict[str, dict[str, str]] = {}
        self._calendar_index = 0
        self._pending_options: dict[str, Any] = {}

    async def async_step_init(
        self,
        user_input: dict[str, Any] | None = None,
    ) -> config_entries.ConfigFlowResult:
        """Select calendars and update global defaults."""
        if user_input is not None:
            if not user_input[CONF_CALENDARS]:
                return self.async_show_form(
                    step_id="init",
                    data_schema=get_options_schema({**DEFAULT_SETTINGS, **self.config_entry.options}),
                    errors={"base": "invalid_calendars"},
                )
            if user_input["start_hour"] >= user_input["end_hour"]:
                return self.async_show_form(
                    step_id="init",
                    data_schema=get_options_schema({**DEFAULT_SETTINGS, **self.config_entry.options}),
                    errors={"base": "invalid_hours"},
                )

            self._calendars = user_input[CONF_CALENDARS]
            self._pending_options = {
                **user_input,
                CONF_CALENDARS: self._calendars,
            }
            current_settings = self.config_entry.options.get(CONF_CALENDAR_SETTINGS, {})
            self._calendar_settings = {
                entity_id: dict(current_settings.get(entity_id, {})) for entity_id in self._calendars
            }
            self._calendar_index = 0
            return await self.async_step_calendar_settings()

        return self.async_show_form(
            step_id="init",
            data_schema=get_options_schema({**DEFAULT_SETTINGS, **self.config_entry.options}),
        )

    async def async_step_calendar_settings(
        self,
        user_input: dict[str, Any] | None = None,
    ) -> config_entries.ConfigFlowResult:
        """Update the display name and color for each selected calendar."""
        if user_input is not None:
            entity_id = self._calendars[self._calendar_index]
            self._calendar_settings[entity_id] = {
                CONF_CALENDAR_NAME: user_input[CONF_CALENDAR_NAME].strip() or self._calendar_name(entity_id),
                CONF_CALENDAR_COLOR: user_input[CONF_CALENDAR_COLOR],
                CONF_CALENDAR_TEXT_COLOR: user_input[CONF_CALENDAR_TEXT_COLOR],
            }
            self._calendar_index += 1
            if self._calendar_index >= len(self._calendars):
                self._pending_options[CONF_CALENDAR_SETTINGS] = self._calendar_settings
                return await self.async_step_markers()

        entity_id = self._calendars[self._calendar_index]
        existing = self._calendar_settings.get(entity_id, {})
        color_index = self._calendar_index % len(DEFAULT_CALENDAR_COLORS)
        return self.async_show_form(
            step_id="calendar_settings",
            data_schema=get_calendar_settings_schema(
                existing.get(CONF_CALENDAR_NAME) or self._calendar_name(entity_id),
                existing.get(CONF_CALENDAR_COLOR) or DEFAULT_CALENDAR_COLORS[color_index],
                existing.get(CONF_CALENDAR_TEXT_COLOR) or DEFAULT_CALENDAR_TEXT_COLOR,
            ),
            description_placeholders={"calendar": self._calendar_name(entity_id)},
        )

    async def async_step_markers(
        self,
        user_input: dict[str, Any] | None = None,
    ) -> config_entries.ConfigFlowResult:
        """Edit the default day markers and icon keywords."""
        if user_input is not None:
            return self.async_create_entry(
                title="",
                data={
                    **self._pending_options,
                    CONF_DAY_MARKERS: user_input.get(CONF_DAY_MARKERS, []),
                    CONF_ICON_KEYWORDS: user_input.get(CONF_ICON_KEYWORDS, []),
                },
            )
        return self.async_show_form(
            step_id="markers",
            data_schema=get_markers_schema(
                self.config_entry.options.get(CONF_DAY_MARKERS, []),
                self.config_entry.options.get(CONF_ICON_KEYWORDS, []),
            ),
        )

    def _calendar_name(self, entity_id: str) -> str:
        """Return the current friendly name or a readable entity ID."""
        state = self.hass.states.get(entity_id)
        if state is not None:
            return str(state.attributes.get("friendly_name", entity_id))
        return entity_id.split(".", maxsplit=1)[-1].replace("_", " ").title()


__all__ = ["KdevFamilyCalendarOptionsFlow"]
