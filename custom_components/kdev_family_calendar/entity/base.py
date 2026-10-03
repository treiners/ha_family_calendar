"""Base entity class for kdev_family_calendar."""

from typing import TYPE_CHECKING

from custom_components.kdev_family_calendar.const import ATTRIBUTION
from custom_components.kdev_family_calendar.coordinator import KdevFamilyCalendarDataUpdateCoordinator
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.update_coordinator import CoordinatorEntity

if TYPE_CHECKING:
    from homeassistant.helpers.entity import EntityDescription


class KdevFamilyCalendarEntity(CoordinatorEntity[KdevFamilyCalendarDataUpdateCoordinator]):
    """
    Base entity providing device info, unique ID and attribution.

    The unique ID is `{entry_id}_{key}`, the documented identifier of last resort.
    A real integration switches to the device's serial, MAC or account ID before its
    first release, because changing it afterwards needs a registry migration.
    """

    _attr_attribution = ATTRIBUTION
    _attr_has_entity_name = True

    def __init__(
        self,
        coordinator: KdevFamilyCalendarDataUpdateCoordinator,
        entity_description: EntityDescription,
    ) -> None:
        """Initialize the entity."""
        super().__init__(coordinator)
        self.entity_description = entity_description
        self._attr_unique_id = f"{coordinator.config_entry.entry_id}_{entity_description.key}"
        self._attr_device_info = DeviceInfo(
            identifiers={
                (
                    coordinator.config_entry.domain,
                    coordinator.config_entry.entry_id,
                ),
            },
            name=coordinator.config_entry.title,
            manufacturer="Family Calendar",
            model=coordinator.data["model"],
            serial_number=coordinator.data["serial_number"],
            sw_version=coordinator.data["sw_version"],
        )
