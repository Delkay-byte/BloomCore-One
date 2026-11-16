# BIK Prestige Enterprise — Pilot Runbook

## Environments

| Environment | Badge | Database | Port | Purpose |
|-------------|-------|----------|------|---------|
| **Development** | DEVELOPMENT | SQLite `prisma/dev.db` | 3000 | Coding, UI dev, safe experimentation |
| **Staging** | STAGING | PostgreSQL `bik_prestige` | 3000 | Testing, rehearsals, migrations |
| **Pilot** | PILOT | PostgreSQL `bik_pilot` | 3456 | Controlled real-world pilot |
| **Production** | *(no badge)* | PostgreSQL (future) | — | Full deployment |

**Critical rule:** The application NEVER silently switches databases. The active database comes exclusively from `DATABASE_URL`. If configuration is missing or invalid, the application fails clearly rather than falling back to development.

---

## Session Security Policy

**For security, BIK Prestige automatically signs users out after inactivity or when the application has been left in the background for the configured period.**

| Policy | Value | What Happens |
|--------|-------|-------------|
| **Inactivity timeout** | 5 minutes | Warning appears at 60 seconds, then forced sign-out |
| **Background timeout** | 60 seconds | Switching away from the app starts a 60-second timer |
| **Absolute session lifetime** | 15 minutes | Forced sign-out regardless of activity |

### What Users Should Know
- If you don&apos;t interact with the app for 5 minutes, you&apos;ll be signed out
- If you switch to another app or browser tab for more than 60 seconds, you&apos;ll be signed out
- After 15 minutes, you must sign in again even if you&apos;re actively working
- **Save your work before stepping away**
- Sensitive operations (password resets, withdrawals) require re-entering your password

### For Administrators
- All session events are logged in the audit trail
- You can review session timeouts at `/admin/audit`
- Password resets invalidate all of a user&apos;s sessions
- Step-up authentication is required for password resets and withdrawals

---

## Login & Access URLs

The platform uses a **unified non-admin login** plus a **separate admin login**.

| Audience            | URL                        | Notes                                        |
| ------------------- | -------------------------- | -------------------------------------------- |
| Everyone (non-admin)| `/login`                   | Shared portal — pick your role on the screen |
| Access Guide        | `/access`                  | Public page listing all four options         |
| Customer            | `/login/customer`          | Short link → preselects Customer             |
| MoMo Agent          | `/login/momo`              | Short link → preselects MoMo Agent           |
| Susu Collector      | `/login/susu`              | Short link → preselects Susu Collector       |
| Customer (legacy)   | `/login?role=customer`     | Pre-selects the Customer card                |
| MoMo (legacy)       | `/login?role=momo`         | Pre-selects the MoMo Agent card              |
| Susu (legacy)       | `/login?role=susu`         | Pre-selects the Susu Collector card          |
| Administrator       | `/admin/login`             | Separate, privileged boundary                |

- `/login/customer`, `/login/momo`, `/login/susu` are **redirects only** — they
  do not create separate authentication systems; each simply opens `/login`
  with the role preselected.
- `/login/admin` is intentionally **not** a shared-login route; admin always
  uses `/admin/login`.
- The `/access` page is public (no authentication) and suitable for posters,
  WhatsApp sharing, and future QR codes. It shows only public login URLs.

- The shared `/login` page shows **only** Customer, MoMo Agent and Susu Collector.
  **Admin is never offered there.**
- Selecting a role is only a *requested workspace*. The server re-checks the
  selection against the account's real capabilities; a mismatch is denied
  (e.g. a customer cannot open the MoMo dashboard, and vice versa).
- Legacy `/customer/login` still works and redirects to
  `/login?role=customer` for backwards compatibility.
- Each role keeps its own independent session cookie
  (`bik-customer-session`, `bik-worker-session`, `bik-collector-session`,
  `bik-admin-session`). They are never merged into one unrestricted cookie.

---

## 1. Start PostgreSQL (Pilot)

