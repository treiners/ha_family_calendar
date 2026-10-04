"""Sensor platform for Family Calendar."""

from typing import TYPE_CHECKING

from .configuration import KdevFamilyCalendarConfigurationSensor

PARALLEL_UPDATES = 0

if TYPE_CHECKING:
    from custom_components.kdev_family_calendar.data import KdevFamilyCalendarConfigEntry
    from homeassistant.core import HomeAssistant
    from homeassistant.helpers.entity_platform import AddEntitiesCallback


async def async_setup_entry(
    hass: HomeAssistant,
    entry: KdevFamilyCalendarConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up the configuration sensor."""
    async_add_entities([KdevFamilyCalendarConfigurationSensor(entry.runtime_data.coordinator)])
