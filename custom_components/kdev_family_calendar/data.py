"""
Runtime data types for kdev_family_calendar.

Access pattern: entry.runtime_data.client / entry.runtime_data.coordinator
"""

from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from homeassistant.config_entries import ConfigEntry
    from homeassistant.loader import Integration

    from .api import KdevFamilyCalendarApiClient
    from .coordinator import KdevFamilyCalendarDataUpdateCoordinator


type KdevFamilyCalendarConfigEntry = ConfigEntry[KdevFamilyCalendarData]


@dataclass
class KdevFamilyCalendarData:
    """Runtime data stored on the config entry after a successful setup."""

    client: KdevFamilyCalendarApiClient
    coordinator: KdevFamilyCalendarDataUpdateCoordinator
    integration: Integration
