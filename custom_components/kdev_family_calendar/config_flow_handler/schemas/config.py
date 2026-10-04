"""Schemas for the Family Calendar setup flow."""

from collections.abc import Mapping
from typing import Any

import voluptuous as vol

from custom_components.kdev_family_calendar.const import (
    CONF_CALENDAR_COLOR,
    CONF_CALENDAR_NAME,
    CONF_CALENDAR_TEXT_COLOR,
    CONF_CALENDARS,
    CONF_DARK_CARD_COLOR,
    CONF_DARK_DAY_COLOR,
    CONF_DARK_TODAY_COLOR,
    CONF_END_HOUR,
    CONF_HOUR_HEIGHT,
    CONF_LAYOUT,
    CONF_LIGHT_CARD_COLOR,
    CONF_LIGHT_DAY_COLOR,
    CONF_LIGHT_TODAY_COLOR,
    CONF_START_HOUR,
    CONF_THEME,
    CONF_VIEW,
)
from homeassistant.helpers import selector


def get_user_schema() -> vol.Schema:
    """Build the calendar-selection form."""
    return vol.Schema(
        {
            vol.Required(CONF_CALENDARS): selector.EntitySelector(
                selector.EntitySelectorConfig(domain="calendar", multiple=True),
            ),
        },
    )


def get_calendar_settings_schema(name: str, color: str, text_color: str) -> vol.Schema:
    """Build one calendar's display-name and color form."""
    return vol.Schema(
        {
            vol.Required(CONF_CALENDAR_NAME, default=name): selector.TextSelector(
                selector.TextSelectorConfig(type=selector.TextSelectorType.TEXT),
            ),
            vol.Required(CONF_CALENDAR_COLOR, default=color): selector.TextSelector(
                selector.TextSelectorConfig(type=selector.TextSelectorType.COLOR),
            ),
            vol.Required(CONF_CALENDAR_TEXT_COLOR, default=text_color): selector.TextSelector(
                selector.TextSelectorConfig(type=selector.TextSelectorType.COLOR),
            ),
        },
    )


def get_defaults_schema(defaults: Mapping[str, Any]) -> vol.Schema:
    """Build the global display-defaults form."""
    return vol.Schema(
        {
            vol.Required(CONF_VIEW, default=defaults[CONF_VIEW]): selector.SelectSelector(
                selector.SelectSelectorConfig(
                    options=["day", "three_day", "week", "month"],
                    mode=selector.SelectSelectorMode.DROPDOWN,
                    translation_key=CONF_VIEW,
                ),
            ),
            vol.Required(CONF_LAYOUT, default=defaults[CONF_LAYOUT]): selector.SelectSelector(
                selector.SelectSelectorConfig(
                    options=["condensed", "timeline"],
                    mode=selector.SelectSelectorMode.DROPDOWN,
                    translation_key=CONF_LAYOUT,
                ),
            ),
            vol.Required(CONF_START_HOUR, default=defaults[CONF_START_HOUR]): selector.NumberSelector(
                selector.NumberSelectorConfig(
                    min=0,
                    max=22,
                    step=1,
                    mode=selector.NumberSelectorMode.BOX,
                ),
            ),
            vol.Required(CONF_END_HOUR, default=defaults[CONF_END_HOUR]): selector.NumberSelector(
                selector.NumberSelectorConfig(
                    min=1,
                    max=23,
                    step=1,
                    mode=selector.NumberSelectorMode.BOX,
                ),
            ),
            vol.Required(CONF_HOUR_HEIGHT, default=defaults[CONF_HOUR_HEIGHT]): selector.NumberSelector(
                selector.NumberSelectorConfig(
                    min=24,
                    max=120,
                    step=1,
                    unit_of_measurement="px",
                    mode=selector.NumberSelectorMode.BOX,
                ),
            ),
            vol.Required(CONF_THEME, default=defaults[CONF_THEME]): selector.SelectSelector(
                selector.SelectSelectorConfig(
                    options=["system", "light", "dark"],
                    mode=selector.SelectSelectorMode.DROPDOWN,
                    translation_key=CONF_THEME,
                ),
            ),
            vol.Required(
                CONF_LIGHT_DAY_COLOR,
                default=defaults[CONF_LIGHT_DAY_COLOR],
            ): selector.TextSelector(selector.TextSelectorConfig(type=selector.TextSelectorType.COLOR)),
            vol.Required(
                CONF_LIGHT_TODAY_COLOR,
                default=defaults[CONF_LIGHT_TODAY_COLOR],
            ): selector.TextSelector(selector.TextSelectorConfig(type=selector.TextSelectorType.COLOR)),
            vol.Required(
                CONF_LIGHT_CARD_COLOR,
                default=defaults[CONF_LIGHT_CARD_COLOR],
            ): selector.TextSelector(selector.TextSelectorConfig(type=selector.TextSelectorType.COLOR)),
            vol.Required(
                CONF_DARK_DAY_COLOR,
                default=defaults[CONF_DARK_DAY_COLOR],
            ): selector.TextSelector(selector.TextSelectorConfig(type=selector.TextSelectorType.COLOR)),
            vol.Required(
                CONF_DARK_TODAY_COLOR,
                default=defaults[CONF_DARK_TODAY_COLOR],
            ): selector.TextSelector(selector.TextSelectorConfig(type=selector.TextSelectorType.COLOR)),
            vol.Required(
                CONF_DARK_CARD_COLOR,
                default=defaults[CONF_DARK_CARD_COLOR],
            ): selector.TextSelector(selector.TextSelectorConfig(type=selector.TextSelectorType.COLOR)),
        },
    )


__all__ = ["get_calendar_settings_schema", "get_defaults_schema", "get_user_schema"]
