"""Persistent shared state for family errands."""

import asyncio
from collections.abc import Callable
from copy import deepcopy
from datetime import date, datetime
import hashlib
import json
from pathlib import Path
from typing import Any, cast
from uuid import uuid4

import voluptuous as vol

from custom_components.kdev_family_calendar.const import DOMAIN
from homeassistant.const import EVENT_HOMEASSISTANT_STOP
from homeassistant.core import CoreState, HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.event import async_track_time_change
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util

from .errands_model import apply_command, reconcile, validate_schedule

_PERSON_SCHEMA = vol.Schema(
    {
        vol.Required("id"): vol.All(str, vol.Length(min=1)),
        vol.Required("calendar_entity"): vol.All(str, vol.Length(min=1)),
        vol.Required("calendar_registry_id"): vol.Any(None, str),
        vol.Required("approval_required"): bool,
        vol.Optional("enabled", default=True): bool,
    }
)
_TEMPLATE_SCHEMA = vol.Schema(
    {vol.Required("id"): str, vol.Required("name"): str, vol.Required("stars"): vol.All(int, vol.Range(min=1))}
)
_ASSIGNMENT_SCHEMA = vol.Schema(
    {
        vol.Required("id"): str,
        vol.Required("person_id"): str,
        vol.Required("name"): str,
        vol.Required("stars"): vol.All(int, vol.Range(min=1)),
        vol.Required("schedule"): {
            vol.Required("kind"): vol.In(("once", "daily", "weekly")),
            vol.Required("weekdays"): [vol.All(int, vol.Range(min=0, max=6))],
        },
        vol.Required("due_date"): vol.Any(None, str),
        vol.Required("start_date"): str,
        vol.Required("active"): bool,
    }
)
_OCCURRENCE_SCHEMA = vol.Schema(
    {
        vol.Required("id"): str,
        vol.Required("assignment_id"): str,
        vol.Required("person_id"): str,
        vol.Required("name"): str,
        vol.Required("stars"): vol.All(int, vol.Range(min=1)),
        vol.Required("day"): vol.Any(None, str),
        vol.Required("status"): vol.In(("open", "pending", "completed", "missed", "cancelled")),
    }
)
_TRANSACTION_SCHEMA = vol.Schema(
    {
        vol.Required("id"): str,
        vol.Required("person_id"): str,
        vol.Required("amount"): int,
        vol.Required("kind"): vol.In(("award", "reversal", "deduction", "deduction_reversal")),
        vol.Required("reference"): str,
        vol.Required("reason"): str,
        vol.Required("created_at"): str,
    }
)
_STATE_SCHEMA = vol.Schema(
    {
        vol.Required("revision"): vol.All(int, vol.Range(min=0)),
        vol.Required("people"): [_PERSON_SCHEMA],
        vol.Optional("templates", default=list): [_TEMPLATE_SCHEMA],
        vol.Optional("assignments", default=list): [_ASSIGNMENT_SCHEMA],
        vol.Optional("occurrences", default=list): [_OCCURRENCE_SCHEMA],
        vol.Optional("transactions", default=list): [_TRANSACTION_SCHEMA],
        vol.Optional("operations", default=dict): {str: str},
    }
)


