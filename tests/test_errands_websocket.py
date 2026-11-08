"""Tests for the shared errands WebSocket interface."""

import asyncio
from typing import Any
from unittest.mock import patch
from uuid import uuid4

import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry, MockUser
from pytest_homeassistant_custom_component.typing import MockHAClientWebSocket, WebSocketGenerator

from custom_components.kdev_family_calendar.const import CONF_ERRAND_MANAGERS, DOMAIN
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.util.file import WriteError

# Home Assistant's HTTP middleware assigns a string key to aiohttp's request.
pytestmark = pytest.mark.filterwarnings(
    "ignore:It is recommended to use web.RequestKey instances for keys.:UserWarning"
)


async def _send(ws: MockHAClientWebSocket, entry: MockConfigEntry, endpoint: str, **fields: object) -> None:
    await ws.send_json_auto_id({"type": f"{DOMAIN}/errands/{endpoint}", "entry_id": entry.entry_id, **fields})


async def test_shared_updates_and_reload(
    hass: HomeAssistant, init_integration: MockConfigEntry, hass_ws_client: WebSocketGenerator
) -> None:
    """Two clients receive updates and data survives unloading and reloading."""
    first = await hass_ws_client()
    second = await hass_ws_client()
    for ws in (first, second):
        await _send(ws, init_integration, "subscribe")
        assert (await ws.receive_json())["success"]
        event = await ws.receive_json()
        assert event["event"]["data"]["revision"] == 0
        assert event["event"]["data"]["people"] == []

    await _send(
        first,
        init_integration,
        "set_person",
        calendar_entity="calendar.mock_calendar",
        approval_required=True,
        revision=0,
    )
    update = (await second.receive_json())["event"]["data"]
    assert update["revision"] == 1
    person = update["people"][0]
    assert person["calendar_entity"] == "calendar.mock_calendar"
    assert person["approval_required"] is True
    assert person["id"]
    assert (await first.receive_json())["event"]["data"] == update
    assert (await first.receive_json())["result"] == update

    assert await hass.config_entries.async_unload(init_integration.entry_id)
    assert (await first.receive_json())["event"]["available"] is False
    assert (await second.receive_json())["event"]["available"] is False
    await _send(first, init_integration, "get")
    assert (await first.receive_json())["error"]["code"] == "not_found"
    assert await hass.config_entries.async_setup(init_integration.entry_id)
    await _send(first, init_integration, "get")
    assert (await first.receive_json())["result"] == update
    await _send(
        first,
        init_integration,
        "set_person",
        person_id=person["id"],
        calendar_entity="calendar.mock_calendar",
        approval_required=False,
        revision=1,
    )
    updated = (await first.receive_json())["result"]
    assert updated["revision"] == 2
    assert updated["people"][0]["id"] == person["id"]
    assert updated["people"][0]["approval_required"] is False


async def test_invalid_calendar_and_stale_writes(
    init_integration: MockConfigEntry, hass_ws_client: WebSocketGenerator
) -> None:
    """Invalid calendars, stale revisions and duplicate links are rejected."""
    first, second = await asyncio.gather(hass_ws_client(), hass_ws_client())
    await _send(
        first, init_integration, "set_person", calendar_entity="calendar.other", approval_required=False, revision=0
    )
    assert not (await first.receive_json())["success"]
    await asyncio.gather(
        _send(
            first,
            init_integration,
            "set_person",
            calendar_entity="calendar.mock_calendar",
            approval_required=False,
            revision=0,
        ),
        _send(
            second,
            init_integration,
            "set_person",
            calendar_entity="calendar.mock_calendar",
            approval_required=True,
            revision=0,
        ),
    )
    results = await asyncio.gather(first.receive_json(), second.receive_json())
    assert sorted(result["success"] for result in results) == [False, True]
    failure = next(result for result in results if not result["success"])
    assert failure["error"]["code"] == "errands_conflict"
    await _send(
        first,
        init_integration,
        "set_person",
        calendar_entity="calendar.mock_calendar",
        approval_required=False,
        revision=1,
    )
    assert (await first.receive_json())["error"]["code"] == "errands_conflict"


async def test_failed_write_does_not_report_success(
    init_integration: MockConfigEntry, hass_ws_client: WebSocketGenerator
) -> None:
    """A storage write error is returned without publishing an update."""
    ws = await hass_ws_client()
    with patch("homeassistant.helpers.storage.Store._async_write_data", side_effect=WriteError("disk failure")):
        await _send(
            ws,
            init_integration,
            "set_person",
            calendar_entity="calendar.mock_calendar",
            approval_required=True,
            revision=0,
        )
        result = await ws.receive_json()
        assert result.get("error", {}).get("code") == "errands_storage_error", result
    await _send(ws, init_integration, "get")
    empty = (await ws.receive_json())["result"]
    assert empty["revision"] == 0
    assert empty["people"] == []
    await _send(
        ws,
        init_integration,
        "set_person",
        calendar_entity="calendar.mock_calendar",
        approval_required=True,
        revision=0,
    )
    assert (await ws.receive_json())["result"]["revision"] == 1
    await _send(ws, init_integration, "get")
    saved = (await ws.receive_json())["result"]
    with patch("homeassistant.helpers.storage.Store._async_write_data", side_effect=WriteError("disk failure")):
        await _send(
            ws,
            init_integration,
            "set_person",
            person_id=saved["people"][0]["id"],
            calendar_entity="calendar.mock_calendar",
            approval_required=False,
            revision=1,
        )
        assert (await ws.receive_json())["error"]["code"] == "errands_storage_error"
    await _send(ws, init_integration, "get")
    assert (await ws.receive_json())["result"] == saved


