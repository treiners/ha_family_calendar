"""Tests for shared errands and star accounting."""

import asyncio
from typing import Any
from uuid import uuid4

import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry, MockUser, async_fire_time_changed
from pytest_homeassistant_custom_component.typing import MockHAClientWebSocket, WebSocketGenerator

from custom_components.kdev_family_calendar.const import CONF_CALENDARS, CONF_ERRAND_MANAGERS, DOMAIN
from homeassistant.auth.const import GROUP_ID_USER
from homeassistant.auth.models import Credentials
from homeassistant.core import HomeAssistant

# Home Assistant's HTTP middleware assigns a string key to aiohttp's request.
pytestmark = pytest.mark.filterwarnings(
    "ignore:It is recommended to use web.RequestKey instances for keys.:UserWarning"
)


async def _call(ws: MockHAClientWebSocket, entry: MockConfigEntry, endpoint: str, **fields: Any) -> dict[str, Any]:
    await ws.send_json_auto_id({"type": f"{DOMAIN}/errands/{endpoint}", "entry_id": entry.entry_id, **fields})
    return await ws.receive_json()


async def _apply(
    ws: MockHAClientWebSocket, entry: MockConfigEntry, state: dict[str, Any], command: str, **args: Any
) -> dict[str, Any]:
    result = await _call(
        ws, entry, "apply", command=command, args=args, revision=state["revision"], operation_id=uuid4().hex
    )
    assert result["success"], result
    return result["result"]


async def test_task_approval_deductions_and_corrections(
    hass: HomeAssistant, init_integration: MockConfigEntry, hass_ws_client: WebSocketGenerator
) -> None:
    """Keep transaction history consistent through approvals, retries and reversals."""
    ws = await hass_ws_client()
    result = await _call(
        ws, init_integration, "set_person", calendar_entity="calendar.mock_calendar", approval_required=True, revision=0
    )
    state = result["result"]
    person = state["people"][0]["id"]
    state = await _apply(ws, init_integration, state, "save_template", name="Tidy room", stars=3)
    template = state["templates"][0]
    state = await _apply(
        ws,
        init_integration,
        state,
        "assign",
        name=template["name"],
        stars=template["stars"],
        person_ids=[person],
        schedule={"kind": "once", "weekdays": []},
        due_date="2026-01-01",
    )
    task = state["occurrences"][0]["id"]
    state = await _apply(ws, init_integration, state, "complete", id=task)
    assert state["occurrences"][0]["status"] == "pending"
    assert not state["transactions"]
    state = await _apply(ws, init_integration, state, "approve", id=task)
    assert sum(item["amount"] for item in state["transactions"]) == 3
    duplicate = await _call(
        ws,
        init_integration,
        "apply",
        command="approve",
        args={"id": task},
        revision=state["revision"],
        operation_id=uuid4().hex,
    )
    assert not duplicate["success"]
    state = await _apply(ws, init_integration, state, "deduct", person_id=person, stars=5, reason="Reward")
    assert sum(item["amount"] for item in state["transactions"]) == -2
    state = await _apply(ws, init_integration, state, "undo_completion", id=task)
    assert sum(item["amount"] for item in state["transactions"]) == -5
    state = await _apply(ws, init_integration, state, "undo_deduction", id=state["transactions"][1]["id"])
    assert sum(item["amount"] for item in state["transactions"]) == 0
    assert await hass.config_entries.async_unload(init_integration.entry_id)
    assert await hass.config_entries.async_setup(init_integration.entry_id)
    assert (await _call(ws, init_integration, "get"))["result"] == state


