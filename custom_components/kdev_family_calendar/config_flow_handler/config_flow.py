"""Config flow for selecting calendars and configuring the card defaults."""

from typing import Any

from custom_components.kdev_family_calendar.const import (
    CONF_CALENDAR_COLOR,
    CONF_CALENDAR_NAME,
    CONF_CALENDAR_SETTINGS,
    CONF_CALENDAR_TEXT_COLOR,
    CONF_CALENDARS,
    DEFAULT_CALENDAR_COLORS,
    DEFAULT_CALENDAR_TEXT_COLOR,
    DEFAULT_SETTINGS,
    DOMAIN,
)
from homeassistant import config_entries

from .options_flow import KdevFamilyCalendarOptionsFlow
from .schemas import get_calendar_settings_schema, get_defaults_schema, get_user_schema


class KdevFamilyCalendarConfigFlowHandler(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle Family Calendar setup."""

    VERSION = 1

    def __init__(self) -> None:
        """Initialize the flow state."""
        self._calendars: list[str] = []
        self._calendar_settings: dict[str, dict[str, str]] = {}
        self._calendar_index = 0

    @staticmethod
    def async_get_options_flow(
        config_entry: config_entries.ConfigEntry,
    ) -> config_entries.OptionsFlow:
        """Return the options flow."""
        return KdevFamilyCalendarOptionsFlow()

    async def async_step_user(
        self,
        user_input: dict[str, Any] | None = None,
    ) -> config_entries.ConfigFlowResult:
        """Select the calendar entities to display."""
        await self.async_set_unique_id(DOMAIN)
        self._abort_if_unique_id_configured()

        if user_input is not None:
            calendars = user_input[CONF_CALENDARS]
            if not calendars:
                return self.async_show_form(
                    step_id="user",
                    data_schema=get_user_schema(),
                    errors={"base": "invalid_calendars"},
                )
            self._calendars = calendars
            self._calendar_index = 0
            return await self.async_step_calendar_settings()

        return self.async_show_form(step_id="user", data_schema=get_user_schema())

    async def async_step_calendar_settings(
        self,
        user_input: dict[str, Any] | None = None,
    ) -> config_entries.ConfigFlowResult:
        """Collect a display name and color for each selected calendar."""
        if user_input is not None:
            entity_id = self._calendars[self._calendar_index]
            self._calendar_settings[entity_id] = {
                CONF_CALENDAR_NAME: user_input[CONF_CALENDAR_NAME].strip() or self._calendar_name(entity_id),
                CONF_CALENDAR_COLOR: user_input[CONF_CALENDAR_COLOR],
                CONF_CALENDAR_TEXT_COLOR: user_input[CONF_CALENDAR_TEXT_COLOR],
            }
            self._calendar_index += 1
            if self._calendar_index >= len(self._calendars):
                return await self.async_step_defaults()

        entity_id = self._calendars[self._calendar_index]
        return self.async_show_form(
            step_id="calendar_settings",
            data_schema=get_calendar_settings_schema(
                self._suggested_calendar_name(entity_id),
                DEFAULT_CALENDAR_COLORS[self._calendar_index % len(DEFAULT_CALENDAR_COLORS)],
                DEFAULT_CALENDAR_TEXT_COLOR,
            ),
            description_placeholders={"calendar": self._calendar_name(entity_id)},
        )

    async def async_step_defaults(
        self,
        user_input: dict[str, Any] | None = None,
    ) -> config_entries.ConfigFlowResult:
        """Collect global view, layout, time-window, and palette defaults."""
        errors: dict[str, str] = {}
        if user_input is not None:
            errors = _validate_hours(user_input)
            if not errors:
                options = {
                    **user_input,
                    CONF_CALENDARS: self._calendars,
                    CONF_CALENDAR_SETTINGS: self._calendar_settings,
                }
                return self.async_create_entry(title="Family Calendar", data={}, options=options)

        return self.async_show_form(
            step_id="defaults",
            data_schema=get_defaults_schema(DEFAULT_SETTINGS),
            errors=errors,
        )

    def _calendar_name(self, entity_id: str) -> str:
        """Return the current friendly name or a readable entity ID."""
        state = self.hass.states.get(entity_id)
        if state is not None:
            return str(state.attributes.get("friendly_name", entity_id))
        return entity_id.split(".", maxsplit=1)[-1].replace("_", " ").title()

    def _suggested_calendar_name(self, entity_id: str) -> str:
        """Suggest the Home Assistant friendly name."""
        return self._calendar_name(entity_id)


def _validate_hours(user_input: dict[str, Any]) -> dict[str, str]:
    """Ensure the visible time window ends after it starts."""
    if user_input["start_hour"] >= user_input["end_hour"]:
        return {"base": "invalid_hours"}
    return {}


__all__ = ["KdevFamilyCalendarConfigFlowHandler"]