```bash
# Docker (recommended)
docker run -d --name bik-prestige-pg \
  -e POSTGRES_USER=bik \
  -e POSTGRES_PASSWORD=<STRONG_PASSWORD> \
  -e POSTGRES_DB=bik_pilot \
  -p 5433:5432 \
  postgres:16-alpine
```

## 2. Configure Environment

### Development (default)
`.env` already contains SQLite configuration. No changes needed.

### Pilot
1. Copy the pilot template:
   ```bash
   cp .env.pilot .env.pilot.local
   ```
2. Edit `.env.pilot.local` and fill in actual secrets:
   - `DATABASE_URL` — PostgreSQL connection to `bik_pilot`
   - `JWT_SECRET` — Generate with: `openssl rand -base64 32`
3. **NEVER commit `.env.pilot.local` to version control.**

**Required variables:**
- `DATABASE_URL` — PostgreSQL connection string
- `JWT_SECRET` — Strong random secret (application fails without it)
- `NODE_ENV` — Set to "production" for live deployment

## 3. Run Migrations

```bash
cd "Momo module"

# Generate Prisma client
npx prisma generate

# Apply schema to PostgreSQL
npx prisma db push

# Seed initial data
npx prisma db seed
# OR: npx tsx prisma/seed.ts
```

## 4. Start Application

### Development
```bash
npm run dev
# → http://localhost:3000
# → Badge: DEVELOPMENT
```

### Pilot
```bash
npm run pilot
# → http://localhost:3456
# → Badge: PILOT
```

# Production
npm run build
npm start
```

## 5. Run Tests

```bash
# Unit/business logic tests (SQLite — no PostgreSQL needed)
npm test

# Type checking
npm run typecheck

# Build verification
npm run build

# Linting
npm run lint
```

## 6. Backup Procedure

### Create Backup

```bash
# Using Docker
docker exec bik-prestige-pg pg_dump -U bik -d bik_prestige -Fc > backup_$(date +%Y%m%d).dump

# Using psql (if installed locally)
pg_dump -U bik -d bik_prestige -Fc > backup_$(date +%Y%m%d).dump
```

### Backup Schedule
- **Daily:** Automated backup at end of business day
- **Weekly:** Full compressed backup
- **Retention:** Keep 7 daily, 4 weekly, 12 monthly

### Backup Location
Store backups on a separate drive/server from the database.

## 7. Restore Procedure

```bash
# Create fresh database
docker exec bik-prestige-pg psql -U bik -d postgres -c "DROP DATABASE bik_prestige;"
docker exec bik-prestige-pg psql -U bik -d postgres -c "CREATE DATABASE bik_prestige;"

# Restore from backup
cat backup_YYYYMMDD.dump | docker exec -i bik-prestige-pg pg_restore -U bik -d bik_prestige --no-owner

# Re-apply schema if needed
npx prisma db push