async def test_errand_icons_persist_and_follow_open_occurrences(
    hass: HomeAssistant, init_integration: MockConfigEntry, hass_ws_client: WebSocketGenerator
) -> None:
    """Keep icons through assignment, edits, completion and reload."""
    ws = await hass_ws_client()
    state = (
        await _call(
            ws,
            init_integration,
            "set_person",
            calendar_entity="calendar.mock_calendar",
            approval_required=True,
            revision=0,
        )
    )["result"]
    person = state["people"][0]["id"]
    state = await _apply(
        ws, init_integration, state, "save_template", name="Pet", stars=2, icon="family_calendar:room_cleanup"
    )
    template = state["templates"][0]
    state = await _apply(
        ws,
        init_integration,
        state,
        "assign",
        name=template["name"],
        stars=template["stars"],
        icon=template["icon"],
        person_ids=[person],
        schedule={"kind": "once", "weekdays": []},
    )
    assignment = state["assignments"][0]["id"]
    occurrence = state["occurrences"][0]["id"]
    assert state["occurrences"][0]["icon"] == "family_calendar:room_cleanup"
    state = await _apply(
        ws,
        init_integration,
        state,
        "edit_assignment",
        id=assignment,
        name="Pet",
        stars=2,
        icon="mdi:dog",
        schedule={"kind": "once", "weekdays": []},
    )
    assert state["occurrences"][0]["icon"] == "mdi:dog"
    state = await _apply(
        ws,
        init_integration,
        state,
        "edit_assignment",
        id=assignment,
        name="Pet",
        stars=2,
        schedule={"kind": "once", "weekdays": []},
    )
    assert state["assignments"][0]["icon"] == "mdi:dog"
    assert state["occurrences"][0]["icon"] == "mdi:dog"
    state = await _apply(ws, init_integration, state, "complete", id=occurrence)
    state = await _apply(
        ws,
        init_integration,
        state,
        "edit_assignment",
        id=assignment,
        name="Pet",
        stars=2,
        icon=None,
        schedule={"kind": "once", "weekdays": []},
    )
    assert state["occurrences"][0]["icon"] == "mdi:dog"
    assert state["assignments"][0]["icon"] is None
    assert await hass.config_entries.async_unload(init_integration.entry_id)
    assert await hass.config_entries.async_setup(init_integration.entry_id)
    assert (await _call(ws, init_integration, "get"))["result"] == state
    invalid = await _call(
        ws,
        init_integration,
        "apply",
        command="save_template",
        args={"name": "Bad", "stars": 1, "icon": "bad"},
        revision=state["revision"],
        operation_id=uuid4().hex,
    )
    assert invalid["error"]["code"] == "errands_conflict"


async def test_rewards_are_shared_fixed_and_history_survives_edits(
    hass: HomeAssistant, init_integration: MockConfigEntry, hass_ws_client: WebSocketGenerator
) -> None:
    """Reward redemption uses the saved price, preserves history, and survives reload."""
    ws = await hass_ws_client()
    state = (
        await _call(
            ws,
            init_integration,
            "set_person",
            calendar_entity="calendar.mock_calendar",
            approval_required=False,
            revision=0,
        )
    )["result"]
    person = state["people"][0]["id"]
    state = await _apply(ws, init_integration, state, "save_reward", name="30 min TV", stars=5)
    reward_id = state["rewards"][0]["id"]
    assert await hass.config_entries.async_unload(init_integration.entry_id)
    assert await hass.config_entries.async_setup(init_integration.entry_id)
    assert (await _call(ws, init_integration, "get"))["result"] == state
    stale_revision = state["revision"]
    state = await _apply(ws, init_integration, state, "save_reward", id=reward_id, name="New book", stars=8)
    stale = await _call(
        ws,
        init_integration,
        "apply",
        command="redeem_reward",
        args={"person_id": person, "reward_id": reward_id},
        revision=stale_revision,
        operation_id=uuid4().hex,
    )
    assert stale["error"]["code"] == "errands_conflict"
    tampered = await _call(
        ws,
        init_integration,
        "apply",
        command="redeem_reward",
        args={"person_id": person, "reward_id": reward_id, "stars": 1},
        revision=state["revision"],
        operation_id=uuid4().hex,
    )
    assert not tampered["success"]
    request = {
        "command": "redeem_reward",
        "args": {"person_id": person, "reward_id": reward_id},
        "revision": state["revision"],
        "operation_id": uuid4().hex,
    }
    state = (await _call(ws, init_integration, "apply", **request))["result"]
    assert (await _call(ws, init_integration, "apply", **request))["result"] == state
    transaction = state["transactions"][0]
    assert (transaction["reason"], transaction["amount"]) == ("New book", -8)
    state = await _apply(ws, init_integration, state, "delete_reward", id=reward_id)
    assert state["rewards"] == []
    assert state["transactions"][0] == transaction
    state = await _apply(ws, init_integration, state, "undo_deduction", id=transaction["id"])
    assert sum(item["amount"] for item in state["transactions"]) == 0
    assert await hass.config_entries.async_unload(init_integration.entry_id)
    assert await hass.config_entries.async_setup(init_integration.entry_id)
    assert (await _call(ws, init_integration, "get"))["result"] == state


