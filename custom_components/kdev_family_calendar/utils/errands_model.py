"""Pure operations for errands, schedules and star transactions."""

from datetime import date, timedelta
from typing import Any, cast
from uuid import uuid4

import voluptuous as vol

_NAME = vol.All(str, vol.Strip, vol.Length(min=1, max=200))
_ID = vol.All(str, vol.Length(min=1, max=64))
_STARS = vol.All(int, vol.Range(min=1, max=1000000))
_DATE = vol.Any(None, vol.All(str, vol.Match(r"^\d{4}-\d{2}-\d{2}$")))
_SCHEDULE = vol.Schema(
    {
        vol.Required("kind"): vol.In(("once", "daily", "weekly")),
        vol.Required("weekdays"): [vol.All(int, vol.Range(min=0, max=6))],
    }
)
_TASK_FIELDS = {
    vol.Required("name"): _NAME,
    vol.Required("stars"): _STARS,
}

COMMAND_SCHEMAS = {
    "save_template": vol.Schema({vol.Optional("id"): _ID, **_TASK_FIELDS}),
    "delete_template": vol.Schema({vol.Required("id"): _ID}),
    "assign": vol.Schema(
        {
            **_TASK_FIELDS,
            vol.Required("person_ids"): vol.All([_ID], vol.Length(min=1)),
            vol.Required("schedule"): _SCHEDULE,
            vol.Optional("due_date", default=None): _DATE,
        }
    ),
    "edit_assignment": vol.Schema(
        {
            vol.Required("id"): _ID,
            **_TASK_FIELDS,
            vol.Required("schedule"): _SCHEDULE,
            vol.Optional("due_date", default=None): _DATE,
        }
    ),
    "delete_assignment": vol.Schema({vol.Required("id"): _ID}),
    "complete": vol.Schema({vol.Required("id"): _ID}),
    "approve": vol.Schema({vol.Required("id"): _ID}),
    "undo_completion": vol.Schema({vol.Required("id"): _ID}),
    "deduct": vol.Schema(
        {vol.Required("person_id"): _ID, vol.Required("stars"): _STARS, vol.Required("reason"): _NAME}
    ),
    "undo_deduction": vol.Schema({vol.Required("id"): _ID}),
}


def _find(items: list[dict[str, Any]], item_id: str) -> dict[str, Any]:
    item = next((item for item in items if item["id"] == item_id), None)
    if item is None:
        raise ValueError("Item not found.")
    return item


def validate_schedule(schedule: dict[str, Any], due_date: str | None) -> None:
    """Validate recurrence and optional due date together."""
    weekdays = schedule["weekdays"]
    if len(set(weekdays)) != len(weekdays):
        raise ValueError("Weekdays must not contain duplicates.")
    if (schedule["kind"] == "weekly") != bool(weekdays):
        raise ValueError("Choose weekdays only for a weekly schedule.")
    if schedule["kind"] != "once" and due_date is not None:
        raise ValueError("Due dates apply only to one-off errands.")
    if due_date is not None:
        date.fromisoformat(due_date)


def _transaction(
    state: dict[str, Any], person_id: str, amount: int, kind: str, reference: str, reason: str, now: str
) -> None:
    state["transactions"].append(
        {
            "id": uuid4().hex,
            "person_id": person_id,
            "amount": amount,
            "kind": kind,
            "reference": reference,
            "reason": reason,
            "created_at": now,
        }
    )


def _occurrence(assignment: dict[str, Any], day: str | None) -> dict[str, Any]:
    return {
        "id": uuid4().hex,
        "assignment_id": assignment["id"],
        "person_id": assignment["person_id"],
        "name": assignment["name"],
        "stars": assignment["stars"],
        "day": day,
        "status": "open",
    }


def reconcile(state: dict[str, Any], today: date) -> bool:
    """Replace missed occurrences and create current scheduled occurrences."""
    changed = False
    today_str = today.isoformat()
    for assignment in state["assignments"]:
        if not assignment["active"] or assignment["schedule"]["kind"] == "once":
            continue
        occurrences = [item for item in state["occurrences"] if item["assignment_id"] == assignment["id"]]
        schedule = assignment["schedule"]
        if schedule["kind"] == "daily":
            latest = today_str
        else:
            offset = min((today.weekday() - day) % 7 for day in schedule["weekdays"])
            latest = (today - timedelta(days=offset)).isoformat()
        if latest >= assignment["start_date"]:
            for item in occurrences:
                if item["status"] == "open" and item["day"] < latest:
                    item["status"] = "missed"
                    changed = True
            if not any(item["day"] == latest and item["status"] != "cancelled" for item in occurrences):
                state["occurrences"].append(_occurrence(assignment, latest))
                changed = True
    return changed


