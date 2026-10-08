# Avatar

A round profile picture with an initials fallback on `accent`; a `signal` ring marks a verified mechanic or parts seller.

- Consumer provides: `name` (used for initials — Persian names work), optional `src` (served at 2× the rendered `size`, WebP/AVIF, lazy-loaded), `size` (`avatar-md` 44 default), `ring`.
- Don't: rely on the ring alone to mean "verified" — the role badge beside the name says it in words.
