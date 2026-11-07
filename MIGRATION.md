# MaaCash — PostgreSQL Migration Guide

> Formerly BloomCore One / BIK Prestige Enterprise. Database identifiers are
> unchanged by the product rebrand.

## Overview

The platform has been migrated from SQLite to PostgreSQL for production use. This document covers the complete migration process, verification steps, and rollback procedures.

## Prerequisites

1. PostgreSQL 14+ installed and running
2. A database created for the application
3. Network access to the database server

## Migration Steps

### 1. Back Up SQLite Data

Before any migration, create a backup of the current SQLite database:

```bash
# Copy the SQLite database file
cp prisma/dev.db prisma/dev.db.backup.$(date +%Y%m%d_%H%M%S)

# Verify backup exists
ls -la prisma/dev.db.backup.*
```

### 2. Export Data from SQLite

```bash
# Export all data to JSON using Prisma
npx prisma db execute --stdin --url="file:./dev.db" <<'EOF'
-- Export queries can be run via the application
EOF
```

Alternatively, use the seed script with a modified database URL to export data.

### 3. Create PostgreSQL Database

```sql
-- Connect as superuser
CREATE DATABASE bik_prestige;
CREATE USER bik_prestige_user WITH PASSWORD 'secure_password_here';
GRANT ALL PRIVILEGES ON DATABASE bik_prestige TO bik_prestige_user;
ALTER DATABASE bik_prestige SET timezone = 'Africa/Accra';
```

### 4. Update DATABASE_URL

Update your `.env` file:

```bash
# Production PostgreSQL connection
DATABASE_URL="postgresql://bik_prestige_user:secure_password_here@localhost:5432/bik_prestige?schema=public"
```

### 5. Apply Schema

```bash
# Generate Prisma client
npx prisma generate

# Apply migrations
npx prisma migrate deploy

# Verify schema
npx prisma db pull
```

### 6. Migrate Data

Use the data migration script to transfer data from SQLite to PostgreSQL:

```bash
# Run the migration script
npx tsx prisma/migrate-data.ts
```

### 7. Verify Migration

```bash
# Count rows in all tables
npx prisma db execute --stdin --url="$DATABASE_URL" <<'EOF'
SELECT 'User' as table_name, COUNT(*) as row_count FROM "User"
UNION ALL SELECT 'Location', COUNT(*) FROM "Location"
UNION ALL SELECT 'DailyAccount', COUNT(*) FROM "DailyAccount"
UNION ALL SELECT 'Expense', COUNT(*) FROM "Expense"
UNION ALL SELECT 'AuditLog', COUNT(*) FROM "AuditLog"
UNION ALL SELECT 'Customer', COUNT(*) FROM "Customer"
UNION ALL SELECT 'SusuAccount', COUNT(*) FROM "SusuAccount"
UNION ALL SELECT 'SusuCycle', COUNT(*) FROM "SusuCycle"
UNION ALL SELECT 'Contribution', COUNT(*) FROM "Contribution"
UNION ALL SELECT 'ContributionAllocation', COUNT(*) FROM "ContributionAllocation"
UNION ALL SELECT 'Withdrawal', COUNT(*) FROM "Withdrawal"
UNION ALL SELECT 'Commission', COUNT(*) FROM "Commission"
UNION ALL SELECT 'CardFee', COUNT(*) FROM "CardFee"
UNION ALL SELECT 'Collector', COUNT(*) FROM "Collector"
UNION ALL SELECT 'CollectorCustomerAssignment', COUNT(*) FROM "CollectorCustomerAssignment"
UNION ALL SELECT 'CollectorRemittance', COUNT(*) FROM "CollectorRemittance";
EOF
```

### 8. Run Tests

```bash
# Run all tests against PostgreSQL
DATABASE_URL="$DATABASE_URL" npm test

# Run type checking
npm run typecheck

# Run build
npm run build
```

## Schema Changes (SQLite → PostgreSQL)

The following changes were made during migration:

1. **Provider**: `sqlite` → `postgresql`
2. **Decimal handling**: SQLite stores decimals as text; PostgreSQL uses native `DECIMAL(65,30)`
3. **Boolean handling**: SQLite stores booleans as integers; PostgreSQL uses native `BOOLEAN`
4. **DateTime handling**: SQLite stores datetimes as text; PostgreSQL uses native `TIMESTAMP(3)`
5. **Auto-increment**: SQLite uses `ROWID`; PostgreSQL uses `SERIAL` or `GENERATED ALWAYS AS IDENTITY`
6. **Unique constraints**: Fully supported in both providers
7. **Foreign keys**: Fully supported in both providers with `ON DELETE` and `ON UPDATE` actions
8. **Indexes**: Fully supported in both providers
9. **JSON handling**: Not used in this schema
10. **Raw SQL**: No raw SQL queries in the application