def _update_completion(state: dict[str, Any], command: str, item_id: str, today: date, now: str) -> None:
    item = _find(state["occurrences"], item_id)
    person = _find(state["people"], item["person_id"])
    if command == "complete":
        if item["status"] != "open":
            raise ValueError("Errand is not open.")
        item["status"] = "pending" if person["approval_required"] else "completed"
    elif command == "approve":
        if item["status"] != "pending":
            raise ValueError("Errand is not awaiting confirmation.")
        item["status"] = "completed"
    else:
        if item["status"] not in ("pending", "completed"):
            raise ValueError("Errand has not been completed.")
        if item["status"] == "completed":
            _transaction(state, item["person_id"], -item["stars"], "reversal", item["id"], item["name"], now)
        assignment = _find(state["assignments"], item["assignment_id"])
        item["status"] = "open" if assignment["active"] else "cancelled"
        reconcile(state, today)
        return
    if item["status"] == "completed":
        _transaction(state, item["person_id"], item["stars"], "award", item["id"], item["name"], now)


def apply_command(state: dict[str, Any], command: str, raw: dict[str, Any], today: date, now: str) -> None:
    """Validate and apply one operation to an isolated state copy."""
    if command not in COMMAND_SCHEMAS:
        raise ValueError("Unknown errands operation.")
    args: dict[str, Any] = cast("dict[str, Any]", COMMAND_SCHEMAS[command](raw))
    if command == "save_template":
        template = _find(state["templates"], args["id"]) if "id" in args else {"id": uuid4().hex}
        template.update(name=args["name"], stars=args["stars"])
        if "id" not in args:
            state["templates"].append(template)
    elif command == "delete_template":
        state["templates"].remove(_find(state["templates"], args["id"]))
    elif command == "assign":
        validate_schedule(args["schedule"], args["due_date"])
        if len(set(args["person_ids"])) != len(args["person_ids"]):
            raise ValueError("Each person can only be selected once.")
        for person_id in args["person_ids"]:
            _find(state["people"], person_id)
            assignment = {
                "id": uuid4().hex,
                "person_id": person_id,
                "name": args["name"],
                "stars": args["stars"],
                "schedule": args["schedule"],
                "due_date": args["due_date"],
                "start_date": today.isoformat(),
                "active": True,
            }
            state["assignments"].append(assignment)
            if args["schedule"]["kind"] == "once":
                state["occurrences"].append(_occurrence(assignment, args["due_date"]))
        reconcile(state, today)
    elif command in ("edit_assignment", "delete_assignment"):
        assignment = _find(state["assignments"], args["id"])
        if not assignment["active"]:
            raise ValueError("This errand is no longer active.")
        if command == "delete_assignment":
            assignment["active"] = False
            for item in state["occurrences"]:
                if item["assignment_id"] == assignment["id"] and item["status"] == "open":
                    item["status"] = "cancelled"
        else:
            validate_schedule(args["schedule"], args["due_date"])
            if (assignment["schedule"]["kind"] == "once") != (args["schedule"]["kind"] == "once"):
                raise ValueError("One-off and recurring assignments cannot be converted.")
            assignment.update(
                name=args["name"],
                stars=args["stars"],
                schedule=args["schedule"],
                due_date=args["due_date"],
                start_date=today.isoformat(),
            )
            for item in state["occurrences"]:
                if item["assignment_id"] == assignment["id"] and item["status"] == "open":
                    item.update(name=args["name"], stars=args["stars"])
                    if args["schedule"]["kind"] == "once":
                        item["day"] = args["due_date"]
            reconcile(state, today)
    elif command in ("complete", "approve", "undo_completion"):
        _update_completion(state, command, args["id"], today, now)
    elif command == "deduct":
        _find(state["people"], args["person_id"])
        _transaction(state, args["person_id"], -args["stars"], "deduction", "", args["reason"], now)
    elif command == "undo_deduction":
        transaction = _find(state["transactions"], args["id"])
        if transaction["kind"] != "deduction" or any(
            item["kind"] == "deduction_reversal" and item["reference"] == transaction["id"]
            for item in state["transactions"]
        ):
            raise ValueError("This deduction cannot be reversed.")
        _transaction(
            state,
            transaction["person_id"],
            -transaction["amount"],
            "deduction_reversal",
            transaction["id"],
            transaction["reason"],
            now,
        )
