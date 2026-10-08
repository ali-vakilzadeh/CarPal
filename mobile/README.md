# Mobile App (React Native)

WP19: a single React Native (TypeScript) codebase for the consumer app on iOS and Android.

| Folder | Contents |
| :--- | :--- |
| `src/` | Shared app code: screens (Discover, My Garage, Help Me, Appointments, Community, Profile), navigation, API client, i18n (`I18nManager` RTL), push handling, camera/document capture. |
| `android/` | Android native project (see its README). |
| `ios/` | iOS native project (see its README). |
| `preview/` | Clickable HTML preview of all 68 screens (Doc 21) in the CarPal design system, EN/FA and three themes. See [preview/README.md](preview/README.md). |

Testing: Detox/Appium UI tests, push delivery tests, and RTL layout tests for Persian.
