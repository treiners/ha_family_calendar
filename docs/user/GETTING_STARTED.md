# Getting Started with Family Calendar

## Prerequisites

- Home Assistant 2026.8.0 or newer
- HACS installed
- At least one `calendar` entity

## Installation

1. In HACS, open the menu → **Custom repositories**.
2. Add `https://github.com/treiners/ha_family_calendar` with category **Integration**.
3. Download **Family Calendar** and restart Home Assistant.

For a manual install, copy `custom_components/kdev_family_calendar/` from the
[latest release](https://github.com/treiners/ha_family_calendar/releases) into your configuration directory.

## Setup

1. **Settings → Devices & services → Add integration → Family Calendar**.
2. Select the calendars to show.
3. For each calendar, set a display name, color and text color.

Only one Family Calendar entry can exist. Change calendars, colors, default view and palettes later via **Configure**
on the integration.

## Add the card

Edit a dashboard, add a **Manual** card and use:

```yaml
type: custom:family-calendar-card
instance: main
```

`instance` is required. It names this card so each card remembers its own view, layout and hidden calendars in the
browser. Use a different name for each card.

If the card is not found after installing, hard-refresh the browser.

### Full width in a sections view

Set `max_columns` on the view and a matching `column_span` on the section, and let the card fill it:

```yaml
views:
  - type: sections
    max_columns: 1
    sections:
      - type: grid
        column_span: 1
        cards:
          - type: custom:family-calendar-card
            instance: main
```

## Using the card

- The toolbar has previous/next arrows, **Today**, a date picker and a Day / 3 days / Week / Month selector.
- Buttons switch between condensed and timeline layout, multi-day banners and segments, and bar and filled event
  style.
- Click an event for details, then edit or delete it if the calendar allows it.
- In the timeline layout, click an empty slot to add an event; the end defaults to one hour later.
- Recurring events can't be changed from the card.

## Troubleshooting

- **Card not found:** restart Home Assistant after installing, then hard-refresh the browser.
- **No events:** check the calendar entities are selected in the integration's options.
- **Add event fails:** the calendar must support creating events.
- **Debug logging:** add `custom_components.kdev_family_calendar: debug` under `logger: logs:` in `configuration.yaml`.
