"""Tests for Family Calendar setup and options."""

from typing import Any

from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.kdev_family_calendar.const import (
    CONF_CALENDAR_COLOR,
    CONF_CALENDAR_NAME,
    CONF_CALENDAR_SETTINGS,
    CONF_CALENDAR_TEXT_COLOR,
    CONF_CALENDARS,
    DEFAULT_SETTINGS,
    DOMAIN,
)
from homeassistant.core import HomeAssistant


async def test_setup_flow_collects_calendar_settings(hass: HomeAssistant) -> None:
    """The setup flow stores selected calendars and display defaults."""
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": "user"})
    assert result["type"] == "form"
    assert result["step_id"] == "user"

    result = await hass.config_entries.flow.async_configure(
        result["flow_id"],
        {CONF_CALENDARS: ["calendar.mock_calendar"]},
    )
    assert result["step_id"] == "calendar_settings"

    result = await hass.config_entries.flow.async_configure(
        result["flow_id"],
        {
            CONF_CALENDAR_NAME: "Home",
            CONF_CALENDAR_COLOR: "#123456",
        },
    )
    assert result["step_id"] == "defaults"

    result = await hass.config_entries.flow.async_configure(result["flow_id"], dict(DEFAULT_SETTINGS))

    assert result["type"] == "create_entry"
    assert result["title"] == "Family Calendar"
    assert result["data"] == {}
    assert result["options"][CONF_CALENDARS] == ["calendar.mock_calendar"]
    assert result["options"][CONF_CALENDAR_SETTINGS]["calendar.mock_calendar"] == {
        CONF_CALENDAR_NAME: "Home",
        CONF_CALENDAR_COLOR: "#123456",
        CONF_CALENDAR_TEXT_COLOR: "#000000",
    }


async def test_setup_flow_rejects_end_hour_before_start(hass: HomeAssistant) -> None:
    """The display defaults cannot define a backwards time range."""
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": "user"})
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"],
        {CONF_CALENDARS: ["calendar.mock_calendar"]},
    )
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"],
        {
            CONF_CALENDAR_NAME: "Home",
            CONF_CALENDAR_COLOR: "#123456",
        },
    )
    defaults: dict[str, Any] = {
        **DEFAULT_SETTINGS,
        "start_hour": 20,
        "end_hour": 19,
    }

    result = await hass.config_entries.flow.async_configure(result["flow_id"], defaults)

    assert result["type"] == "form"
    assert result["step_id"] == "defaults"
    assert result["errors"] == {"base": "invalid_hours"}


async def test_options_flow_updates_calendar_settings(
    hass: HomeAssistant,
    config_entry: MockConfigEntry,
) -> None:
    """The options flow can update a calendar's label and color."""
    config_entry.add_to_hass(hass)
    result = await hass.config_entries.options.async_init(config_entry.entry_id)
    assert result["type"] == "form"

    result = await hass.config_entries.options.async_configure(
        result["flow_id"],
        {
            **DEFAULT_SETTINGS,
            CONF_CALENDARS: ["calendar.mock_calendar"],
        },
    )
    assert result["step_id"] == "calendar_settings"

    result = await hass.config_entries.options.async_configure(
        result["flow_id"],
        {
            CONF_CALENDAR_NAME: "Updated",
            CONF_CALENDAR_COLOR: "#654321",
        },
    )

    assert result["step_id"] == "markers"

    result = await hass.config_entries.options.async_configure(
        result["flow_id"],
        {"day_markers": [{"keyword": "redbin", "icon": "mdi:recycle", "color": "#ff0000"}]},
    )

    assert result["type"] == "create_entry"
    assert result["data"]["day_markers"][0]["keyword"] == "redbin"
    assert result["data"][CONF_CALENDAR_SETTINGS]["calendar.mock_calendar"] == {
        CONF_CALENDAR_NAME: "Updated",
        CONF_CALENDAR_COLOR: "#654321",
        CONF_CALENDAR_TEXT_COLOR: "#000000",
    }
