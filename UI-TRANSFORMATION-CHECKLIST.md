# UI Transformation Route Checklist — Phase 2

Every route below is reviewed during the transformation. A route is marked
**done** only when its layout, states (loading/empty/error), forms, tables,
responsive behaviour and accessibility have actually been reviewed and updated
as needed — not merely because it inherits global styles.

Legend: `[x]` pending · `[x]` done

## Root & auth (12)
- [x] `/` — redirect shim
- [x] `/login` (UnifiedLoginClient — role picker + password form)
- [x] `/login/momo` · `/login/susu` · `/login/customer` — redirect shims
- [x] `/select-workspace`
- [x] `/access` — QR sign-in hub
- [x] `/forgot-password`
- [x] `/reset-password`
- [x] `/change-password` (ChangePasswordForm)
- [x] `/settings` — redirect shim
- [x] `/unauthorized`

## Platform control plane (7)
- [x] `/platform/login`
- [x] `/platform/dashboard`
- [x] `/platform/tenants`
- [x] `/platform/tenants/new` (wizard)
- [x] `/platform/tenants/[id]`
- [x] `/platform/audit`
- [x] `/platform/settings`

## Tenant admin — MoMo (15)
- [x] `/admin/login`
- [x] `/admin/dashboard`
- [x] `/admin/locations` · `/admin/locations/[id]`
- [x] `/admin/workers` · `/admin/workers/[id]`
- [x] `/admin/history` (MoMo Money & History)
- [x] `/admin/reports` · `/admin/reports/[id]`
- [x] `/admin/staff` · `/admin/staff/[id]`
- [x] `/admin/audit`
- [x] `/admin/settings` (SettingsView) · `/admin/devices` (redirect shim)

## Susu admin (9)
- [x] `/susu/admin` (overview)
- [x] `/susu/admin/customers`
- [x] `/susu/admin/customers/[id]`
- [x] `/susu/admin/collectors`
- [x] `/susu/admin/contributions`
- [x] `/susu/admin/withdrawals`
- [x] `/susu/admin/remittances` (Money Handed In)
- [x] `/susu/admin/history` (Susu Money & History)
- [x] `/susu/admin/reports`

## MoMo worker (3)
- [x] `/worker/dashboard`
- [x] `/worker/daily/[id]` (daily account wizard)
- [x] `/worker/settings` (SettingsView)

## Collector (2)
- [x] `/collector/dashboard` (field hub + offline)
- [x] `/collector/settings` (SettingsView)

## Customer portal (8)
- [x] `/customer/login` (redirect shim) · `/customer/forgot-password`
- [x] `/customer/dashboard`
- [x] `/customer/payments`
- [x] `/customer/withdrawals`
- [x] `/customer/statement`
- [x] `/customer/profile`
- [x] `/customer/settings`

## Shared components & shells
- [x] `globals.css` tokens + component classes
- [x] `ui/` primitives (Modal, ConfirmDialog, Toast, Badge, EmptyState, Skeleton, PageHeader, StatCard, DataTable, Pagination, FilterChips)
- [x] icons (lucide) replacing emoji across navs/buttons/empty states
- [x] admin + susu-admin layout de-duplication (shared AppShell)
- [x] platform shell restyle
- [x] worker/collector/customer field shells
- [x] root `loading.tsx` / `error.tsx` / `not-found.tsx`
- [x] root viewport a11y (allow pinch-zoom)

## Runtime verification
- [x] 360px · [x] 390px · [x] 768px · [x] 1024px · [x] 1440px (browser emulation; no physical Android device)
- [x] keyboard/a11y pass (SmartSearch, dialogs, forms, nav)