async def test_deduction_retry_is_idempotent(
    init_integration: MockConfigEntry, hass_ws_client: WebSocketGenerator
) -> None:
    """A lost response and repeated request cannot spend stars twice."""
    ws = await hass_ws_client()
    state = (
        await _call(
            ws,
            init_integration,
            "set_person",
            calendar_entity="calendar.mock_calendar",
            approval_required=False,
            revision=0,
        )
    )["result"]
    fields = {
        "command": "deduct",
        "args": {"person_id": state["people"][0]["id"], "stars": 2, "reason": "Reward"},
        "revision": state["revision"],
        "operation_id": uuid4().hex,
    }
    first = await _call(ws, init_integration, "apply", **fields)
    second = await _call(ws, init_integration, "apply", **fields)
    assert first["result"] == second["result"]
    assert len(second["result"]["transactions"]) == 1
    fields["args"]["stars"] = 3
    assert not (await _call(ws, init_integration, "apply", **fields))["success"]


async def test_concurrent_retries_apply_once(
    init_integration: MockConfigEntry, hass_ws_client: WebSocketGenerator
) -> None:
    """Concurrent clients using the same operation ID cannot double deduct."""
    first, second = await asyncio.gather(hass_ws_client(), hass_ws_client())
    state = (
        await _call(
            first,
            init_integration,
            "set_person",
            calendar_entity="calendar.mock_calendar",
            approval_required=False,
            revision=0,
        )
    )["result"]
    fields = {
        "command": "deduct",
        "args": {"person_id": state["people"][0]["id"], "stars": 2, "reason": "Reward"},
        "revision": state["revision"],
        "operation_id": uuid4().hex,
    }
    results = await asyncio.gather(
        _call(first, init_integration, "apply", **fields),
        _call(second, init_integration, "apply", **fields),
    )
    assert all(result["success"] for result in results)
    assert len(results[0]["result"]["transactions"]) == 1
    assert results[0]["result"] == results[1]["result"]


async def test_read_only_cannot_modify_tasks(
    init_integration: MockConfigEntry, hass_ws_client: WebSocketGenerator, hass_read_only_access_token: str
) -> None:
    """Read-only Home Assistant users cannot change shared tasks."""
    admin = await hass_ws_client()
    state = (
        await _call(
            admin,
            init_integration,
            "set_person",
            calendar_entity="calendar.mock_calendar",
            approval_required=False,
            revision=0,
        )
    )["result"]
    readonly = await hass_ws_client(access_token=hass_read_only_access_token)
    result = await _call(
        readonly,
        init_integration,
        "apply",
        command="deduct",
        args={"person_id": state["people"][0]["id"], "stars": 1, "reason": "Reward"},
        revision=state["revision"],
        operation_id=uuid4().hex,
    )
    assert result["error"]["code"] == "unauthorized"
    assert not (await _call(admin, init_integration, "get"))["result"]["transactions"]


