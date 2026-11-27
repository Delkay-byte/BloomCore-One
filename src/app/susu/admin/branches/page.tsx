import { db } from "@/lib/db";
import { requireTenantAdminSusu } from "@/lib/tenant";
import { isCompanyWideAdmin } from "@/lib/branch";
import {
  createBranchForm,
  createBranchManagerForm,
  toggleBranchForm,
} from "@/lib/actions/branch-form.actions";

export const metadata = { title: "Branches — MaaCash Susu" };
export const dynamic = "force-dynamic";

/**
 * Minimal branch administration. Company-wide administrators manage branches;
 * branch-scoped administrators only see the branches they hold a membership for.
 */
export default async function SusuBranchesPage() {
  const ctx = await requireTenantAdminSusu();
  const [branches, companyWide] = await Promise.all([
    db.location.findMany({
      where: { tenantId: ctx.tenantId },
      orderBy: { name: "asc" },
      select: { id: true, name: true, code: true, status: true },
    }),
    isCompanyWideAdmin(ctx),
  ]);
  const memberships = await db.branchMembership.findMany({
    where: { tenantId: ctx.tenantId, status: "active" },
    select: { locationId: true, role: true, userId: true },
  });

  return (
    <section className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-brand-900">Branches</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Branches own Susu collection responsibility. Historical records keep the branch
          recorded when the transaction happened.
        </p>
      </header>

      <div className="overflow-x-auto rounded-control border border-line bg-white">
        <table className="w-full text-left text-sm">
          <thead className="bg-brand-50 text-ink">
            <tr>
              <th className="p-3">Branch</th>
              <th className="p-3">Code</th>
              <th className="p-3">Status</th>
              <th className="p-3">Assigned roles</th>
              {companyWide ? <th className="p-3">Action</th> : null}
            </tr>
          </thead>
          <tbody>
            {branches.map((branch) => {
              const roles = memberships
                .filter((m) => m.locationId === branch.id)
                .map((m) => m.role);
              return (
                <tr key={branch.id} className="border-t border-line">
                  <td className="p-3 font-medium">{branch.name}</td>
                  <td className="p-3">{branch.code}</td>
                  <td className="p-3" data-branch-status={branch.status}>
                    {branch.status}
                  </td>
                  <td className="p-3">{roles.length ? roles.join(", ") : "—"}</td>
                  {companyWide ? (
                    <td className="p-3">
                      <form
                        action={toggleBranchForm.bind(
                          null,
                          branch.id,
                          branch.status === "active" ? "inactive" : "active"
                        )}
                      >
                        <button type="submit" className="btn btn-secondary btn-sm">
                          {branch.status === "active" ? "Deactivate" : "Activate"}
                        </button>
                      </form>
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {companyWide ? (
        <div className="grid gap-6 md:grid-cols-2">
          <form action={createBranchForm} className="space-y-3 rounded-control border border-line bg-white p-5">
            <h2 className="text-lg font-semibold">Add a branch</h2>
            <label className="block text-sm">
              Name
              <input name="name" required className="form-input mt-1 w-full" />
            </label>
            <label className="block text-sm">
              Code
              <input name="code" required className="form-input mt-1 w-full" />
            </label>
            <label className="block text-sm">
              Address
              <input name="address" className="form-input mt-1 w-full" />
            </label>
            <button type="submit" className="btn btn-primary btn-sm">Create branch</button>
          </form>

          <form action={createBranchManagerForm} className="space-y-3 rounded-control border border-line bg-white p-5">
            <h2 className="text-lg font-semibold">Add a branch manager</h2>
            <label className="block text-sm">
              Full name
              <input name="fullName" required className="form-input mt-1 w-full" />
            </label>
            <label className="block text-sm">
              Email
              <input name="email" type="email" required className="form-input mt-1 w-full" />
            </label>
            <label className="block text-sm">
              Temporary password
              <input name="password" type="password" required className="form-input mt-1 w-full" />
            </label>
            <label className="block text-sm">
              Branch
              <select name="branchId" required className="form-input mt-1 w-full">
                <option value="">Select a branch</option>
                {branches.map((branch) => (
                  <option key={branch.id} value={branch.id}>{branch.name}</option>
                ))}
              </select>
            </label>
            <button type="submit" className="btn btn-primary btn-sm">Create manager</button>
          </form>
        </div>
      ) : null}
    </section>
  );
}
