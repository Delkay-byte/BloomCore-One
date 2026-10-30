# UI Transformation Route Checklist — Phase 2

Every route below is reviewed during the transformation. A route is marked
**done** only when its layout, states (loading/empty/error), forms, tables,
responsive behaviour and accessibility have actually been reviewed and updated
as needed — not merely because it inherits global styles.

Legend: `[ ]` pending · `[x]` done

## Root & auth (12)
- [ ] `/` — redirect shim
- [ ] `/login` (UnifiedLoginClient — role picker + password form)
- [ ] `/login/momo` · `/login/susu` · `/login/customer` — redirect shims
- [ ] `/select-workspace`
- [ ] `/access` — QR sign-in hub
- [ ] `/forgot-password`
- [ ] `/reset-password`
- [ ] `/change-password` (ChangePasswordForm)
- [ ] `/settings` — redirect shim
- [ ] `/unauthorized`

## Platform control plane (7)
- [ ] `/platform/login`
- [ ] `/platform/dashboard`
- [ ] `/platform/tenants`
- [ ] `/platform/tenants/new` (wizard)
- [ ] `/platform/tenants/[id]`
- [ ] `/platform/audit`
- [ ] `/platform/settings`

## Tenant admin — MoMo (15)
- [ ] `/admin/login`
- [ ] `/admin/dashboard`
- [ ] `/admin/locations` · `/admin/locations/[id]`
- [ ] `/admin/workers` · `/admin/workers/[id]`
- [ ] `/admin/history` (MoMo Money & History)
- [ ] `/admin/reports` · `/admin/reports/[id]`
- [ ] `/admin/staff` · `/admin/staff/[id]`
- [ ] `/admin/audit`
- [ ] `/admin/settings` (SettingsView) · `/admin/devices` (redirect shim)

## Susu admin (9)
- [ ] `/susu/admin` (overview)
- [ ] `/susu/admin/customers`
- [ ] `/susu/admin/customers/[id]`
- [ ] `/susu/admin/collectors`
- [ ] `/susu/admin/contributions`
- [ ] `/susu/admin/withdrawals`
- [ ] `/susu/admin/remittances` (Money Handed In)
- [ ] `/susu/admin/history` (Susu Money & History)
- [ ] `/susu/admin/reports`

## MoMo worker (3)
- [ ] `/worker/dashboard`
- [ ] `/worker/daily/[id]` (daily account wizard)
- [ ] `/worker/settings` (SettingsView)

## Collector (2)
- [ ] `/collector/dashboard` (field hub + offline)
- [ ] `/collector/settings` (SettingsView)

## Customer portal (8)
- [ ] `/customer/login` (redirect shim) · `/customer/forgot-password`
- [ ] `/customer/dashboard`
- [ ] `/customer/payments`
- [ ] `/customer/withdrawals`
- [ ] `/customer/statement`
- [ ] `/customer/profile`
- [ ] `/customer/settings`

## Shared components & shells
- [ ] `globals.css` tokens + component classes
- [ ] `ui/` primitives (Modal, ConfirmDialog, Toast, Badge, EmptyState, Skeleton, PageHeader, StatCard, DataTable, Pagination, FilterChips)
- [ ] icons (lucide) replacing emoji across navs/buttons/empty states
- [ ] admin + susu-admin layout de-duplication (shared AppShell)
- [ ] platform shell restyle
- [ ] worker/collector/customer field shells
- [ ] root `loading.tsx` / `error.tsx` / `not-found.tsx`
- [ ] root viewport a11y (allow pinch-zoom)

## Runtime verification
- [ ] 360px · [ ] 390px · [ ] 768px · [ ] 1024px · [ ] 1440px (browser emulation; no physical Android device)
- [ ] keyboard/a11y pass (SmartSearch, dialogs, forms, nav)
