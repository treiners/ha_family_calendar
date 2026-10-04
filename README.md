# Family Calendar

[![GitHub Release][releases-shield]][releases]
[![License][license-shield]](LICENSE)
[![hacs][hacsbadge]][hacs]

A Home Assistant integration that bundles a family calendar dashboard card. Pick the calendars to show in the
integration settings, then add the `custom:family-calendar-card` card to any dashboard.

## ✨ Features

- Day, 3-day, week and month views, always starting from today
- Several calendars in one view, each with its own name, color and text color
- Condensed or timeline layout, with multi-day events as banners or per-day segments
- Colored-bar or fully filled event style
- Create, edit and delete events from the card (click an empty slot to add one)
- Icons chosen by keywords in the event title, and day markers
- Light and dark palettes, configured once in the integration options
- Configured entirely through the UI; no YAML needed for setup

## 🚀 Installation

1. In HACS, open the menu → **Custom repositories**, add `https://github.com/treiners/ha_family_calendar` as an
   **Integration**, and download **Family Calendar**.
2. Restart Home Assistant.
3. Go to **Settings → Devices & services → Add integration → Family Calendar**.
4. Choose the calendars to show, then set a name, color and text color for each one.
5. Add the card to a dashboard:

```yaml
type: custom:family-calendar-card
instance: main
```

The card is served by the integration, so no dashboard resource needs to be added.

See [Getting started](docs/user/GETTING_STARTED.md), the [configuration reference](docs/user/CONFIGURATION.md) and
[examples](docs/user/EXAMPLES.md).

## Requirements

- Home Assistant 2026.8.0 or newer
- One or more `calendar` entities

## 🤝 Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development setup.

## 🤖 AI-Assisted Development

This integration was developed with AI assistance (GitHub Copilot). Automated tests cover the config flow and the
configuration sensor; the card itself has no automated tests and was checked manually on a Home Assistant 2026.8
development instance.

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

[hacs]: https://github.com/hacs/integration
[hacsbadge]: https://img.shields.io/badge/HACS-Custom-orange.svg?style=for-the-badge
[license-shield]: https://img.shields.io/github/license/treiners/ha_family_calendar.svg?style=for-the-badge
[releases-shield]: https://img.shields.io/github/release/treiners/ha_family_calendar.svg?style=for-the-badge
[releases]: https://github.com/treiners/ha_family_calendar/releases
