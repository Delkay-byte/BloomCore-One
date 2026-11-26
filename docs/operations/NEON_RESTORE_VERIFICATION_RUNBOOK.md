# Neon provider restore verification runbook

Owner action only. Do not create, delete or restore a production Neon branch in
this task. No credential appears in this document.

1. In Neon console, confirm the project's PITR/backup window and record it.
2. Select a restore timestamp before the target change; record it locally.
3. Restore to a **new, separate** Neon branch or database, never over production.
4. Keep the restored connection string in the owner's secret store only.
5. Run `npx prisma migrate status --config prisma.pg.config.ts` against that branch.
6. Compare aggregate table counts with the expected snapshot; record counts only.
7. Verify tenant, MoMo, Susu, transaction, audit and risk-intelligence key links.
8. Connect an isolated app instance to the restored branch; do not expose it.
9. Exercise health, readiness, login and read-only business journeys.
10. Record restore duration, any data-loss window and all manual steps.

Navigation labels are provider-version dependent and **Unverified** here; verify
them in the live console before executing. Status: **Owner action required**.