## Financial Record Verification

After migration, verify the following for representative accounts:

### Commission Verification
```
Commission amount = dailyContribution (one day's contribution)
Commission frequency = once per cycle
Commission basis = "one_day_contribution"
Commission triggeredBy = "first_withdrawal"
```

### Balance Verification
```
Remaining customer savings = Gross contributions - commissions - completed withdrawals
```

### Allocation Verification
```
Days allocated = floor(contributionAmount / dailyContribution)
Allocated amount = daysAllocated * dailyContribution
Unallocated amount = contributionAmount - allocatedAmount
```

## Rollback Procedure

If migration fails:

1. Stop the application
2. Restore SQLite database:
   ```bash
   cp prisma/dev.db.backup.* prisma/dev.db
   ```
3. Revert schema:
   ```bash
   # Change provider back to sqlite in schema.prisma
   npx prisma generate
   ```
4. Restart the application

## Production Environment Variables

Required environment variables for production:

```bash
DATABASE_URL="postgresql://user:password@host:5432/bik_prestige?schema=public"
JWT_SECRET="<strong-random-secret>"
NODE_ENV="production"
NEXTAUTH_URL="https://your-domain.com"
```

## Security Notes

1. Never commit production credentials to version control
2. Use environment variables for all secrets
3. Rotate JWT secrets periodically
4. Use SSL/TLS for database connections in production
5. Restrict database user permissions to minimum required

## Monitoring

After migration, monitor:

1. Database connection pool health
2. Query performance (especially for reports)
3. Transaction success rates
4. Error rates on financial operations
5. Audit log completeness

## Backup Strategy

### Daily Backups

```bash
# Automated daily backup script
pg_dump -U bik_prestige_user -d bik_prestige -F c -f backup_$(date +%Y%m%d).dump
```

### Weekly Full Backups

```bash
# Full backup with compression
pg_dump -U bik_prestige_user -d bik_prestige -F c -Z 9 -f backup_full_$(date +%Y%m%d).dump
```

### Backup Retention

- Keep 7 daily backups
- Keep 4 weekly backups
- Keep 12 monthly backups
- Store backups in a separate location from the database server

## Recovery Testing

Test recovery procedure quarterly:

1. Restore backup to a test database
2. Verify row counts match expected values
3. Run business logic tests
4. Verify financial calculations are correct
5. Document any issues found

## Performance Considerations

1. **Connection Pooling**: Use PgBouncer or similar for production
2. **Index Optimization**: Review query patterns and add indexes as needed
3. **Query Analysis**: Use `EXPLAIN ANALYZE` for slow queries
4. **Connection Limits**: Configure appropriate `max_connections`
5. **Memory Settings**: Tune `shared_buffers` and `work_mem`

## Appendix: Table Schema Summary

| Table | Primary Key | Unique Constraints | Indexes |
|-------|-------------|-------------------|---------|
| User | id (cuid) | email | role, status, locationId |
| Location | id (cuid) | code | status, code |
| DailyAccount | id (cuid) | (locationId, businessDate) | businessDate, locationId, workerId, status, submittedAt |
| Expense | id (cuid) | - | dailyAccountId |
| AuditLog | id (cuid) | - | userId, (entityType, entityId), createdAt |
| Customer | id (cuid) | customerId | status, customerId, phone |
| SusuAccount | id (cuid) | accountId | customerId, accountId, status |
| SusuCycle | id (cuid) | (accountId, cycleNumber) | accountId, status, startDate |
| Contribution | id (cuid) | referenceId | accountId, cycleId, collectionDate, channel, collectorId, referenceId |
| ContributionAllocation | id (cuid) | - | contributionId, cycleDay |
| Withdrawal | id (cuid) | referenceId | accountId, cycleId, createdAt, referenceId |
| Commission | id (cuid) | - | accountId, cycleId |
| CardFee | id (cuid) | - | accountId |
| Collector | id (cuid) | userId | status |
| CollectorCustomerAssignment | id (cuid) | (collectorId, accountId) | collectorId, customerId, accountId |
| CollectorRemittance | id (cuid) | referenceId | collectorId, status, createdAt, referenceId |
