"""WebSocket commands for shared family errands."""

from typing import TYPE_CHECKING, Any, cast

import voluptuous as vol

from custom_components.kdev_family_calendar.const import CONF_CALENDARS, CONF_ERRAND_MANAGERS, DOMAIN
from homeassistant.auth.permissions.const import POLICY_CONTROL, POLICY_READ
from homeassistant.components import websocket_api
from homeassistant.components.websocket_api.connection import ActiveConnection
from homeassistant.components.websocket_api.const import ERR_INVALID_FORMAT, ERR_NOT_FOUND, ERR_UNAUTHORIZED
from homeassistant.components.websocket_api.decorators import async_response, websocket_command
from homeassistant.config_entries import ConfigEntryState
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import entity_registry as er

if TYPE_CHECKING:
    from custom_components.kdev_family_calendar.data import KdevFamilyCalendarConfigEntry

_BASE = {vol.Required("entry_id"): str}


@callback
def async_register_commands(hass: HomeAssistant) -> None:
    """Register commands once when the integration is set up."""
    websocket_api.async_register_command(hass, _get)
    websocket_api.async_register_command(hass, _subscribe)
    websocket_api.async_register_command(hass, _set_person)
    websocket_api.async_register_command(hass, _apply)


@callback
def _entry(
    hass: HomeAssistant, connection: ActiveConnection, msg: dict[str, Any]
) -> KdevFamilyCalendarConfigEntry | None:
    entry = hass.config_entries.async_get_entry(msg["entry_id"])
    if entry is None or entry.domain != DOMAIN or entry.state is not ConfigEntryState.LOADED:
        connection.send_error(msg["id"], ERR_NOT_FOUND, "Family Calendar is not loaded.")
        return None
    family_entry = cast("KdevFamilyCalendarConfigEntry", entry)
    if family_entry.runtime_data.errands is None or not family_entry.runtime_data.errands.available:
        connection.send_error(msg["id"], "errands_storage_error", "Errands storage is unavailable; check the logs.")
        return None
    if not _can_read(connection, family_entry.runtime_data.errands.async_snapshot()):
        connection.send_error(msg["id"], ERR_UNAUTHORIZED, "Not allowed to view all family calendars.")
        return None
    return family_entry


@callback
def _can_read(connection: ActiveConnection, state: dict[str, Any]) -> bool:
    return all(
        connection.user.permissions.check_entity(person["calendar_entity"], POLICY_READ) for person in state["people"]
    )


@callback
def _can_act(connection: ActiveConnection, entry: KdevFamilyCalendarConfigEntry, state: dict[str, Any]) -> bool:
    calendars = [person["calendar_entity"] for person in state["people"]] or entry.options.get(CONF_CALENDARS, [])
    return all(connection.user.permissions.check_entity(calendar, POLICY_CONTROL) for calendar in calendars)


@callback
def _can_manage(connection: ActiveConnection, entry: KdevFamilyCalendarConfigEntry, state: dict[str, Any]) -> bool:
    return _can_act(connection, entry, state) and (
        connection.user.is_admin or connection.user.id in entry.options.get(CONF_ERRAND_MANAGERS, [])
    )


@websocket_command({vol.Required("type"): f"{DOMAIN}/errands/get", **_BASE})
@callback
def _get(hass: HomeAssistant, connection: ActiveConnection, msg: dict[str, Any]) -> None:
    """Return shared errands data."""
    if entry := _entry(hass, connection, msg):
        store = entry.runtime_data.errands
        if store is not None:
            connection.send_result(msg["id"], store.async_snapshot())


@websocket_command({vol.Required("type"): f"{DOMAIN}/errands/subscribe", **_BASE})
@callback
def _subscribe(hass: HomeAssistant, connection: ActiveConnection, msg: dict[str, Any]) -> None:
    """Subscribe to shared data and receive an initial snapshot."""
    if not (entry := _entry(hass, connection, msg)):
        return
    store = entry.runtime_data.errands
    if store is None:
        connection.send_error(msg["id"], "errands_storage_error", "Errands storage is unavailable.")
        return

    @callback
    def update(state: dict[str, Any] | None) -> None:
        if state is not None and not _can_read(connection, state):
            connection.send_event(msg["id"], {"available": False, "error": ERR_UNAUTHORIZED})
        else:
            connection.send_event(
                msg["id"],
                {
                    "available": state is not None,
                    "data": state,
                    "can_act": state is not None and _can_act(connection, entry, state),
                    "can_manage": state is not None and _can_manage(connection, entry, state),
                },
            )

    connection.subscriptions[msg["id"]] = store.async_subscribe(update)
    connection.send_result(msg["id"])
    state = store.async_snapshot()
    connection.send_event(
        msg["id"],
        {
            "available": True,
            "data": state,
            "can_act": _can_act(connection, entry, state),
            "can_manage": _can_manage(connection, entry, state),
        },
    )


@websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/errands/set_person",
        **_BASE,
        vol.Optional("person_id"): vol.All(str, vol.Length(min=1)),
        vol.Required("calendar_entity"): vol.All(str, vol.Length(min=1)),
        vol.Required("approval_required"): bool,
        vol.Optional("enabled"): bool,
        vol.Required("revision"): vol.All(int, vol.Range(min=0)),
    }
)
@async_response
async def _set_person(hass: HomeAssistant, connection: ActiveConnection, msg: dict[str, Any]) -> None:
    """Add or update a person's calendar and approval rule."""
    if not (entry := _entry(hass, connection, msg)):
        return
    store = entry.runtime_data.errands
    if store is None:
        connection.send_error(msg["id"], "errands_storage_error", "Errands storage is unavailable.")
        return
    if not _can_manage(connection, entry, store.async_snapshot()):
        connection.send_error(msg["id"], ERR_UNAUTHORIZED, "Not allowed to manage errands.")
        return
    calendar = msg["calendar_entity"]
    if calendar not in entry.options.get(CONF_CALENDARS, []):
        connection.send_error(msg["id"], ERR_INVALID_FORMAT, "Calendar is not selected in Family Calendar.")
        return
    if not connection.user.permissions.check_entity(calendar, POLICY_CONTROL):
        connection.send_error(msg["id"], ERR_UNAUTHORIZED, "Not allowed to change this calendar's errands.")
        return
    registry_entry = er.async_get(hass).async_get(calendar)
    existing = next(
        (person for person in store.async_snapshot()["people"] if person["id"] == msg.get("person_id")), None
    )
    if existing and not connection.user.permissions.check_entity(existing["calendar_entity"], POLICY_CONTROL):
        connection.send_error(msg["id"], ERR_UNAUTHORIZED, "Not allowed to change this person's errands.")
        return
    try:
        state = await store.async_set_person(
            msg.get("person_id"),
            calendar,
            registry_entry.id if registry_entry else None,
            msg["approval_required"],
            msg.get("enabled"),
            msg["revision"],
        )
    except ValueError as err:
        connection.send_error(msg["id"], "errands_conflict", str(err))
        return
    except RuntimeError as err:
        connection.send_error(msg["id"], "errands_storage_error", str(err))
        return
    connection.send_result(msg["id"], state)


@websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/errands/apply",
        **_BASE,
        vol.Required("command"): str,
        vol.Required("args"): dict,
        vol.Required("revision"): vol.All(int, vol.Range(min=0)),
        vol.Required("operation_id"): vol.All(str, vol.Length(min=1, max=64)),
    }
)
@async_response
async def _apply(hass: HomeAssistant, connection: ActiveConnection, msg: dict[str, Any]) -> None:
    """Apply a shared errands operation."""
    if not (entry := _entry(hass, connection, msg)):
        return
    store = entry.runtime_data.errands
    if store is None:
        connection.send_error(msg["id"], "errands_storage_error", "Errands storage is unavailable.")
        return

    @callback
    def authorized(state: dict[str, Any]) -> bool:
        return (
            _can_read(connection, state)
            and _can_act(connection, entry, state)
            and (msg["command"] in ("complete", "deduct") or _can_manage(connection, entry, state))
        )

    try:
        result = await store.async_apply(msg["command"], msg["args"], msg["revision"], msg["operation_id"], authorized)
    except PermissionError as err:
        connection.send_error(msg["id"], ERR_UNAUTHORIZED, str(err))
        return
    except (ValueError, vol.Invalid) as err:
        connection.send_error(msg["id"], "errands_conflict", str(err))
        return
    except RuntimeError as err:
        connection.send_error(msg["id"], "errands_storage_error", str(err))
        return
    connection.send_result(msg["id"], result)
