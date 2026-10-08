# Badge

A badge labels a person, shop or part with one or two words: who is speaking (Car owner, Mechanic, Parts seller) or a status (In stock, Top rated).

- Tones: `neutral` (`surface-sunken` — car owners), `accent` (fill, `on-accent` — professional roles: Mechanic, Parts seller), `signal` (fill, `on-signal` — highlights like Top rated, New), `success` / `danger` (outlined, coloured text, always with `check` / `alert` — In stock, Out of stock).
- Role badges always carry their icon (`car`, `wrench`, `store`) so the role reads without colour.
- Text is `caption` 13px bold — the system's minimum. Consumer provides `children`, optional `tone` and `icon`.
