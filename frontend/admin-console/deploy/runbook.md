# Admin console runbook: staff accounts and daily routine

For the owner and the platform administrators of the pilot. Deployment itself is in [deploy.md](deploy.md); the
backend side of each step is in `backend/deploy/deploy.md` ("Admin plane").

Contents: [Accounts the pilot needs](#accounts-the-pilot-needs) · [First staff accounts](#first-staff-accounts) ·
[First sign-in](#first-sign-in-of-each-staff-member) · [More staff and roles](#more-staff-and-roles-later) ·
[Lost security key](#lost-security-key) · [Break glass](#break-glass-fewer-than-two-other-administrators) ·
[Daily routine](#daily-routine) · [Before the pilot opens](#before-the-pilot-opens) · [Open owner decisions](#open-owner-decisions)

## Accounts the pilot needs

| Role                     | How many                       | Why                                                                                                                      |
| :----------------------- | :----------------------------- | :----------------------------------------------------------------------------------------------------------------------- |
| ADM (platform admin)     | **4**: three main + one backup | Every ADM-only four-eyes change needs a second ADM; a lost-key recovery needs two ADMs other than the requester (DQ-16). |
| MOD (moderator)          | at least 1                     | Reports, cases, verification; moving a review to Path 2 needs two MODs, or a MOD and an ADM.                             |
| CRV (community reviewer) | at least 1                     | Only CRV decides Path 2 review approvals (OQ-10).                                                                        |
| SUP (support)            | as needed                      | The support inbox.                                                                                                       |

One person may hold several roles, except the backup administrator, who holds only ADM. The console and the server keep
the "a different staff member decides" rule per action, whatever roles a person holds.

**The backup administrator** is a normal ADM account kept out of daily use. Only the owner knows who holds it. Its
password, its two security keys and its sheet of recovery codes are sealed and kept apart. Use it only when fewer than
two main ADMs can act, and sign in with it after each use and once a quarter to check the key still works
(backend `deploy.md` "The backup administrator").

## First staff accounts

There is no sign-up and no invite in the console. Accounts come from a staff spec on the server, once:

1. Copy `backend/deploy/templates/staff-bootstrap.json.example` to `/carpal/config/staff-bootstrap.json` (root, 600)
   and put in the real names, work email addresses, roles and language. The template lists `admin100@carpals.ir`,
   `admin200@carpals.ir` and `admin300@carpals.ir`; add the backup ADM, the MOD and the CRV once they are named.
   Each mailbox must be read by its holder only: sign-in codes and security notices go there.
2. Put the owner's initial password in `/carpal/config/backend.env` as `CARPAL_STAFF_INITIAL_PASSWORD='…'` (single
   quotes, no single quote inside). Without it, each account gets a one-time password printed once on the terminal
   (and kept in the backend's root-only deploy log).
3. `admin-setup.sh` runs the bootstrap on its first install when the spec exists. Later, or by hand:

   ```sh
   sudo bash /carpal/backend/src/backend/deploy/staff-bootstrap.sh
   ```

   It creates the accounts that do not exist and never changes one that does; it warns while the pilot minimum (two
   ADM, one MOD, one CRV) is not met.

4. Give each holder the password **on a separate channel** (in person, a phone call), never through the mailbox that
   receives the codes.

The initial password works for **7 days**. After that it is refused like a wrong password. Issue a new one with:

```sh
sudo bash /carpal/backend/src/backend/deploy/staff-bootstrap.sh --reissue admin200@carpals.ir
```

Remove `CARPAL_STAFF_INITIAL_PASSWORD` from `backend.env` once every account has signed in.

## First sign-in of each staff member

Send this to each new staff member with the address of the console (R-14):

> **Before you start:** have your work mailbox open and your security key (or a computer with Windows Hello) at hand.
> Plan 15 minutes in one go. Phone passkeys that sync to iCloud or Google are refused: the console accepts only keys
> that stay on one device.
>
> 1. Open `https://admin.carpals.ir/`. Enter your work email and the initial password you were given.
> 2. Enter the code we email you, then choose your own password (at least 12 characters, not a known leaked password,
>    not the initial one).
> 3. Register your security key when the browser asks (insert or touch it).
> 4. You see **10 recovery codes once**. Print them or write them down and keep the sheet sealed, away from your key.
>    Tick "I have stored them" to go on.
> 5. Confirm with your key. You are in.
> 6. In the avatar menu → **Security**, add a **second key** as a backup (keep it somewhere else).
>
> From then on every sign-in is password + key. The console signs you out after 30 minutes without an action and
> after 8 hours in any case. A risky action (for example a suspension or an approval) asks for your key again.

Until real email is set up (`CARPAL_MAIL_TRANSPORT=smtp`, backend `deploy.md` "Email"), the codes of steps 2 and 3
are only in `/carpal/data/outbox-mail.jsonl` on the server: the operator reads them out to the staff member.

## More staff and roles later

- **New accounts:** add them to `/carpal/config/staff-bootstrap.json` and run `staff-bootstrap.sh` again. Existing
  accounts are left as they are.
- **Roles:** an ADM gives or removes roles on **Staff & permissions** (`/staff`). A grant waits for a second ADM on
  **Pending approvals**. Disabling a member is immediate; enabling again waits for a second ADM.
- **Someone leaves:** disable them on `/staff` the same day. Their sessions end and their pending requests are rejected.

## Lost security key

The usual way, with at least two other ADMs active (backend S16b; console AC10b):

1. The staff member opens the console sign-in and chooses **Lost your security key?** They enter their email, their
   password (or "I have forgotten my password too"), **one code from their recovery sheet**, then the code emailed to
   them. The page then waits; they keep that browser.
2. Every other active ADM gets an email that points to **Recovery requests** (`/recoveries`). Nothing can be approved
   from the email.
3. **Two ADMs other than the requester** each check the person outside CarPal: a call to a number they already know,
   in person, or a video call. Never use a number or address given in the request. Each approves on
   `/recoveries`, says how they checked, and confirms with their own key. Any ADM can reject.
4. The request expires 24 hours after it was opened. Once approved, the staff member continues **in the same browser**
   (the console remembers the request for 24 hours): a new password if they forgot it, a new key, a new sheet of codes.
5. For 72 hours the account cannot approve changes, grant roles, enable staff or approve a recovery. A banner says so.

Avoid deploying a console update while a request waits: the update forgets the request in the browser, and the person
has to start again ([deploy.md](deploy.md) "Known limitations").

A staff member with **no recovery code left**, or a disabled one, cannot use this: enable them first (four eyes), or
use break glass.

## Break glass (fewer than two other administrators)

Only when fewer than two other ADMs are active, or the console cannot be used. On the server, as root, after checking
the person's identity out of band:

```sh
sudo bash /carpal/backend/src/backend/deploy/staff-break-glass.sh <staff email> "<who asked, how you checked it was them>"
```

It disables the account's keys and recovery codes, writes an audit entry with your reason, ends the account's
sessions and emails the account and every other active ADM. The next sign-in asks for the password, an emailed code
and a new key, and shows a new sheet of codes. It refuses unknown accounts and accounts without an active role.

## Daily routine

| When                        | Who                               | What                                                                                                                                             |
| :-------------------------- | :-------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------- |
| Every morning (Tehran time) | an ADM                            | **Exchange rates:** set today's USD → IRR rate, or "Keep for today". The dashboard shows a card and the bell a reminder until it is set.         |
| Every working day           | the ADM on duty (name them, R-19) | **Pending approvals:** decide the four-eyes requests. A request waits up to 72 hours, then expires.                                              |
| Every working day           | an ADM                            | **Recovery requests:** answer waiting requests (they expire after 24 hours).                                                                     |
| Every working day           | MOD, CRV, SUP                     | **My work** on the dashboard: queues at risk of their SLA (verification and review approvals 2 working days, disputes 5; Friday is the weekend). |
| Weekly                      | an ADM                            | **Audit log** for unusual staff actions; **Staff & permissions** for accounts that should be disabled.                                           |
| Quarterly                   | the backup ADM's holder           | Sign in once to check the key works.                                                                                                             |

Agree and write down who is on duty for Pending approvals each day of the week (R-19): ________________________

## Before the pilot opens

1. Four ADM accounts have signed in, each with two keys and a sealed recovery sheet; the MOD and the CRV too.
2. **Set the real exchange rate** (R-21). The seeded rate is a placeholder (`CARPAL_DEFAULT_IRR_PER_USD`, 1,000,000),
   so the first real rate is a change over 20 % and **waits for a second ADM**: one ADM sets it, another approves it
   on Pending approvals the same morning.
3. Check the AI kill switch on **Feature flags** is in the state you want (turning AI on later waits for a second ADM).
4. Real email works (`CARPAL_MAIL_TRANSPORT=smtp`): a test sign-in code reaches a staff mailbox.
5. Publish the policy and consent texts on **Policies** (each publication waits for a second ADM).
6. The Next.js patch update is in (`security-pass.md` F-1: `next` 16.4.3 → 16.4.5, your decision; then `pnpm check`,
   `pnpm build` and the E2E suite once more before the upload).

## Open owner decisions

These were built on defaults and wait for the owner's confirmation (backend `BR-update-plan.json` decisions_needed):

- **DQ-25:** the length of the initial password for `admin100`, `admin200`, `admin300`.
- **DQ-26:** their email addresses (`admin100@carpals.ir` …) — each must be a mailbox only its holder reads.
- **R-05, R-07, R-19:** the staff names, who holds which keys, and who checks Pending approvals each day.
