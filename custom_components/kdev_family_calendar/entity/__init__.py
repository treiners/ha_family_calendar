"""
Entity package for kdev_family_calendar.

Architecture:
    All platform entities inherit from (PlatformEntity, KdevFamilyCalendarEntity).
    MRO order matters — platform-specific class first, then the integration base.
    Entities read data from coordinator.data and NEVER call the API client directly.
    Unique IDs follow the pattern: {entry_id}_{description.key}

See entity/base.py for the KdevFamilyCalendarEntity base class.
"""

from .base import KdevFamilyCalendarEntity

__all__ = ["KdevFamilyCalendarEntity"]