async def test_invalid_stored_data_does_not_disable_calendar(
    hass: HomeAssistant,
    config_entry: MockConfigEntry,
    hass_storage: dict[str, Any],
    hass_ws_client: WebSocketGenerator,
) -> None:
    """Keep the calendar available while refusing to overwrite invalid errands data."""
    key = f"{DOMAIN}.errands.{config_entry.entry_id}"
    invalid = {"version": 1, "data": {"revision": "bad", "people": []}}
    hass_storage[key] = invalid
    config_entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(config_entry.entry_id)
    await hass.async_block_till_done()
    assert hass.states.get("sensor.family_calendar_configuration") is not None
    ws = await hass_ws_client()
    await _send(ws, config_entry, "get")
    assert (await ws.receive_json())["error"]["code"] == "errands_storage_error"
    await _send(
        ws,
        config_entry,
        "set_person",
        calendar_entity="calendar.mock_calendar",
        approval_required=True,
        revision=0,
    )
    assert (await ws.receive_json())["error"]["code"] == "errands_storage_error"
    assert hass_storage[key] == invalid


async def test_unverified_write_blocks_changes_until_reload(
    hass: HomeAssistant, init_integration: MockConfigEntry, hass_ws_client: WebSocketGenerator
) -> None:
    """Do not overwrite a successful write if its verification read fails."""
    ws = await hass_ws_client()
    with patch("homeassistant.helpers.storage.Store.async_load", side_effect=HomeAssistantError("read failure")):
        await _send(
            ws,
            init_integration,
            "set_person",
            calendar_entity="calendar.mock_calendar",
            approval_required=True,
            revision=0,
        )
        assert (await ws.receive_json())["error"]["code"] == "errands_storage_error"
    await _send(ws, init_integration, "get")
    assert (await ws.receive_json())["error"]["code"] == "errands_storage_error"
    await _send(
        ws,
        init_integration,
        "set_person",
        calendar_entity="calendar.mock_calendar",
        approval_required=False,
        revision=0,
    )
    assert (await ws.receive_json())["error"]["code"] == "errands_storage_error"
    assert await hass.config_entries.async_unload(init_integration.entry_id)
    assert await hass.config_entries.async_setup(init_integration.entry_id)
    await _send(ws, init_integration, "get")
    recovered = (await ws.receive_json())["result"]
    assert recovered["revision"] == 1
    assert recovered["people"][0]["approval_required"] is True


async def test_person_can_be_hidden_without_losing_errands(
    hass: HomeAssistant, init_integration: MockConfigEntry, hass_ws_client: WebSocketGenerator
) -> None:
    """Keep the same person and approval rule when errands are hidden and re-enabled."""
    ws = await hass_ws_client()
    await _send(
        ws,
        init_integration,
        "set_person",
        calendar_entity="calendar.mock_calendar",
        approval_required=True,
        revision=0,
    )
    state = (await ws.receive_json())["result"]
    person = state["people"][0]
    assert person["enabled"] is True
    await _send(
        ws,
        init_integration,
        "apply",
        command="deduct",
        args={"person_id": person["id"], "stars": 2, "reason": "Reward"},
        revision=state["revision"],
        operation_id=uuid4().hex,
    )
    state = (await ws.receive_json())["result"]
    await _send(
        ws,
        init_integration,
        "set_person",
        person_id=person["id"],
        calendar_entity=person["calendar_entity"],
        approval_required=True,
        enabled=False,
        revision=state["revision"],
    )
    state = (await ws.receive_json())["result"]
    assert state["people"][0]["enabled"] is False
    assert await hass.config_entries.async_unload(init_integration.entry_id)
    assert await hass.config_entries.async_setup(init_integration.entry_id)
    await _send(ws, init_integration, "get")
    state = (await ws.receive_json())["result"]
    assert state["people"][0]["id"] == person["id"]
    assert state["people"][0]["enabled"] is False
    await _send(
        ws,
        init_integration,
        "set_person",
        person_id=person["id"],
        calendar_entity=person["calendar_entity"],
        approval_required=True,
        enabled=True,
        revision=state["revision"],
    )
    state = (await ws.receive_json())["result"]
    assert state["people"][0]["id"] == person["id"]
    assert state["people"][0]["enabled"] is True
    assert state["transactions"][0]["amount"] == -2


