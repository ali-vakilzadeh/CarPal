CarPal is a social network where **car owners**, **repair mechanics** and **parts sellers** meet: owners share repair stories and rate the mechanics who helped them, mechanics post tips and open slots, sellers list parts that people can find by name, car model or part number. People read it in a workshop yard, at a parts bazaar or beside their car on the street — often in full sun, with greasy hands, in Persian and English mixed in the same sentence, on mid-range phones over mobile data. Every rule below serves three goals: **readable in bright light**, **direction-proof (LTR ⇄ RTL)**, and **light enough to paint instantly**. One token set and one component vocabulary serve the iOS app, the Android app, the web app and web/social media graphics.

## Content fundamentals

- Speak like a trusted mechanic friend: short, plain, honest, second person ("Your part is in stock at 2 shops near you"). Sentence case everywhere — no ALL CAPS, which is slower to read and meaningless in Persian.
- Lead buttons with a verb, 1–3 words: "Book service", "Message seller", "Buy part" / «رزرو تعمیرگاه»، «پیام به فروشنده»، «خرید قطعه».
- Put the useful fact first: what, for which car, where, how much ("Front brake pads · Peugeot 206 · Pars Spare Parts · 1,850,000 T").
- Say who is speaking: every post shows the author's role (Car owner, Mechanic, Parts seller) as a badge with its icon, so advice and ads are never confused.
- Reviews are first-hand and specific — what broke, what was done, what it cost; ratings always show the number beside the star.
- Persian copy is written natively, not translated word-for-word; use the zero-width non-joiner (ZWNJ) correctly: «می‌رود», «اعلان‌ها».
- Numbers follow the UI language: Persian digits (۱۲) in Persian UI via `CarPal.fmt(n, 'fa')`; plates, phone numbers, handles and URLs stay as typed.
- Emoji may appear in people's posts; the interface itself never uses emoji as icons or decoration.

## Colour

The brand is four colours. Use them through the semantic tokens, never the primitives, so the three themes work.

| Brand primitive | Role |
| --- | --- |
| `Metal_black` #0c1136 | Text, borders, headers — reached as `ink` and `border` |
| `Metal_blue` #085282 | Graphics, menu tracks, shadows, inactive borders — `accent`, `border-inactive`, `selector-track` |
| `light_orange` #ffa41b | Graphics, active menu selector, primary action — `signal`, `selector` |
| `White` #ffffff | Ground — `surface` |

- Set all text in `ink` on `surface`, `surface-raised` or `surface-sunken`; secondary text in `ink-muted` (never lighter — there is no grey text in CarPal).
- Orange is a fill, never a text colour: on white it is 1.99:1. Text on an orange fill is `on-signal` (ink, 9.2:1). Use `signal` for the one primary button per screen, the active tab's selector bar, unread dots and highlight graphics.
- Blue carries structure: `accent` for links and secondary icons, `border-inactive` for resting control edges, `accent-soft` for selected grounds, and blue-tinted `shadow-1` / `shadow-2`.
- Combine blue and orange as a pair in graphics: the primary button is orange with a flat blue `shadow-signal` edge; the tab bar's track is blue, its selector orange.
- Status: `danger` and `success` always come with an icon and a word. `success` leans blue so it is never told from `danger` by red/green hue alone.

### Themes

- **Daylight** (`light`, default) — white grounds, navy ink, blue-tinted shadows. Every text pair ≥ 5.6:1, body text ≥ 14:1.
- **Sunlight** (`sun`) — the outdoor mode. Pure white grounds without tints, every text pair ≥ 7.8:1 (WCAG AAA), shadows removed and replaced with 2px `border` outlines, metadata and tab labels bumped to 700. Switch to it automatically when the device's ambient-light sensor reports bright light (Android `Sensor.TYPE_LIGHT` > ~10 000 lux; iOS: offer it as a setting and follow "Increase Contrast"; web: `@media (prefers-contrast: more)`), and always offer it as a manual toggle.
- **Night** (`dark`) — `Metal_black` becomes the ground; blue is lightened to `#6bbcf0` so it stays legible; orange is unchanged and keeps ink text. Follow the OS dark-mode setting.

Apply a theme by setting `data-theme="light|sun|dark"` on the root; native apps map the same token names to asset-catalog colours (iOS) and `values/`, `values-night/` resources (Android).

## Typography

Two open-licence fonts (SIL OFL 1.1, free for apps and commercial use), both variable so one file covers every weight:

- **Atkinson Hyperlegible Next** — Latin. Designed by the Braille Institute for low-vision readers: unambiguous `Il1`, `O0`, open apertures and wide letterforms that hold up in glare and at small sizes. File: `fonts/AtkinsonHyperlegibleNext-Latin-Variable.woff2` (34 KB).
- **Vazirmatn** — Persian/Arabic. Clear, open counters and generous dots; the most widely used open Persian UI face. File: `fonts/Vazirmatn-Arabic-Variable.woff2` (Arabic-script subset, 46 KB).

Both faces load in one stack (`--font-sans`: Atkinson first, Vazirmatn for Arabic-script glyphs), so a mixed post renders each script in its own face without any markup. Persian screens use `--font-fa` (Vazirmatn first).

