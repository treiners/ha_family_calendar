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

The integration exposes one sensor, `sensor.family_calendar_configuration`. The card reads its settings from it.

## Card options

```yaml
type: custom:family-calendar-card
instance: main
```

| Key             | Description                                                |
| --------------- | ---------------------------------------------------------- |
| `instance`      | Required. Unique name for this card                        |
| `days`          | Fixed number of days to show, instead of the view selector |
| `view`          | `day`, `three_day`, `week` or `month`                      |
| `layout`        | `condensed` or `timeline`                                  |
| `multi_day`     | `banners` or `segments`                                    |
| `event_style`   | `bar` or `filled`                                          |
| `start_hour`    | First visible hour in the timeline layout                  |
| `end_hour`      | Last visible hour in the timeline layout                   |
| `hour_height`   | Pixel height of one hour                                   |
| `theme`         | `system`, `light` or `dark`                                |
| `icon_keywords` | Extra or overriding keyword → icon mappings                |
| `day_markers`   | Keyword-based markers shown in the day header              |
| `config_entity` | Alternative configuration sensor entity                    |

Setting `view`, `layout`, `multi_day`, `event_style`, `start_hour`, `end_hour`, `hour_height` or `theme` in YAML locks
that choice: the matching toolbar control is hidden and the card ignores the saved browser preference.

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