async def test_manager_and_family_member_permissions(
    hass: HomeAssistant, config_entry: MockConfigEntry, hass_ws_client: WebSocketGenerator
) -> None:
    """Enforce manager permissions even when clients send direct requests."""
    group = await hass.auth.async_get_group(GROUP_ID_USER)
    manager = MockUser(name="Manager", groups=[group]).add_to_hass(hass)
    child = MockUser(name="Child", groups=[group]).add_to_hass(hass)

    async def client_for(user: MockUser) -> MockHAClientWebSocket:
        credential = Credentials(
            id=uuid4().hex,
            auth_provider_type="homeassistant",
            auth_provider_id=None,
            data={"username": user.name},
            is_new=False,
        )
        user.credentials.append(credential)
        refresh = await hass.auth.async_create_refresh_token(user, "http://example.com", credential=credential)
        return await hass_ws_client(access_token=hass.auth.async_create_access_token(refresh))

    config_entry.add_to_hass(hass)
    hass.config_entries.async_update_entry(
        config_entry, options={**config_entry.options, CONF_ERRAND_MANAGERS: [manager.id]}
    )
    assert await hass.config_entries.async_setup(config_entry.entry_id)
    await hass.async_block_till_done()
    sensor = hass.states.get("sensor.family_calendar_configuration")
    assert sensor is not None
    assert CONF_ERRAND_MANAGERS not in sensor.attributes["defaults"]
    admin = await hass_ws_client()
    manager_ws = await client_for(manager)
    child_ws = await client_for(child)
    state = (
        await _call(
            admin,
            config_entry,
            "set_person",
            calendar_entity="calendar.mock_calendar",
            approval_required=True,
            revision=0,
        )
    )["result"]
    person = state["people"][0]["id"]
    state = await _apply(
        manager_ws,
        config_entry,
        state,
        "assign",
        name="Tidy",
        stars=2,
        person_ids=[person],
        schedule={"kind": "once", "weekdays": []},
    )
    task = state["occurrences"][0]["id"]
    for ws, expected in ((manager_ws, True), (child_ws, False)):
        await ws.send_json_auto_id({"type": f"{DOMAIN}/errands/subscribe", "entry_id": config_entry.entry_id})
        result = await ws.receive_json()
        assert result["success"]
        event = (await ws.receive_json())["event"]
        assert event["can_manage"] is expected
        assert event["can_act"] is True
        await ws.send_json_auto_id({"type": "unsubscribe_events", "subscription": result["id"]})
        assert (await ws.receive_json())["success"]

    for command in (
        "approve",
        "undo_completion",
        "save_template",
        "delete_template",
        "save_reward",
        "delete_reward",
        "assign",
        "edit_assignment",
        "delete_assignment",
        "undo_deduction",
    ):
        denied = await _call(
            child_ws,
            config_entry,
            "apply",
            command=command,
            args={"id": task},
            revision=state["revision"],
            operation_id=uuid4().hex,
        )
        assert denied["error"]["code"] == "unauthorized"
    denied = await _call(
        child_ws,
        config_entry,
        "set_person",
        calendar_entity="calendar.mock_calendar",
        approval_required=False,
        revision=state["revision"],
    )
    assert denied["error"]["code"] == "unauthorized"
    state = await _apply(child_ws, config_entry, state, "complete", id=task)
    assert state["occurrences"][0]["status"] == "pending"
    state = await _apply(manager_ws, config_entry, state, "approve", id=task)
    state = await _apply(manager_ws, config_entry, state, "save_reward", name="TV", stars=3)
    state = await _apply(
        child_ws, config_entry, state, "redeem_reward", person_id=person, reward_id=state["rewards"][0]["id"]
    )
    state = await _apply(child_ws, config_entry, state, "deduct", person_id=person, stars=1, reason="Reward")
    assert sum(item["amount"] for item in state["transactions"]) == -2
    hass.config_entries.async_update_entry(config_entry, options={**config_entry.options, CONF_ERRAND_MANAGERS: []})
    await hass.async_block_till_done()
    denied = await _call(
        manager_ws,
        config_entry,
        "apply",
        command="undo_completion",
        args={"id": task},
        revision=state["revision"],
        operation_id=uuid4().hex,
    )
    assert denied["error"]["code"] == "unauthorized"


