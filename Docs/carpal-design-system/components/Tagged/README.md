# Tagged

A compact card for a mechanic's shop or a spare part mentioned in a post; it turns a story ("my clutch was fixed in a day") into something the next reader can act on.

- Consumer provides: `icon` (`wrench` mechanic, `part` spare part, `store` parts shop), `title`, `detail` (address, or which cars the part fits), and either `rating` (0–5, shown with a filled `signal` star outlined in `ink`) or `price` (pre-formatted in the UI's currency and digits) with an optional stock `badge`.
- Sits on `accent-soft` with a `divider` edge (2px `border-inactive` in Sunlight); the icon tile is `accent` with `on-accent` glyph.
- Used inside `PostCard` through its `tagged` prop; on its own in search results and profile pages. Tap opens the shop or product page.
- Don't: show a rating without the number — stars alone fail in glare and for screen readers.
