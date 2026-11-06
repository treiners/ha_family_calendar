# Configuration Reference

## Integration options

Set during setup and editable later via **Configure** on the integration.

| Option                | Description                                                    |
| --------------------- | -------------------------------------------------------------- |
| Calendars             | The `calendar` entities to display                             |
| Name / Color          | Per calendar: display name and event color                     |
| Text color            | Per calendar: text on filled events, banners and all-day chips |
| Default view          | Day, 3 days, week or month                                     |
| Default layout        | Condensed or timeline                                          |
| Start hour / End hour | Visible hours in the timeline layout                           |
| Hour height           | Pixel height of one hour in the timeline layout                |
| Theme                 | System, light or dark                                          |
| Light / dark colors   | Day, today and card background colors for each palette         |

The integration exposes one sensor, `sensor.family_calendar_configuration`. The card reads its settings from it. There is an automatic fallback and option to have an explicit reference in the YAML code of the card: config_entity: sensor.family_calendar.

## Card options

```yaml
type: custom:family-calendar-card
instance: main
config_entity: sensor.family_calendar.
```

The last line is optional.

| Key             | Description                                                           |
| --------------- | --------------------------------------------------------------------- |
| `instance`      | Required. Unique name for this card                                   |
| `days`          | Fixed number of days to show, instead of the view selector            |
| `view`          | `day`, `three_day`, `week` or `month`                                 |
| `first_day`     | First day in week view: `current_day` (default), `sunday` or `monday` |
| `layout`        | `condensed` or `timeline`                                             |
| `multi_day`     | `banners` or `segments`                                               |
| `event_style`   | `bar` or `filled`                                                     |
| `start_hour`    | First visible hour in the timeline layout                             |
| `end_hour`      | Last visible hour in the timeline layout                              |
| `hour_height`   | Pixel height of one hour                                              |
| `theme`         | `system`, `light` or `dark`                                           |
| `button_size`   | Family calendar filter buttons: `normal` or `large`                   |
| `icon_keywords` | Extra or overriding keyword → icon mappings                           |
| `day_markers`   | Keyword-based markers shown in the day header                         |
| `config_entity` | Alternative configuration sensor entity                               |

Setting `view`, `layout`, `multi_day`, `event_style`, `start_hour`, `end_hour`, `hour_height` or `theme` in YAML locks
that choice: the matching toolbar control is hidden and the card ignores the saved browser preference.

The visual card editor supports these options too. Leave an optional setting on its default to keep using integration
defaults and saved browser preferences. Large family buttons have a minimum touch height of 44 pixels; the default is
the existing normal size. In the day marker editor, enabling an empty custom list hides integration default markers.

For `first_day: sunday` or `first_day: monday`, week view starts on that day in the week containing today or the
date chosen in the date picker. The arrows move by whole weeks. The month grid starts on the same weekday; with
`current_day`, it keeps its existing Monday start. Day, 3-day and fixed-length views still start on the chosen date.

### Family errands and stars

Select **Errands** on the card, then choose **People** to enable errands for the calendars you want to use.
Select a family button to show that person's errands and star balance. Hiding a person in **People**, or removing
their calendar from the integration, keeps their tasks and history. Use **People** to show them again or link a
previously removed person to a selected calendar.

Use **Add errand** to create a one-off or repeating task for one or more people. The **Library** stores reusable
ideas; assigning one creates a separate task. An optional due date does not remove a one-off task when it passes.
Unfinished repeating tasks are replaced at the next scheduled occurrence in Home Assistant's time zone.
Completions waiting for confirmation remain available.

Each person's **Require confirmation** setting determines whether completing an errand awards stars immediately or
waits for confirmation. Confirmation is not locked: anyone with permission to control the shared errands can use it.
Use **Use stars** to record a reward, and **History** to correct a completion or deduction. A balance can be negative.
Changes are shared between cards and stored by Home Assistant; include its configuration storage in your backups.

If a save fails, retry the same request or use **Refresh and dismiss** to check the latest shared state before making
another change. If errands storage is unavailable, the calendar remains usable; check Home Assistant's logs and
restore the errands data from backup if needed.

### Icons by keyword

Event titles containing a keyword get its icon. Built-in keywords include trash, recycling, haircut, piano, violin,
soccer, football, swim, doctor, dentist, birthday and school. Add or override:

```yaml
icon_keywords:
  karate: mdi:karate
  trash: mdi:delete
```

### Day markers

An event whose title contains a keyword is shown as an icon in the day header instead of in the event list. At most
two icons are shown per day, and identical icon and color pairs are shown once.

```yaml
day_markers:
  - keyword: greenwaste
    icon: mdi:trash-can
    color: "#00ff00"
  - keyword: yellowbin
    icon: mdi:recycle
    color: "#FFEA00"
```

## Troubleshooting

- **Settings don't show on the card:** reload the integration and hard-refresh the browser.
- **Config entry fails to load:** check **Settings → System → Logs** for `kdev_family_calendar`.

## Default day markers and icon keywords

Open the integration's **Configure** dialog and continue past the calendar screens to the last step. There you can
define default day markers (keyword, icon, optional color) and icon keywords (keyword, icon) for every card.

A `day_markers` list in a card's YAML replaces the default markers for that card. A card's `icon_keywords` are merged
over the integration's keywords, which are merged over the built-in ones.
