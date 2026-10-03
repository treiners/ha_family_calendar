"""Binary sensor platform for kdev_family_calendar."""

from typing import TYPE_CHECKING

from .filter import ENTITY_DESCRIPTIONS, KdevFamilyCalendarFilterSensor

# Read-only platform: the coordinator already serializes the fetch.
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
    """Set up the binary_sensor platform."""
    async_add_entities(
        KdevFamilyCalendarFilterSensor(entry.runtime_data.coordinator, description)
        for description in ENTITY_DESCRIPTIONS
    )
