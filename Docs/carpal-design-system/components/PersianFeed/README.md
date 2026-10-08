# PersianFeed

A composition sample, not a component: the CarPal home feed in Persian (RTL, Vazirmatn) and English (LTR, Atkinson Hyperlegible Next) — a car owner praising a mechanic, an owner (or a parts seller) showing a part found the same day — built only from `TopBar`, `Chip`, `PostCard`, `Tagged` and `TabBar`.

- Nothing in it is mirrored by hand: setting `dir="rtl" lang="fa"` on the screen root flips layout, chevrons, chip order and the tab order through logical CSS properties and `.cp-flip`.
- Mixed-script lines ("Peugeot 206" inside Persian, «تعمیرگاه کریمی» inside English) stay in reading order because post text uses `dir="auto"` plus `unicode-bidi: plaintext`, and names and handles are isolated in `<bdi>`.
- Persian counts, ratings and prices use Persian digits; handles and part numbers stay Latin.
