"""Set up the Family Calendar integration."""

from pathlib import Path
from typing import TYPE_CHECKING

from homeassistant.components import frontend
from homeassistant.components.http.server import StaticPathConfig
from homeassistant.const import Platform
from homeassistant.helpers import config_validation as cv

from .const import DOMAIN, LOGGER
from .coordinator import KdevFamilyCalendarDataUpdateCoordinator
from .data import KdevFamilyCalendarData

if TYPE_CHECKING:
    from homeassistant.core import HomeAssistant

    from .data import KdevFamilyCalendarConfigEntry

PLATFORMS: list[Platform] = [Platform.SENSOR]
CARD_URL = f"/{DOMAIN}/family-calendar-card.js"
CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)


async def async_setup(hass: HomeAssistant, config: dict[str, object]) -> bool:
    """Register and load the bundled Lovelace card."""
    card_path = Path(__file__).parent / "www" / "family-calendar-card.js"
    await hass.http.async_register_static_paths([StaticPathConfig(CARD_URL, str(card_path), cache_headers=False)])
    frontend.add_extra_js_url(hass, CARD_URL)
    return True


async def async_setup_entry(
    hass: HomeAssistant,
    entry: KdevFamilyCalendarConfigEntry,
) -> bool:
    """Set up the selected calendars and configuration sensor."""
    coordinator = KdevFamilyCalendarDataUpdateCoordinator(
        hass=hass,
        logger=LOGGER,
        name=DOMAIN,
        config_entry=entry,
        update_interval=None,
        always_update=False,
    )
    entry.runtime_data = KdevFamilyCalendarData(coordinator=coordinator)

    await coordinator.async_config_entry_first_refresh()
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(
    hass: HomeAssistant,
    entry: KdevFamilyCalendarConfigEntry,
) -> bool:
    """Unload the sensor platform."""
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
