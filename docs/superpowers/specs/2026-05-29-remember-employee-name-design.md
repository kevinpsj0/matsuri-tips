# Remember employee name across the app

## Goal

Employees should not have to retype their name every time they use the app. The
first time someone enters their name, the device remembers it and pre-fills it
from then on. No accounts, no passwords — convenience only, not security.

## Storage

- One `localStorage` value, key `matsuri_me`, holding the trimmed name string.
- Per-device / per-browser, matching the existing `matsuri_staff` cache pattern.
- Shared automatically across same-origin pages, so saving it on one page makes
  it available on the others with no server round-trip.

## Where the name applies

The remembered name pre-fills these fields:

1. `index.html` — `#entered-by` ("Your name" on the entry form).
2. `index.html` — the **first** person-on-shift row's name input (the person
   entering is usually also working the shift). Still editable and removable.
3. `today.html` — `#req-name` ("Your name" in the Request-edit popup).

Explicitly NOT pre-filled:

- `today.html` `#edit-by` ("Entered by") — shows who originally recorded the
  shift, which is not necessarily the current user.
- Person rows beyond the first.
- Admin page (PIN-protected, separate).

## When the name is saved/updated

- Saved on a **successful shift submission** (from `#entered-by`).
- Saved on a **successful edit-request send** (from `#req-name`).
- Saving the trimmed value lets a corrected spelling stick.

## Form reset behaviour

- After a successful submit, `resetForm()` currently blanks `#entered-by`.
  Change it to restore the remembered name and pre-fill the first person row,
  instead of clearing the name.

## "Not you?" escape hatch

- On `index.html`, when a remembered name is present, show a small quiet
  "Not [name]?" link near the name field.
- Tapping it clears `matsuri_me`, empties `#entered-by` and the first person
  row's name, and focuses the name field so a different person can type theirs.
- The popup field on `today.html` is always editable, so it needs no extra
  control.

## Implementation note

The get/save logic is ~3 lines, so inline it into each page rather than adding a
new shared file. A new file would require bumping the service-worker cache
version and an extra deploy step for negligible gain.

## Out of scope

- Real login / identity verification. Anyone can still type any name.
- Cross-device sync.
