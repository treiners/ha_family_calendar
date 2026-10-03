"""Reset filter button for kdev_family_calendar."""

from custom_components.kdev_family_calendar.api import KdevFamilyCalendarApiClientError
from custom_components.kdev_family_calendar.const import DOMAIN
from custom_components.kdev_family_calendar.entity import KdevFamilyCalendarEntity
from homeassistant.components.button import ButtonDeviceClass, ButtonEntity, ButtonEntityDescription
from homeassistant.const import EntityCategory
from homeassistant.exceptions import HomeAssistantError

ENTITY_DESCRIPTIONS: tuple[ButtonEntityDescription, ...] = (
    ButtonEntityDescription(
        key="reset_filter",
        translation_key="reset_filter",
        device_class=ButtonDeviceClass.RESTART,
        entity_category=EntityCategory.CONFIG,
    ),
)


class KdevFamilyCalendarButton(ButtonEntity, KdevFamilyCalendarEntity):
    """Button that resets the device's filter timer."""

    async def async_press(self) -> None:
        """Reset the filter timer on the device."""
        client = self.coordinator.config_entry.runtime_data.client
        try:
            await client.async_reset_filter()
        except KdevFamilyCalendarApiClientError as exception:
            raise HomeAssistantError(
                translation_domain=DOMAIN,
                translation_key="reset_filter_failed",
            ) from exception

        await self.coordinator.async_request_refresh()
