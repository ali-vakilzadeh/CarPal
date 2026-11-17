# Email setup guide: cPanel / Roundcube for the CarPal backend

**For:** the owner, setting up the carpals.ir mailboxes on the cPanel host so the backend can send email.
**Backend side:** stage S26a (`CARPAL_MAIL_TRANSPORT=smtp`). The server-side steps are also in [deploy.md → Email](deploy.md#email).

---

## 1. How it fits together

```
CarPal backend (API server 185.110.190.201)
   │  SMTP submission, TLS, mailbox login (port 465, or 587 with STARTTLS)
   ▼
mail.carpals.ir (your cPanel host, 89.44.243.175, Exim)
   │  signs the message (DKIM), sends it out under carpals.ir (SPF passes)
   ▼
the person's inbox (Gmail, Yahoo, …)
```

- The backend **logs in to one mailbox** (default `no-reply@carpals.ir`) and hands each message to the cPanel mail server, the same way a phone mail app sends mail.
- The API server must **never send mail on its own**. Your SPF record ends in `-all` and lists only the mail hosts, so mail coming straight from the API server would be rejected or marked as spam.
- **Roundcube is only the web reader** of a mailbox. The backend does not use it. You use it to read replies, bounces and the administrators' sign-in codes.

What the backend sends: sign-in codes, email verification links, password-reset links, security notices, invitations, notifications, and the morning exchange-rate reminder. It sends transactional mail only, never bulk or marketing mail (the host's terms forbid it).

---

## 2. Create the sending mailbox

1. Log in to **cPanel** for carpals.ir.
2. Open **Email → Email Accounts → + Create**.
3. Fill in:
   - **Domain:** `carpals.ir`
   - **Username:** `no-reply` (the address becomes `no-reply@carpals.ir`)
   - **Password:** click **Generate**. Use a long random password (20+ characters) and save it in your password manager. This password is used **only** by the backend.
   - **Storage:** 250 MB is enough. Bounces and stray replies land here.
   - Leave "Send a welcome email" unticked.
4. Click **Create**.

> Use letters and digits in this password if you can. Any `@ : / %` in it must be written percent-encoded in the backend setting (see section 7).

---

## 3. Read the SMTP settings from cPanel

1. In **Email Accounts**, find `no-reply@carpals.ir` and click **Connect Devices**.
2. Under **Mail Client Manual Settings → Secure SSL/TLS Settings (Recommended)**, write down:
   - **Outgoing Server:** `mail.carpals.ir`
   - **SMTP Port:** `465` (SSL/TLS)
   - **Username:** `no-reply@carpals.ir`
   - "Authentication is required for IMAP, POP3, and SMTP."

These were checked from outside on 2026-11-16: port 465 has a valid certificate for `mail.carpals.ir` and accepts login, and port 587 accepts STARTTLS. Use 465 unless the API server cannot reach it (section 8).

---

## 4. Create the administrators' mailboxes

Staff sign in to the admin console with their email address, and the **sign-in codes go to that mailbox**. Create one mailbox per administrator (owner decision DQ-26):

| Mailbox               | Holder                    |
| --------------------- | ------------------------- |
| `admin100@carpals.ir` | first main administrator  |
| `admin200@carpals.ir` | second main administrator |
| `admin300@carpals.ir` | third main administrator  |

For each one, repeat section 2 with its own generated password, and give that mailbox password to its holder only.

Rules:

- **Only the holder reads the mailbox.** Anyone who can read it, and knows the shared initial console password, could get as far as the password-change step. Do not share these mailboxes, and do not forward them to a shared inbox.
- The holder reads it in Roundcube (section 6) or in a phone mail app (IMAP `mail.carpals.ir:993`, SSL).
- The mailbox password and the **console** password are two different passwords. Never reuse one for the other.
- When the backup administrator, the moderator and the community reviewer are named, give each a mailbox only they read (the backup administrator's mailbox is especially sensitive: deploy.md "The backup administrator").

---

## 5. Check deliverability (SPF, DKIM, DMARC)

1. Open **Email → Email Deliverability**.
2. `carpals.ir` should show **Valid** for both **DKIM** and **SPF**. If either shows a problem, click **Manage** and use **Install the suggested record**.
   - SPF today: `v=spf1 mx a:mailgw-c.getway.biz a:imailgw-c.getway.biz -all`. This is correct for sending through the cPanel server. **Do not add the API server's IP**: mail must go through `mail.carpals.ir`.
   - DKIM: `default._domainkey.carpals.ir` is published, and cPanel signs outgoing mail with it.
3. **DMARC** is `p=none` today (monitoring only). To receive the reports, set the record in **Domains → Zone Editor → carpals.ir → Manage**, record `_dmarc` (TXT):

   ```
   v=DMARC1; p=none; rua=mailto:dmarc@carpals.ir; fo=1
   ```

   Create a `dmarc@carpals.ir` mailbox to collect the reports. After a few weeks of clean reports during the pilot, change `p=none` to `p=quarantine`.

---

## 6. Using Roundcube

Open `https://mail.carpals.ir/` (or **cPanel → Email Accounts → Check Email** next to the mailbox) and log in with the mailbox address and its password.

**`no-reply@carpals.ir`: look in once a week.**

- **Bounces** (`Mail Delivery System` / `Undelivered Mail`) mean a person's address does not work or their server refused the message. A few are normal. Many in a short time mean something is wrong: check **cPanel → Email → Track Delivery** and the backend's Delivery health page in the admin console.
- **Replies:** people sometimes answer an automatic email. Choose one of these:
  - **Autoresponder** (recommended): **cPanel → Email → Autoresponders → Add Autoresponder** for `no-reply@carpals.ir`. Body: "This mailbox is not read. For help, use Support in the CarPal app." (Write it in Persian and English.) Set the interval to 24 hours so a person gets it at most once a day.
  - **Reply-To:** create `support@carpals.ir` and set `CARPAL_MAIL_REPLY_TO='support@carpals.ir'` in `backend.env`. Replies then go to support, and someone must read that mailbox.
- **Do not delete the mailbox** and do not let it fill up. A full mailbox does not stop sending, but you lose the bounces. Roundcube → **Settings → Folders** shows the size. Empty **Trash** now and then.

**The administrators' mailboxes:** each holder logs in here to read their sign-in code during the console sign-in. Codes are valid for a few minutes. If a code does not arrive within a minute, look in **Spam/Junk** first.

**Optional Roundcube filters:** **Settings → Filters → Create** can move bounces in `no-reply` into a "Bounces" folder (rule: _From contains_ `mailer-daemon`).

---

## 7. Put the settings into the backend

On the API server, edit `/carpal/config/backend.env` (as root):

```bash
CARPAL_MAIL_TRANSPORT=smtp
CARPAL_SMTP_URL='smtps://no-reply%40carpals.ir:THE_PASSWORD@mail.carpals.ir:465'
CARPAL_MAIL_FROM='CarPal <no-reply@carpals.ir>'
CARPAL_MAIL_MAX_PER_HOUR=300
# CARPAL_MAIL_REPLY_TO='support@carpals.ir'     # only if you chose the Reply-To option
```

- The `@` in the username is written `%40`. If the password contains special characters, encode them the same way:

  | Character | Write |
  | --------- | ----- |
  | `@`       | `%40` |
  | `:`       | `%3A` |
  | `/`       | `%2F` |
  | `%`       | `%25` |
  | `#`       | `%23` |
  | `?`       | `%3F` |

  Keep the whole URL in single quotes, and do not use a single quote inside the password.

- To use port 587 instead: `CARPAL_SMTP_URL='smtp://no-reply%40carpals.ir:THE_PASSWORD@mail.carpals.ir:587'`. The backend then requires STARTTLS and never sends unencrypted.
- **Hourly limit.** Shared hosting caps how many messages a domain may send per hour. Ask the host for your plan's number (cPanel does not show it to you) and set `CARPAL_MAIL_MAX_PER_HOUR` below it (default 300). Above the cap, ordinary notifications wait for the next hour, while sign-in codes and security notices always go out.

Then test and restart:

```bash
# 1. Can this server reach the mail server? Expect "Verification: OK".
openssl s_client -connect mail.carpals.ir:465 -servername mail.carpals.ir -brief </dev/null

# 2. Send one test message with the backend's own settings (the password is never printed).
sudo bash /carpal/backend/src/backend/deploy/mail-test.sh you@example.com

# 3. Restart the backend so it uses the new settings.
sudo bash /carpal/backend/src/backend/deploy/4-start.sh
```

Last, sign in to the admin console with an administrator account. The sign-in code should arrive in that administrator's mailbox.

---

## 8. Troubleshooting

| What you see                                                                             | Likely cause                                                                                 | What to do                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openssl` hangs or "Connection timed out"                                                | The hosting firewall blocks the API server, or the API server's provider blocks outgoing 465 | Try port 587 (`openssl s_client -starttls smtp -connect mail.carpals.ir:587`). Otherwise ask the cPanel host to allow SMTP from `185.110.190.201`, and the VPS provider to allow outgoing 465/587. |
| `mail:test` says `EAUTH 535`                                                             | Wrong mailbox password, or `@` not written as `%40`                                          | Reset the mailbox password in cPanel (**Email Accounts → Manage → Security**), update `CARPAL_SMTP_URL`, test again.                                                                               |
| Logins worked, then suddenly fail for everyone                                           | cPanel's brute-force protection (cPHulk) blocked the API server after failed logins          | Fix the password first. Then ask the host to unblock `185.110.190.201` (and whitelist it, if they agree).                                                                                          |
| `certificate` / `self signed` error                                                      | The mail server's certificate expired, or the URL uses a different host name                 | Use exactly `mail.carpals.ir`. In cPanel, **SSL/TLS Status → Run AutoSSL**.                                                                                                                        |
| Test mail lands in Spam                                                                  | New domain reputation, or SPF/DKIM not valid                                                 | Check section 5. Mark the message "Not spam" in the receiving mailbox. Ask the first pilot users to do the same.                                                                                   |
| `550` / "sending limit exceeded" in Delivery health                                      | The host's hourly or daily cap was reached                                                   | Lower `CARPAL_MAIL_MAX_PER_HOUR`, and ask the host for the real limit.                                                                                                                             |
| Admin did not get a sign-in code                                                         | Spam folder, a full mailbox, or mail not set up yet                                          | Check Spam. Check **Track Delivery** in cPanel for that address. Before mail is set up, the code is in `/carpal/data/outbox-mail.jsonl` on the server.                                             |
| The backend does not start after the change: `CARPAL_SMTP_URL … needs the mailbox login` | The URL has no `user:password@` part                                                         | Fix the URL as in section 7.                                                                                                                                                                       |

---

## 9. Changing the mailbox password later

1. In cPanel, **Email Accounts → no-reply → Manage**, set a new password.
2. Put it into `CARPAL_SMTP_URL` in `/carpal/config/backend.env` (percent-encoded).
3. Run `mail:test` (section 7), then `4-start.sh`.

Mail that comes due between steps 1 and 3 fails for a few minutes and is retried, so nothing is lost. Change the password at once if you think it may have leaked, and in any case once a year.
