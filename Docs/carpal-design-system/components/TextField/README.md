# TextField

A labelled text input whose typing direction follows what the person types (`dir="auto"`, `unicode-bidi: plaintext`), so a Persian part search with an English car model in it ("لنت ترمز Peugeot 206") stays in order.

- Consumer provides: `label` (always visible — no placeholder-as-label), `value`/`onChange` or `defaultValue`, optional `hint`, `error`, `icon`, `multiline` for the review composer.
- Resting edge is `border-inactive` 2px on `surface-sunken`; focus turns it `border` on `surface-raised`. Error: `danger` edge plus an `alert` icon and words — never colour alone.
- Height is `control-md` 48px; text is 17px so iOS Safari does not zoom on focus.
- Do: set `inputmode`/`autocomplete` (tel, numeric) for faster entry; accept both Persian (۰–۹) and Latin digits in part numbers and normalise before searching. Don't: force `dir="rtl"` on fields that may hold OEM numbers, plates or phone numbers.
