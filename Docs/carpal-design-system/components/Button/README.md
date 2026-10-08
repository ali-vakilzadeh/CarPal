# Button

Buttons trigger an action; use **primary** (signal orange with ink label and a flat blue offset edge) once per screen for the thing the screen is for — "Book service", "Buy part", "Post review".

- Variants: `primary` (signal fill, `on-signal` label), `secondary` (default — `surface-raised`, `border-inactive` 2px edge), `ghost` (`accent` text, no edge — for low-stakes inline actions), `danger` (`danger` text and edge, destructive only).
- Sizes: `md` = `control-md` 48px (default), `sm` = `control-sm` 40px — pad an `sm` button's hit area to `tap-min`.
- Consumer provides: `children` (a verb-first label, sentence case: "Book service", never "OK"), optional `icon` / `iconEnd`, `onClick`, `disabled`, `loading`, `block` for full-width bottom actions on phones.
- Icons go through `Icon`; direction-bearing ones (`next`, `back`, `arrow`) mirror automatically in RTL — put "forward" icons in `iconEnd`, never hard-code a right arrow.
- Do: keep labels to 1–3 words; Persian labels use `fa-label`. Don't: two primaries side by side, all-caps, orange text.
- Native: iOS — a 48pt-tall `UIButton.Configuration.filled()` with `signal` background; Android — `Button` with `minHeight=48dp`, `insetTop/Bottom=0`.