async def test_multiple_people_receive_independent_tasks(
    hass: HomeAssistant, init_integration: MockConfigEntry, hass_ws_client: WebSocketGenerator
) -> None:
    """Assigning to two people keeps their completion and balances separate."""
    hass.config_entries.async_update_entry(
        init_integration,
        options={**init_integration.options, CONF_CALENDARS: ["calendar.mock_calendar", "calendar.second"]},
    )
    ws = await hass_ws_client()
    state = (
        await _call(
            ws,
            init_integration,
            "set_person",
            calendar_entity="calendar.mock_calendar",
            approval_required=False,
            revision=0,
        )
    )["result"]
    state = (
        await _call(
            ws,
            init_integration,
            "set_person",
            calendar_entity="calendar.second",
            approval_required=False,
            revision=state["revision"],
        )
    )["result"]
    ids = [person["id"] for person in state["people"]]
    state = await _apply(
        ws,
        init_integration,
        state,
        "assign",
        name="Homework",
        stars=2,
        person_ids=ids,
        schedule={"kind": "once", "weekdays": []},
    )
    assert len(state["assignments"]) == len(state["occurrences"]) == 2
    state = await _apply(ws, init_integration, state, "complete", id=state["occurrences"][0]["id"])
    assert state["transactions"][0]["person_id"] == ids[0]
    assert state["occurrences"][1]["status"] == "open"


async def test_edit_one_off_and_preserve_pending_history(
    init_integration: MockConfigEntry, hass_ws_client: WebSocketGenerator
) -> None:
    """Changes update an open task without rewriting a completed occurrence."""
    ws = await hass_ws_client()
    state = (
        await _call(
            ws,
            init_integration,
            "set_person",
            calendar_entity="calendar.mock_calendar",
            approval_required=True,
            revision=0,
        )
    )["result"]
    schedule = {"kind": "once", "weekdays": []}
    state = await _apply(
        ws,
        init_integration,
        state,
        "assign",
        name="Original",
        stars=1,
        person_ids=[state["people"][0]["id"]],
        schedule=schedule,
    )
    assignment = state["assignments"][0]["id"]
    state = await _apply(
        ws,
        init_integration,
        state,
        "edit_assignment",
        id=assignment,
        name="Updated",
        stars=3,
        schedule=schedule,
        due_date="2026-12-01",
    )
    occurrence = state["occurrences"][0]
    assert (occurrence["name"], occurrence["stars"], occurrence["day"]) == ("Updated", 3, "2026-12-01")
    state = await _apply(ws, init_integration, state, "complete", id=occurrence["id"])
    state = await _apply(
        ws, init_integration, state, "edit_assignment", id=assignment, name="Later", stars=5, schedule=schedule
    )
    assert state["occurrences"][0]["name"] == "Updated"
    assert state["occurrences"][0]["stars"] == 3
    assert state["occurrences"][0]["day"] == "2026-12-01"
    assert state["occurrences"][0]["status"] == "pending"


@pytest.mark.freeze_time("2026-03-07 12:00:00+00:00")
async def test_recurring_missed_and_pending_tasks(
    freezer: Any, init_integration: MockConfigEntry, hass_ws_client: WebSocketGenerator
) -> None:
    """At midnight, preserve pending tasks and replace uncompleted ones."""
    ws = await hass_ws_client()
    state = (
        await _call(
            ws,
            init_integration,
            "set_person",
            calendar_entity="calendar.mock_calendar",
            approval_required=True,
            revision=0,
        )
    )["result"]
    person = state["people"][0]["id"]
    state = await _apply(
        ws,
        init_integration,
        state,
        "assign",
        name="Feed pet",
        stars=1,
        person_ids=[person],
        schedule={"kind": "daily", "weekdays": []},
    )
    first = state["occurrences"][0]["id"]
    state = await _apply(ws, init_integration, state, "complete", id=first)
    freezer.move_to("2026-03-08 12:00:00+00:00")
    state = (await _call(ws, init_integration, "get"))["result"]
    state = await _apply(ws, init_integration, state, "save_template", name="Example", stars=1)
    assert [item["status"] for item in state["occurrences"]] == ["pending", "open"]
    freezer.move_to("2026-03-09 12:00:00+00:00")
    state = (await _call(ws, init_integration, "get"))["result"]
    state = await _apply(ws, init_integration, state, "save_template", name="Example 2", stars=1)
    assert [item["status"] for item in state["occurrences"]] == ["pending", "missed", "open"]
    state = await _apply(ws, init_integration, state, "approve", id=first)
    assert sum(item["amount"] for item in state["transactions"]) == 1


