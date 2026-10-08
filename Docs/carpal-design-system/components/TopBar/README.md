# TopBar

The screen header: back, title (`title-2`), up to two icon actions, closed by a 2px `border` rule in `ink`.

- Consumer provides: `title`, `onBack` (pass `null` to show the button without a handler; omit to hide), `backLabel`, `actions` (icon buttons with `aria-label`).
- The back chevron mirrors in RTL and sits at the inline start (right in Persian). Native: iOS navigation bar with large title off; Android top app bar (small).
