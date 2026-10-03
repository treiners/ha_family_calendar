"""
API package for kdev_family_calendar.

Exception hierarchy:
    KdevFamilyCalendarApiClientError (base)
    ├── KdevFamilyCalendarApiClientCommunicationError (network/timeout)
    └── KdevFamilyCalendarApiClientAuthenticationError (401/403)

The coordinator maps them onto ConfigEntryAuthFailed and UpdateFailed; nothing else
in the integration imports this package.
"""

from .client import (
    FAN_SPEEDS,
    KdevFamilyCalendarApiClient,
    KdevFamilyCalendarApiClientAuthenticationError,
    KdevFamilyCalendarApiClientCommunicationError,
    KdevFamilyCalendarApiClientError,
)

__all__ = [
    "FAN_SPEEDS",
    "KdevFamilyCalendarApiClient",
    "KdevFamilyCalendarApiClientAuthenticationError",
    "KdevFamilyCalendarApiClientCommunicationError",
    "KdevFamilyCalendarApiClientError",
]
