# ADMIN ACCOUNT RECOVERY

## Overview

This document describes the emergency procedure for recovering access to the BIK Prestige Enterprise administrator account when:

- The admin has forgotten their password
- The normal password reset flow is unavailable
- The recovery email channel is not configured

**Self-service password recovery** is available through the `/forgot-password` flow. This emergency procedure is for situations where self-service recovery cannot be used.

---

## Emergency Recovery Procedure

### Prerequisites

The person performing recovery must have:

1. Access to the **Render dashboard** (or equivalent hosting platform)
2. Access to the **PostgreSQL database** through an approved administration tool
3. Verified identity as the **business owner or authorized operator**

### Step-by-Step

#### 1. Access the Database

Log in to the Render dashboard → navigate to the PostgreSQL database → open the Data Explorer (or use `psql` / any approved database client).

#### 2. Identify the Admin Account

```sql
SELECT id, email, "tokenVersion", "forcePasswordReset"
FROM "User"
WHERE role = 'admin' AND status = 'active';
```

Note the admin user's `id`.

#### 3. Generate a Temporary Password

Choose a strong temporary password (at least 8 characters, with an uppercase letter and a number). **Do not reuse any previously used password.**

#### 4. Hash the Password (via the application)

The application uses **bcrypt with cost 12**. Use the application's own hashing utility:

```bash
# From the project root on Render Shell or locally
node -e "require('bcryptjs').hash('YourTempPassword123', 12).then(h => console.log(h))"
```

Copy the resulting hash.

#### 5. Update the Database

```sql
UPDATE "User"
SET
  "passwordHash" = '<paste bcrypt hash here>',
  "forcePasswordReset" = true,
  "tokenVersion" = "tokenVersion" + 1
WHERE id = '<admin-user-id>';
```

**What this does:**
- Sets the temporary password
- Forces password change at next login
- Invalidates ALL existing sessions (tokenVersion bump)

#### 6. Admin Logs In

1. Go to `https://bik-prestige-enterprise-pcxi.onrender.com/login`
2. Log in with the admin email and the temporary password
3. The system will redirect to **Settings → Change Password**
4. Choose a new strong password
5. Confirm the new password

#### 7. Verify

- Confirm you can access the admin dashboard
- Confirm you can access Settings
- Confirm old sessions (other tabs/devices) are logged out
- Check the Activity History (`/admin/audit`) for the recovery event

#### 8. Record the Event

Note the following in your operational records:
- Date and time of recovery
- Who performed the recovery
- Reason for recovery
- That the admin password was changed

---

## What NOT to Do

- **Do NOT** create a "master password" or backdoor credential in the codebase
- **Do NOT** put recovery secrets in `.env`, source code, or version control
- **Do NOT** create a public API endpoint that accepts a recovery code
- **Do NOT** bypass the normal authentication system with static credentials

---

## Normal Password Reset Flow

For users who can access their email:

1. Go to `/login`
2. Click **Forgot password?**
3. Enter email address
4. Check email for recovery instructions (when email is configured)
5. Follow the link to `/reset-password`
6. Enter the recovery token and new password

**Currently (Pilot):** Email is not yet configured. The recovery token is displayed on-screen for manual distribution. This will be replaced by email delivery in production.

---

## Token Security Properties

| Property | Implementation |
|----------|---------------|
| Randomness | `crypto.randomBytes(32)` — 256 bits of entropy |
| Storage | SHA-256 hash only — raw token never stored |
| Expiry | 15 minutes from creation |
| Single-use | Marked as `usedAt` after successful reset |
| Scope | One token per user — new request invalidates old tokens |
| Enumeration protection | Generic response regardless of email existence |
| Rate limiting | 5 requests per 15 minutes per email |

---

## Known Limitations

1. **No email channel configured** — Recovery tokens must be manually distributed during pilot
2. **In-memory rate limiting** — Resets on server restart (sufficient for pilot)
3. **No SMS fallback** — Only token-based recovery is implemented

These will be addressed in the production hardening phase.

---

## Database Access

The Render PostgreSQL database can be accessed through:
- Render Dashboard → Data Explorer
- `psql` via Render Shell
- Approved database administration tool

**Never share database credentials.** Access must be through the approved hosting account only.
