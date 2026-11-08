"""Tests for the configuration sensor."""

from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.kdev_family_calendar.const import (
    CONF_DARK_HEADER_COLOR,
    CONF_LIGHT_HEADER_COLOR,
    CONF_WEEKDAY_FONT_SIZE,
    DOMAIN,
)
from homeassistant.core import HomeAssistant
from homeassistant.helpers import entity_registry as er


async def test_sensor_exposes_calendar_settings(
    init_integration: MockConfigEntry,
    hass: HomeAssistant,
) -> None:
    """The sensor exposes the calendar list and card defaults."""
    entity_registry = er.async_get(hass)
    entity_id = entity_registry.async_get_entity_id(
        "sensor",
        DOMAIN,
        f"{init_integration.entry_id}_configuration",
    )
    assert entity_id is not None

    state = hass.states.get(entity_id)
    assert state is not None
    assert state.state == "1"
    assert state.attributes["calendars"] == [
        {
            "entity_id": "calendar.mock_calendar",
            "name": "Home",
            "color": "#eda6b5",
            "text_color": "#000000",
        },
    ]
    assert state.attributes["defaults"]["view"] == "week"
    assert state.attributes["defaults"]["layout"] == "condensed"


async def test_old_entry_gets_header_defaults_without_migration(
    hass: HomeAssistant, config_entry: MockConfigEntry
) -> None:
    """Entries saved before header settings retain their options and receive defaults."""
    old_options = {
        key: value
        for key, value in config_entry.options.items()
        if key not in (CONF_WEEKDAY_FONT_SIZE, CONF_LIGHT_HEADER_COLOR, CONF_DARK_HEADER_COLOR)
    }
    config_entry.add_to_hass(hass)
    hass.config_entries.async_update_entry(config_entry, options=old_options)
    assert await hass.config_entries.async_setup(config_entry.entry_id)
    await hass.async_block_till_done()
    entity_id = er.async_get(hass).async_get_entity_id("sensor", DOMAIN, f"{config_entry.entry_id}_configuration")
    assert entity_id is not None
    state = hass.states.get(entity_id)
    assert state is not None
    assert state.attributes["defaults"][CONF_WEEKDAY_FONT_SIZE] == 16
    assert state.attributes["defaults"][CONF_LIGHT_HEADER_COLOR] == ""
    assert state.attributes["defaults"][CONF_DARK_HEADER_COLOR] == ""
    assert dict(config_entry.options) == old_options
