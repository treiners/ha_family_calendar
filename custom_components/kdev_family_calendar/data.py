"""Runtime data types for Family Calendar."""

from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from homeassistant.config_entries import ConfigEntry

    from .coordinator import KdevFamilyCalendarDataUpdateCoordinator
    from .utils.errands_store import KdevFamilyCalendarErrandsStore

type KdevFamilyCalendarConfigEntry = ConfigEntry[KdevFamilyCalendarData]


@dataclass
class KdevFamilyCalendarData:
    """Runtime data stored on the config entry after setup."""

    coordinator: KdevFamilyCalendarDataUpdateCoordinator
    errands: KdevFamilyCalendarErrandsStore | None