- Body copy is `body` 17/26 (Persian `fa-body` 17/30). 17px is the floor for reading text; `caption` 13px/600 is the floor for any text at all.
- Never set weights below 400, and never below 600 under 15px — thin strokes vanish in sunlight.
- Persian styles get ~1.75 line height (dots and descenders need room), are one step larger at caption size (`fa-caption` 14px), and are never letter-spaced or italicised (Persian has no italic).
- Use tabular numerals (`font-variant-numeric: tabular-nums`) for counts and times.
- Native apps: bundle the variable TTFs from the upstream projects (github.com/googlefonts/atkinson-hyperlegible-next, github.com/rastikerdar/vazirmatn) and support Dynamic Type (iOS) / `sp` units (Android) — the scale above is the default size, not a cap.

## Bidirectional layout (alignment tolerant)

- Write every horizontal value with logical properties: `margin-inline-start`, `padding-inline`, `inset-inline-end`, `border-start-start-radius`, `text-align: start`. Never `left`/`right`. Native equivalents: iOS `leading`/`trailing` constraints and `.natural` alignment; Android `start`/`end` with `android:supportsRtl="true"`; Compose and Flutter `start`/`end` (`EdgeInsetsDirectional`).
- Set direction once, on the screen root, from the UI language (`dir="rtl" lang="fa"`). Components never hard-code direction.
- User-generated text (posts, comments, bios, field input) gets `dir="auto"` + `unicode-bidi: plaintext`: each paragraph aligns to its own first strong character, so an English post in the Persian app still reads correctly.
- Isolate names, handles, plates and numbers inside text with `<bdi>` (native: Unicode FSI/PDI isolates) so "@maryam.n", "Peugeot 207" or a part number like "0986494"  never scramble a Persian sentence.
- Only direction-bearing icons mirror (`back`, `next`, `arrow`, `chat`, `comment`); wrenches, stars, cars, hearts, checkmarks and media "play" never do.
- Layouts must tolerate text 30% longer or shorter than English: no fixed-width buttons, labels may wrap to two lines, avoid truncating anything but names.

## Spacing, size and shape

- 4px base: `space-1` 4 … `space-12` 48. Phone gutter `space-4`, card gap `space-5`, section gap `space-8`.
- Every touch target is at least `tap-min` 48 (larger than iOS's 44pt — gloves, moving vehicles, sun-squinting). Buttons and inputs are `control-md` 48 tall.
- Corners: `radius-md` 12 for controls, `radius-lg` 20 for cards and sheets, `radius-pill` for chips and avatars, `radius-sm` 6 for badges.
- Reading width caps at `measure` 640px on web; the web feed is one centred column with a side rail ≥ 900px.

## Elevation, borders and states

- Daylight uses two quiet, blue-tinted shadows (`shadow-1` resting, `shadow-2` floating). Sunlight replaces shadows with 2px `border` outlines — shadows disappear in glare, edges do not.
- Resting control edges are `border-inactive` (blue, ≥ 3:1); focused or active edges are `border` (ink). Dividers (`divider`) are decorative only.
- Keyboard focus is `ring-focus` everywhere: a 2px gap in the ground colour, then a solid ring in `focus` (ink in Daylight/Sunlight, orange in Night).
- Selection is never colour alone: the active tab adds the orange bar *and* a filled icon *and* a heavier label; a selected chip adds a check.
- Pressed primary buttons drop 2px onto their `shadow-signal` edge. That is the only motion in components; respect `prefers-reduced-motion` / OS reduce-motion.

## Performance (lightweight by default)

- Fonts: two variable WOFF2 files, 80 KB total, `font-display: swap` with a matching system fallback; preload only the face of the current UI language. Native apps ship fonts in the bundle — zero network.
- Icons are inline SVG paths (≈ 3 KB for the full set) — no icon font, no image requests, recoloured by CSS `color`.
- Colours are flat: no gradients, no `backdrop-filter` blur, no more than one shadow per element — cheap to paint on low-end Android.
- Components are plain CSS classes over semantic HTML; the web bundle (JS + CSS) is under 20 KB unminified. Render a skeleton in `surface-sunken` within the first frame, then text, then images.
- Images: serve WebP/AVIF at the rendered size × device pixel ratio, `loading="lazy"`, fixed aspect boxes so nothing shifts.

## Web media and social graphics

- Ground: `White` or `Metal_black`; one `light_orange` focal shape; `Metal_blue` for secondary shapes and lines. Text in `ink` on white or `White` on navy — never on orange except ink.
- Headline in `display` / `fa-title` weight 800, at least 6% of the image height so it reads in a scrolling feed; leave a 6% safe margin on all sides. Persian and English versions are mirrored layouts, not the same file with swapped text.

## Iconography

- One outline set drawn for CarPal, including the domain glyphs `car` (owner), `wrench` (mechanic), `store` (parts seller), `part` and `star` (rating): 24px grid, 2px round stroke, round joins, inherits `currentColor` (see the Icon component). Sizes `icon-md` 24 and `icon-sm` 20.
- Selected/active states use the `filled` variant. Orange icons are always filled with an ink stroke — a thin orange outline fails contrast on white.
- Every icon-only button has an accessible label in the UI language.

## Logo

No CarPal logo was provided, so this system sets the name in plain type: "CarPal" in Atkinson Hyperlegible Next 800, `ink` on white or `White` on `Metal_black`. Replace this note when the official mark is added under `assets/Logos/`.

## Components

`window.CarPal` (React 18): `Button`, `Icon`, `TextField`, `Chip`, `Badge`, `Avatar`, `PostCard`, `Tagged` (a mechanic or part mentioned in a post), `TopBar`, `TabBar`, plus `fmt()` for locale digits. Each has a guideline card; `PersianFeed` shows the home feed — an owner's mechanic review and a part found the same day — in RTL beside its LTR twin.
