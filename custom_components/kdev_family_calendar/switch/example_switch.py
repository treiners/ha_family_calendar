"""Configuration switches for kdev_family_calendar."""

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from custom_components.kdev_family_calendar.api import KdevFamilyCalendarApiClientError
from custom_components.kdev_family_calendar.const import DOMAIN
from custom_components.kdev_family_calendar.entity import KdevFamilyCalendarEntity
from homeassistant.components.switch import SwitchEntity, SwitchEntityDescription
from homeassistant.const import EntityCategory
from homeassistant.exceptions import HomeAssistantError


@dataclass(frozen=True, kw_only=True)
class KdevFamilyCalendarSwitchEntityDescription(SwitchEntityDescription):
    """Describes a switch and how to read it from coordinator data."""

    value_fn: Callable[[dict[str, Any]], bool | None]


ENTITY_DESCRIPTIONS: tuple[KdevFamilyCalendarSwitchEntityDescription, ...] = (
    KdevFamilyCalendarSwitchEntityDescription(
        key="child_lock",
        translation_key="child_lock",
        entity_category=EntityCategory.CONFIG,
        value_fn=lambda data: data.get("child_lock"),
    ),
    KdevFamilyCalendarSwitchEntityDescription(
        key="led_display",
        translation_key="led_display",
        entity_category=EntityCategory.CONFIG,
        entity_registry_enabled_default=False,
        value_fn=lambda data: data.get("led_display"),
    ),
)


class KdevFamilyCalendarSwitch(SwitchEntity, KdevFamilyCalendarEntity):
    """Switch for one of the device's boolean settings."""

    entity_description: KdevFamilyCalendarSwitchEntityDescription

    @property
    def is_on(self) -> bool | None:
        """Return the value read from coordinator data."""
        return self.entity_description.value_fn(self.coordinator.data)

    async def async_turn_on(self, **kwargs: Any) -> None:
        """Turn the setting on."""
        await self._async_set(enabled=True)

    async def async_turn_off(self, **kwargs: Any) -> None:
        """Turn the setting off."""
        await self._async_set(enabled=False)

    async def _async_set(self, *, enabled: bool) -> None:
        """Write the setting to the device and refresh."""
        client = self.coordinator.config_entry.runtime_data.client
        try:
            await client.async_set_toggle(self.entity_description.key, enabled=enabled)
        except KdevFamilyCalendarApiClientError as exception:
            raise HomeAssistantError(
                translation_domain=DOMAIN,
                translation_key="switch_set_failed",
                translation_placeholders={"name": self.entity_description.key},
            ) from exception

        await self.coordinator.async_request_refresh()
