"""Shared fixtures for Family Calendar tests."""

import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.kdev_family_calendar.const import (
    CONF_CALENDAR_COLOR,
    CONF_CALENDAR_NAME,
    CONF_CALENDAR_SETTINGS,
    CONF_CALENDARS,
    DEFAULT_SETTINGS,
    DOMAIN,
)
from homeassistant.core import HomeAssistant


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(enable_custom_integrations: None) -> None:
    """Load custom integrations in every test."""


@pytest.fixture
def config_entry() -> MockConfigEntry:
    """Return a Family Calendar config entry."""
    return MockConfigEntry(
        domain=DOMAIN,
        title="Family Calendar",
        unique_id=DOMAIN,
        data={},
        options={
            **DEFAULT_SETTINGS,
            CONF_CALENDARS: ["calendar.mock_calendar"],
            CONF_CALENDAR_SETTINGS: {
                "calendar.mock_calendar": {
                    CONF_CALENDAR_NAME: "Home",
                    CONF_CALENDAR_COLOR: "#eda6b5",
                },
            },
        },
    )


@pytest.fixture
async def init_integration(
    hass: HomeAssistant,
    config_entry: MockConfigEntry,
) -> MockConfigEntry:
    """Set up the integration from a config entry."""
    config_entry.add_to_hass(hass)
    await hass.config_entries.async_setup(config_entry.entry_id)
    await hass.async_block_till_done()
    return config_entry