class KdevFamilyCalendarErrandsStore:
    """Keep family data consistent across connected clients."""

    def __init__(self, hass: HomeAssistant, entry_id: str) -> None:
        """Create an entry-scoped, atomically written store."""
        self._hass = hass
        self._store: Store[dict[str, Any]] = Store(
            hass, 1, f"{DOMAIN}.errands.{entry_id}", private=True, atomic_writes=True
        )
        self._lock = asyncio.Lock()
        self._state: dict[str, Any] = {
            "revision": 0,
            "people": [],
            "templates": [],
            "assignments": [],
            "occurrences": [],
            "transactions": [],
            "operations": {},
        }
        self._listeners: set[Callable[[dict[str, Any] | None], None]] = set()
        self._closed = False
        self._cancel_rollover: Callable[[], None] | None = None
        self._cancel_stop_listener: Callable[[], None] | None = None

    async def async_load(self) -> None:
        """Load and validate persisted data without overwriting corrupt data."""
        existed = await self._hass.async_add_executor_job(self._store_path_exists)
        data = await self._store.async_load()
        if data is None:
            if existed:
                raise ValueError("Errands storage could not be loaded; restore it from a backup.")
            return
        self._state = cast("dict[str, Any]", _STATE_SCHEMA(data))
        people = self._state["people"]
        if len({person["id"] for person in people}) != len(people):
            raise ValueError("Errands storage contains duplicate person IDs.")
        for collection in ("templates", "assignments", "occurrences", "transactions"):
            records = self._state[collection]
            if len({item["id"] for item in records}) != len(records):
                raise ValueError(f"Errands storage contains duplicate {collection} IDs.")
        person_ids = {person["id"] for person in people}
        assignments = {item["id"]: item for item in self._state["assignments"]}
        for item in assignments.values():
            if item["person_id"] not in person_ids:
                raise ValueError("Errands storage references an unknown person.")
            date.fromisoformat(item["start_date"])
            validate_schedule(item["schedule"], item["due_date"])
        for item in self._state["occurrences"]:
            assignment = assignments.get(item["assignment_id"])
            if assignment is None or item["person_id"] != assignment["person_id"]:
                raise ValueError("Errands storage references an invalid assignment.")
            if assignment["schedule"]["kind"] != "once" and item["day"] is None:
                raise ValueError("A recurring occurrence has no scheduled day.")
            if item["day"] is not None:
                date.fromisoformat(item["day"])
        if any(item["person_id"] not in person_ids for item in self._state["transactions"]):
            raise ValueError("Star history references an unknown person.")

    def _store_path_exists(self) -> bool:
        return Path(self._store.path).exists()

    @callback
    def async_snapshot(self) -> dict[str, Any]:
        """Return a copy of the current data."""
        return deepcopy(self._state)

    @property
    def available(self) -> bool:
        """Report whether stored state can be safely accessed."""
        return not self._closed

    async def async_start(self) -> None:
        """Reconcile missed midnight transitions and schedule future transitions."""
        await self._async_rollover(dt_util.now())
        if self._hass.state in (CoreState.stopping, CoreState.final_write, CoreState.stopped):
            self._closed = True
            return
        self._cancel_rollover = async_track_time_change(self._hass, self._async_rollover, hour=0, minute=0, second=0)
        self._cancel_stop_listener = self._hass.bus.async_listen_once(EVENT_HOMEASSISTANT_STOP, self._stop_rollover)

    @callback
    def _stop_rollover(self, _event: Any) -> None:
        if self._cancel_rollover is not None:
            self._cancel_rollover()
            self._cancel_rollover = None

    async def _async_rollover(self, now: datetime) -> None:
        async with self._lock:
            if self._closed:
                return
            state = self.async_snapshot()
            if reconcile(state, now.date()):
                await self._async_commit(state)

    async def _async_commit(self, state: dict[str, Any]) -> dict[str, Any]:
        state["revision"] += 1
        await self._store.async_save(state)
        if self._hass.state is CoreState.stopping:
            raise RuntimeError("Home Assistant is stopping; the save could not be confirmed.")
        try:
            saved = await self._store.async_load()
        except (HomeAssistantError, OSError) as err:
            self._mark_unavailable()
            raise RuntimeError("Errands save could not be verified; reload the integration.") from err
        if saved != state:
            if saved != self._state and not (saved is None and self._state["revision"] == 0):
                self._mark_unavailable()
            raise RuntimeError("Errands data could not be saved; check Home Assistant logs.")
        self._state = state
        for listener in tuple(self._listeners):
            listener(self.async_snapshot())
        return self.async_snapshot()

    @callback
    def _mark_unavailable(self) -> None:
        self._closed = True
        for listener in tuple(self._listeners):
            listener(None)

    async def async_apply(
        self,
        command: str,
        args: dict[str, Any],
        expected_revision: int,
        operation_id: str,
        authorized: Callable[[dict[str, Any]], bool],
    ) -> dict[str, Any]:
        """Apply and persist one validated operation atomically."""
        async with self._lock:
            if self._closed or self._hass.state is CoreState.stopping:
                raise RuntimeError("Errands storage is unavailable.")
            if not authorized(self._state):
                raise PermissionError("Not allowed to change family errands.")
            digest = hashlib.sha256(
                json.dumps([command, args], sort_keys=True, separators=(",", ":")).encode()
            ).hexdigest()
            existing = self._state["operations"].get(operation_id)
            if existing is not None:
                if existing != digest:
                    raise ValueError("This operation ID was already used for a different request.")
                return self.async_snapshot()
            if expected_revision != self._state["revision"]:
                raise ValueError("Errands data changed; reload it and retry.")
            state = self.async_snapshot()
            now = dt_util.now()
            reconcile(state, now.date())
            apply_command(state, command, args, now.date(), dt_util.utcnow().isoformat())
            state["operations"][operation_id] = digest
            return await self._async_commit(state)

    @callback
    def async_subscribe(self, listener: Callable[[dict[str, Any] | None], None]) -> Callable[[], None]:
        """Subscribe to updates until disconnected or unloaded."""
        self._listeners.add(listener)
        return lambda: self._listeners.discard(listener)

    async def async_set_person(
        self,
        person_id: str | None,
        calendar_entity: str,
        calendar_registry_id: str | None,
        approval_required: bool,
        enabled: bool | None,
        expected_revision: int,
    ) -> dict[str, Any]:
        """Create or update a person after checking the client's revision."""
        async with self._lock:
            if self._closed or self._hass.state is CoreState.stopping:
                raise RuntimeError("Errands storage is unavailable.")
            if expected_revision != self._state["revision"]:
                raise ValueError("Errands data changed; reload it and retry.")
            state = self.async_snapshot()
            people = state["people"]
            person = next((item for item in people if item["id"] == person_id), None)
            if person_id is not None and person is None:
                raise ValueError("Person not found.")
            if any(
                item["id"] != person_id
                and (
                    item["calendar_entity"] == calendar_entity
                    or (calendar_registry_id is not None and item["calendar_registry_id"] == calendar_registry_id)
                )
                for item in people
            ):
                raise ValueError("This calendar is already linked to a person.")
            if person is None:
                person = {
                    "id": uuid4().hex,
                    "calendar_registry_id": None,
                    "approval_required": False,
                    "calendar_entity": "",
                    "enabled": True,
                }
                people.append(person)
            person.update(
                calendar_entity=calendar_entity,
                calendar_registry_id=calendar_registry_id,
                approval_required=approval_required,
            )
            if enabled is not None:
                person["enabled"] = enabled
            return await self._async_commit(state)

    async def async_close(self) -> None:
        """Wait for writes and notify subscribers before unloading."""
        async with self._lock:
            self._closed = True
            if self._cancel_rollover is not None:
                self._cancel_rollover()
                self._cancel_rollover = None
            if self._cancel_stop_listener is not None:
                self._cancel_stop_listener()
                self._cancel_stop_listener = None
            for listener in tuple(self._listeners):
                listener(None)
            self._listeners.clear()
