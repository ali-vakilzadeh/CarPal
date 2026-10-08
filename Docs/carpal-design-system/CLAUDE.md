# CarPal design system — rules for Claude Code

Copy this file to the ROOT of each app project (next to package.json / the Xcode project / settings.gradle), keeping the `carpal-design-system/` folder beside it.

## Always
- Before building any screen, read `carpal-design-system/README.md`, then the guideline of each component you use: `carpal-design-system/components/<Name>/README.md`.
- Take every colour, size, spacing, radius and font from `carpal-design-system/tokens.json`. Never invent a hex value or a pixel size. Use the semantic names (`ink`, `surface`, `accent`, `signal`, `border-inactive`…), not the brand primitives.
- Support three themes: Daylight (`light`, default), Sunlight (`sun`, outdoor high-contrast) and Night (`dark`).
- Layout must work in RTL (Persian) and LTR (English): start/end only, never left/right; user text uses auto direction; only back/next/arrow/chat/comment icons mirror.
- Touch targets ≥ 48; body text 17; nothing smaller than 13 or thinner than weight 400.
- Fonts: Atkinson Hyperlegible Next (Latin) + Vazirmatn (Persian), both SIL OFL.
- Keep it light: flat colours, no gradients or blur, inline SVG icons, max one shadow per element.

## Web (React)
- Import `carpal-design-system/tokens.css` (CSS variables + @font-face) and `carpal-design-system/components/bundle.css`.
- Set `<html data-theme="light" dir="rtl" lang="fa">` (or ltr/en) on the root.
- Component API: `carpal-design-system/components/index.d.ts`. Port components from `components/bundle.js` into the app's source as typed React components, keeping the same class names and props.
- `components/*/preview.html` show how each component is used.

## iOS (SwiftUI) / Android (Jetpack Compose)
- Generate a theme file from `tokens.json` (Swift: `CarPalTheme.swift` with Color sets per theme; Kotlin: `CarPalTheme.kt` with lightColors/sunColors/darkColors, Typography, Dimens) — regenerate it whenever tokens.json changes; never edit values by hand.
- Fonts on native need TTF files: download "Atkinson Hyperlegible Next" and "Vazirmatn" from fonts.google.com and add them to the app bundle / `res/font`.
- Rebuild the components (Button, Chip, Badge, Avatar, PostCard, Tagged, TopBar, TabBar, TextField) natively, following each README. Respect Dynamic Type (iOS) and sp units (Android).