@pytest.mark.freeze_time("2026-03-02 12:00:00+00:00")
async def test_weekly_replacement_and_edit(
    freezer: Any, init_integration: MockConfigEntry, hass_ws_client: WebSocketGenerator
) -> None:
    """Keep a weekly task until the next occurrence and preserve completed history."""
    ws = await hass_ws_client()
    state = (
        await _call(
            ws,
            init_integration,
            "set_person",
            calendar_entity="calendar.mock_calendar",
            approval_required=True,
            revision=0,
        )
    )["result"]
    person = state["people"][0]["id"]
    state = await _apply(
        ws,
        init_integration,
        state,
        "assign",
        name="Bins",
        stars=1,
        person_ids=[person],
        schedule={"kind": "weekly", "weekdays": [0]},
    )
    assignment = state["assignments"][0]["id"]
    freezer.move_to("2026-03-03 12:00:00+00:00")
    state = (await _call(ws, init_integration, "get"))["result"]
    assert state["occurrences"][0]["status"] == "open"
    state = await _apply(
        ws,
        init_integration,
        state,
        "edit_assignment",
        id=assignment,
        name="Updated bins",
        stars=2,
        schedule={"kind": "weekly", "weekdays": [0]},
    )
    assert state["occurrences"][0]["status"] == "open"
    assert state["occurrences"][0]["name"] == "Updated bins"
    assert state["occurrences"][0]["stars"] == 2
    freezer.move_to("2026-03-09 12:00:00+00:00")
    state = (await _call(ws, init_integration, "get"))["result"]
    assert [item["status"] for item in state["occurrences"]] == ["missed", "open"]
    state = await _apply(ws, init_integration, state, "complete", id=state["occurrences"][1]["id"])
    state = await _apply(
        ws,
        init_integration,
        state,
        "edit_assignment",
        id=assignment,
        name="New bins",
        stars=5,
        schedule={"kind": "weekly", "weekdays": [0]},
    )
    assert state["occurrences"][1]["name"] == "Updated bins"
    assert state["occurrences"][1]["stars"] == 2
    state = await _apply(ws, init_integration, state, "delete_assignment", id=assignment)
    assert state["occurrences"][1]["status"] == "pending"
    state = await _apply(ws, init_integration, state, "approve", id=state["occurrences"][1]["id"])
    state = await _apply(ws, init_integration, state, "undo_completion", id=state["occurrences"][1]["id"])
    assert state["occurrences"][1]["status"] == "cancelled"
    assert sum(item["amount"] for item in state["transactions"]) == 0


@pytest.mark.freeze_time("2026-03-28 22:30:00+00:00")
async def test_midnight_and_daylight_saving(
    hass: HomeAssistant, config_entry: MockConfigEntry, freezer: Any, hass_ws_client: WebSocketGenerator
) -> None:
    """Create the next occurrence at local midnight across the spring clock change."""
    await hass.config.async_set_time_zone("Europe/Berlin")
    config_entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(config_entry.entry_id)
    ws = await hass_ws_client()
    state = (
        await _call(
            ws,
            config_entry,
            "set_person",
            calendar_entity="calendar.mock_calendar",
            approval_required=False,
            revision=0,
        )
    )["result"]
    state = await _apply(
        ws,
        config_entry,
        state,
        "assign",
        name="Task",
        stars=1,
        person_ids=[state["people"][0]["id"]],
        schedule={"kind": "daily", "weekdays": []},
    )
    assert state["occurrences"][0]["day"] == "2026-03-28"
    freezer.move_to("2026-03-28 23:00:01+00:00")
    async_fire_time_changed(hass)
    await hass.async_block_till_done()
    state = (await _call(ws, config_entry, "get"))["result"]
    assert [item["day"] for item in state["occurrences"]] == ["2026-03-28", "2026-03-29"]
    freezer.move_to("2026-03-29 22:00:01+00:00")
    async_fire_time_changed(hass)
    await hass.async_block_till_done()
    state = (await _call(ws, config_entry, "get"))["result"]
    assert state["occurrences"][-1]["day"] == "2026-03-30"