async def test_existing_person_defaults_to_visible(
    hass: HomeAssistant,
    config_entry: MockConfigEntry,
    hass_storage: dict[str, Any],
    hass_ws_client: WebSocketGenerator,
) -> None:
    """Load a person saved before the visibility setting was introduced."""
    key = f"{DOMAIN}.errands.{config_entry.entry_id}"
    hass_storage[key] = {
        "version": 1,
        "data": {
            "revision": 1,
            "people": [
                {
                    "id": "person",
                    "calendar_entity": "calendar.mock_calendar",
                    "calendar_registry_id": None,
                    "approval_required": True,
                }
            ],
        },
    }
    config_entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(config_entry.entry_id)
    ws = await hass_ws_client()
    await _send(ws, config_entry, "get")
    state = (await ws.receive_json())["result"]
    assert state["people"][0]["enabled"] is True
    assert state["rewards"] == []


async def test_invalid_recurring_occurrence_does_not_disable_calendar(
    hass: HomeAssistant,
    config_entry: MockConfigEntry,
    hass_storage: dict[str, Any],
    hass_ws_client: WebSocketGenerator,
) -> None:
    """Reject an invalid recurring occurrence without disabling the calendar."""
    key = f"{DOMAIN}.errands.{config_entry.entry_id}"
    invalid = {
        "version": 1,
        "data": {
            "revision": 1,
            "people": [
                {
                    "id": "person",
                    "calendar_entity": "calendar.mock_calendar",
                    "calendar_registry_id": None,
                    "approval_required": False,
                }
            ],
            "assignments": [
                {
                    "id": "assignment",
                    "person_id": "person",
                    "name": "Task",
                    "stars": 1,
                    "schedule": {"kind": "daily", "weekdays": []},
                    "due_date": None,
                    "start_date": "2026-01-01",
                    "active": True,
                }
            ],
            "occurrences": [
                {
                    "id": "occurrence",
                    "assignment_id": "assignment",
                    "person_id": "person",
                    "name": "Task",
                    "stars": 1,
                    "day": None,
                    "status": "open",
                }
            ],
        },
    }
    hass_storage[key] = invalid
    config_entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(config_entry.entry_id)
    await hass.async_block_till_done()
    assert hass.states.get("sensor.family_calendar_configuration") is not None
    ws = await hass_ws_client()
    await _send(ws, config_entry, "get")
    assert (await ws.receive_json())["error"]["code"] == "errands_storage_error"
    assert hass_storage[key] == invalid


async def test_unsubscribe_and_missing_person(
    init_integration: MockConfigEntry, hass_ws_client: WebSocketGenerator
) -> None:
    """Unsubscribed clients receive no updates and unknown IDs cannot be changed."""
    ws = await hass_ws_client()
    await _send(ws, init_integration, "subscribe")
    result = await ws.receive_json()
    subscription_id = result["id"]
    await ws.receive_json()
    await ws.send_json_auto_id({"type": "unsubscribe_events", "subscription": subscription_id})
    assert (await ws.receive_json())["success"]
    await _send(
        ws,
        init_integration,
        "set_person",
        person_id="missing",
        calendar_entity="calendar.mock_calendar",
        approval_required=False,
        revision=0,
    )
    assert (await ws.receive_json())["error"]["code"] == "errands_conflict"
    await _send(
        ws,
        init_integration,
        "set_person",
        calendar_entity="calendar.mock_calendar",
        approval_required=False,
        revision=0,
    )
    result = await ws.receive_json()
    assert result["type"] == "result"
    assert result["result"]["revision"] == 1


async def test_read_only_user_cannot_modify_people(
    init_integration: MockConfigEntry,
    hass_ws_client: WebSocketGenerator,
    hass_read_only_access_token: str,
) -> None:
    """Honor Home Assistant's read-only permissions while allowing reads."""
    ws = await hass_ws_client(access_token=hass_read_only_access_token)
    await _send(ws, init_integration, "get")
    assert (await ws.receive_json())["result"]["people"] == []
    await _send(
        ws,
        init_integration,
        "set_person",
        calendar_entity="calendar.mock_calendar",
        approval_required=True,
        revision=0,
    )
    assert (await ws.receive_json())["error"]["code"] == "unauthorized"


async def test_selected_read_only_user_remains_read_only(
    hass: HomeAssistant,
    config_entry: MockConfigEntry,
    hass_ws_client: WebSocketGenerator,
    hass_read_only_user: MockUser,
    hass_read_only_access_token: str,
) -> None:
    """Selecting a read-only login cannot grant calendar-control permissions."""
    config_entry.add_to_hass(hass)
    hass.config_entries.async_update_entry(
        config_entry, options={**config_entry.options, CONF_ERRAND_MANAGERS: [hass_read_only_user.id]}
    )
    assert await hass.config_entries.async_setup(config_entry.entry_id)
    ws = await hass_ws_client(access_token=hass_read_only_access_token)
    await _send(ws, config_entry, "subscribe")
    assert (await ws.receive_json())["success"]
    event = (await ws.receive_json())["event"]
    assert event["can_manage"] is False
    assert event["can_act"] is False
    await _send(
        ws, config_entry, "set_person", calendar_entity="calendar.mock_calendar", approval_required=True, revision=0
    )
    assert (await ws.receive_json())["error"]["code"] == "unauthorized"
