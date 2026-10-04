"""Configuration data coordinator for Family Calendar."""

from typing import TYPE_CHECKING, Any

from homeassistant.helpers.update_coordinator import DataUpdateCoordinator

if TYPE_CHECKING:
    from custom_components.kdev_family_calendar.data import KdevFamilyCalendarConfigEntry


class KdevFamilyCalendarDataUpdateCoordinator(DataUpdateCoordinator[dict[str, Any]]):
    """Share the integration's configured calendar settings with its entity."""

    config_entry: KdevFamilyCalendarConfigEntry

    async def _async_update_data(self) -> dict[str, Any]:
        """Return normalized options; calendar events arrive on the card's subscriptions."""
        return dict(self.config_entry.options)
