# TabBar

The bottom menu on phones (a side rail on web ≥ 900px): up to five destinations — Feed, Mechanics, Post, Parts, Chats; the active one shows the orange `selector` bar on its top edge, a filled icon, `ink` colour and an 800-weight label — three cues besides colour.

- Consumer provides: `items` (`id`, `label`, `icon`, optional `badge` text for the unread dot, `primary` for the centre "Post" action on a `signal` tile), `active`, `onChange`.
- Height `bar-height` 64 plus the safe-area inset; labels `caption` (Persian `fa-caption`), always shown — no icon-only tabs.
- Order follows reading direction: the first item sits at the inline start (right in Persian), no manual reversing.
