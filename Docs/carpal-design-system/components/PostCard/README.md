# PostCard

The feed post — an owner's story about a repair, a mechanic's tip, a seller's new stock — with the author's role, the post text, any mechanic or part they tagged, and actions. It is the screen people read most, often outdoors, so it is set in `body` 17/26 (`fa-body` 17/30 in Persian) on `surface-raised`.

- Consumer provides: `author`, `handle`, `role` (`owner` · `mechanic` · `seller`, shown as a badge with its icon), `time` (already localised), `text`, optional `avatar`, `verified` (signal avatar ring), `tagged` (a list of `Tagged` props — the mechanic reviewed or the part found), `likes`, `comments`, `liked`, `cta` (one verb phrase — "Book service", "Buy part"), `highlight` (`signal-soft` ground for a featured post), `locale: 'fa'` for Persian digits, `labels` for translated strings.
- Bidi: the card takes its direction from the nearest `dir`; the post text uses `dir="auto"` and `unicode-bidi: plaintext`, so each paragraph aligns to its own first strong character. Names sit in `<bdi>`, handles are isolated LTR, so "Peugeot 207" or "@maryam.n" never scramble inside Persian text.
- Feed spacing: `space-5` between cards, `space-4` gutter; cap width at `measure` 640px on web.
- Sunlight theme: 2px `border` outline replaces the shadow.
- Don't: truncate post text to fewer than 4 lines; put text over photos without `scrim`.
