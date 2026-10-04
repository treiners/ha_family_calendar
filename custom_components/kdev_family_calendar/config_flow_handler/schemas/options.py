"""Schema for changing the selected calendars and display defaults."""

from collections.abc import Mapping
from typing import Any, cast

import voluptuous as vol

from custom_components.kdev_family_calendar.const import (
    CONF_CALENDARS,
    CONF_DAY_MARKERS,
    CONF_ICON_KEYWORDS,
    DEFAULT_SETTINGS,
)
from homeassistant.helpers import selector

from .config import get_defaults_schema


def get_markers_schema(day_markers: list[dict[str, Any]], icon_keywords: list[dict[str, Any]]) -> vol.Schema:
    """Build the form schema for day markers and icon keywords."""
    keyword = {"selector": selector.TextSelector(), "required": True}
    icon = {"selector": selector.IconSelector(), "required": True}
    color = {"selector": selector.TextSelector(selector.TextSelectorConfig(type=selector.TextSelectorType.COLOR))}
    return vol.Schema(
        {
            vol.Optional(CONF_DAY_MARKERS, default=day_markers): selector.ObjectSelector(
                selector.ObjectSelectorConfig(
                    multiple=True,
                    label_field="keyword",
                    description_field="icon",
                    fields=cast("Any", {"keyword": keyword, "icon": icon, "color": color}),
                )
            ),
            vol.Optional(CONF_ICON_KEYWORDS, default=icon_keywords): selector.ObjectSelector(
                selector.ObjectSelectorConfig(
                    multiple=True,
                    label_field="keyword",
                    description_field="icon",
                    fields=cast("Any", {"keyword": keyword, "icon": icon}),
                )
            ),
        }
    )


def get_options_schema(defaults: Mapping[str, Any] | None = None) -> vol.Schema:
    """
    Build the options form schema.

    Args:
        defaults: Existing options, used to pre-fill the form.

    Returns:
        The voluptuous schema for the options form.

    """
    defaults = defaults or {}
    normalized_defaults = {**DEFAULT_SETTINGS, **defaults}
    return get_defaults_schema(normalized_defaults).extend(
        {
            vol.Required(CONF_CALENDARS, default=defaults.get(CONF_CALENDARS, [])): selector.EntitySelector(
                selector.EntitySelectorConfig(domain="calendar", multiple=True),
            ),
        },
    )


__all__ = ["get_options_schema"]
