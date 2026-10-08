# Chip

Chips filter the feed or search results — All, Mechanics, Parts, Near me — or pick one option from a short set; the selected chip gets an `accent-soft` ground, an `ink` edge and a check icon, so selection never depends on colour alone.

- Consumer provides: `children` (one or two words), `selected`, `onClick`, optional leading `icon`.
- Height `control-sm` 40px, `radius-pill`; scroll a long chip row horizontally rather than wrapping on phones — the row scrolls from the inline start, so RTL starts on the right.
- Don't: use chips as primary actions or put more than ~8 in a row.