# Verify data
npx tsx prisma/staging-rehearsal.ts
```

## 8. Dev Credentials (DO NOT USE IN PRODUCTION)

| Role | Email | Password |
|------|-------|----------|
| Admin | admin@bikprestige.com | Admin!Pass1234 |
| Worker 1 | kwame@bikprestige.com | Worker!Pass1234 (Accra Central) |
| Worker 2 | ama@bikprestige.com | Worker!Pass1234 (Kumasi) |
| Worker 3 | kofi@bikprestige.com | Worker!Pass1234 (Takoradi) |
| Worker 4 | efua@bikprestige.com | Worker!Pass1234 (Tamale) |
| Collector 1 | kwadwo@bikprestige.com | Collector!Pass1234 |
| Collector 2 | akosua@bikprestige.com | Collector!Pass1234 |

**For production:** Create new admin credentials immediately. Change all default passwords.

## 9. Production Migration Checklist

- [ ] PostgreSQL database created with strong credentials
- [ ] `DATABASE_URL` set in production environment
- [ ] `JWT_SECRET` generated and set (never reuse dev secret)
- [ ] `NODE_ENV=production` set
- [ ] Schema applied (`npx prisma db push`)
- [ ] Seed data loaded (or production data migrated)
- [ ] Admin password changed from default
- [ ] All worker passwords changed from defaults
- [ ] SSL/TLS enabled for database connections
- [ ] Backup schedule configured
- [ ] Monitoring configured

## 10. Troubleshooting

### "JWT_SECRET environment variable is required"
The application will not start without `JWT_SECRET`. Generate one:
```bash
openssl rand -base64 32
```

### "Can't reach database server"
Check PostgreSQL is running:
```bash
docker ps | grep bik-prestige-pg
docker exec bik-prestige-pg pg_isready -U bik
```

### "Table does not exist"
Run schema push:
```bash
npx prisma db push
```

### Slow queries
Check database indexes are in place:
```bash
npx prisma db pull  # Verify schema matches
```

## 11. Daily Closing Procedure

### MoMo Daily Close
1. Open admin dashboard (`/admin/dashboard`)
2. Check all active locations — identify submitted vs pending
3. Open any locations with discrepancy (non-zero variance)
4. Review submitted accounts for accuracy
5. Mark day complete when all locations reported

### Susu Daily Close
1. Open Susu admin dashboard (`/susu/admin`)
2. Check today's collections
3. Identify outstanding customers (who haven't paid)
4. Review collector totals
5. Review any new remittances
6. Review any new withdrawals
7. Verify commission amounts are correct
8. Compare digital totals against physical cards (parallel verification)
9. Close the day operationally

### End-of-Day Backup
```bash
docker exec bik-prestige-pg pg_dump -U bik -d bik_prestige -Fc > backup_$(date +%Y%m%d).dump
```

## 12. Pilot Environment

### Pilot Database
| Variable | Value |
|----------|-------|
| Container | `bik-prestige-pg` |
| Port | 5433 |
| Database | `bik_pilot` |
| User | `bik` |
| Pre-launch backup | `backups/pilot-pre-launch.dump` |

### Pilot .env
```
DATABASE_URL="postgresql://bik:<PASSWORD>@localhost:5433/bik_pilot?schema=public"
JWT_SECRET="<STRONG_SECRET>"
NODE_ENV="staging"
```

### Start for Pilot
```bash
cd "Momo module"
npm run build
# Start with pilot database
DATABASE_URL="postgresql://bik:<PASSWORD>@localhost:5433/bik_pilot?schema=public" npm start
```

## 13. Pilot Daily Review Procedure

### Morning (Before Business Day)
1. Confirm PostgreSQL is running: `docker ps | grep bik-prestige-pg`
2. Confirm application is running
3. Confirm all pilot users can log in
4. Review any overnight issues

### During Day
- Observe users naturally (don't coach excessively)
- Record any hesitations or confusion
- Note any workarounds users create

### Evening (After Business Day)
1. Open admin dashboard
2. Check MoMo: who submitted, who didn't, discrepancies
3. Check Susu: collections, outstanding, withdrawals, commissions
4. Compare digital records against physical cards/manual records
5. Record discrepancies in `PILOT-FEEDBACK.md`
6. Create daily backup:
   ```bash
   docker exec bik-prestige-pg pg_dump -U bik -d bik_pilot -Fc > backups/pilot-$(date +%Y%m%d).dump
   ```
7. Update `PILOT-GO-LIVE-REPORT.md` with daily activity

## 14. Pilot Expansion Checklist

Before expanding the pilot:
- [ ] No Critical defects in current scope
- [ ] No High financial/security defects
- [ ] Workers can operate independently
- [ ] Owner can monitor remotely
- [ ] Physical vs digital records match
- [ ] Backup procedure is routine
- [ ] Users have provided feedback
- [ ] Feedback has been reviewed

## 15. Emergency Procedures

### Database Down
1. Check Docker: `docker ps`
2. Restart: `docker restart bik-prestige-pg`
3. If data corruption: restore from latest backup

### Application Down
1. Check logs: `docker logs <container>` or PM2 logs
2. Restart: `npm start` or restart process manager
3. Verify database connectivity

### Security Incident
1. Change `JWT_SECRET` immediately (invalidates all sessions)
2. Change admin passwords
3. Review audit logs: `/admin/audit`
4. Check for unauthorized access
