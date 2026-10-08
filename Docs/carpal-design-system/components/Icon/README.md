# Icon

One outline icon set drawn for CarPal on a 24px grid with a 2px round stroke, inherited from CSS `color`.

- Consumer provides: `name`, optional `size` (`icon-md` 24 default, `icon-sm` 20 in chips and metadata), `filled` for the selected state of a tab or a liked heart, `label` only when the icon stands alone.
- `back`, `next`, `arrow`, `chat`, `comment` mirror under `dir="rtl"` (`.cp-flip`); the others never mirror (a car, a heart, a clock read the same both ways).
- Inline SVG, no icon font: zero extra requests, crisp at any density, and it obeys `currentColor` so it follows `ink`, `accent` or `on-signal`.
- Do: pair every icon-only button with an `aria-label`; colour icons `ink` or `accent`. Don't: use `signal` for a thin outline icon on white (fails 3:1) — orange icons are always `filled` with an ink stroke.
