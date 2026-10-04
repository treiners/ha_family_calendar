"""Tests for the configuration sensor."""

from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.kdev_family_calendar.const import DOMAIN
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
