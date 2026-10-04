"""Configuration sensor exposing calendar selections and card defaults."""

from typing import Any

from custom_components.kdev_family_calendar.const import (
    CONF_CALENDAR_COLOR,
    CONF_CALENDAR_NAME,
    CONF_CALENDAR_SETTINGS,
    CONF_CALENDAR_TEXT_COLOR,
    CONF_CALENDARS,
    DEFAULT_CALENDAR_COLORS,
    DEFAULT_CALENDAR_TEXT_COLOR,
    DEFAULT_SETTINGS,
)
from custom_components.kdev_family_calendar.coordinator import KdevFamilyCalendarDataUpdateCoordinator
from custom_components.kdev_family_calendar.entity import KdevFamilyCalendarEntity
from homeassistant.components.sensor import SensorEntity, SensorEntityDescription
from homeassistant.const import EntityCategory

ENTITY_DESCRIPTION = SensorEntityDescription(
    key="configuration",
    translation_key="configuration",
    entity_category=EntityCategory.DIAGNOSTIC,
)


class KdevFamilyCalendarConfigurationSensor(SensorEntity, KdevFamilyCalendarEntity):
    """Expose selected calendars and global defaults to the Lovelace card."""

    entity_description = ENTITY_DESCRIPTION

    def __init__(self, coordinator: KdevFamilyCalendarDataUpdateCoordinator) -> None:
        """Initialize the configuration sensor."""
        super().__init__(coordinator, ENTITY_DESCRIPTION)

    @property
    def native_value(self) -> int:
        """Return the number of calendars selected for the card."""
        return len(self.coordinator.data.get(CONF_CALENDARS, []))

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        """Return card configuration as serializable state attributes."""
        options = self.coordinator.data
        calendar_settings = options.get(CONF_CALENDAR_SETTINGS, {})
        calendars = [
            {
                "entity_id": entity_id,
                "name": calendar_settings.get(entity_id, {}).get(CONF_CALENDAR_NAME, entity_id),
                "color": calendar_settings.get(entity_id, {}).get(
                    CONF_CALENDAR_COLOR,
                    DEFAULT_CALENDAR_COLORS[index % len(DEFAULT_CALENDAR_COLORS)],
                ),
                "text_color": calendar_settings.get(entity_id, {}).get(
                    CONF_CALENDAR_TEXT_COLOR,
                    DEFAULT_CALENDAR_TEXT_COLOR,
                ),
            }
            for index, entity_id in enumerate(options.get(CONF_CALENDARS, []))
        ]
        defaults = {**DEFAULT_SETTINGS, **options}
        return {
            "calendars": calendars,
            "defaults": {
                key: value for key, value in defaults.items() if key not in (CONF_CALENDARS, CONF_CALENDAR_SETTINGS)
            },
        }
