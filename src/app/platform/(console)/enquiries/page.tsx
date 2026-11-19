import { PageHeader } from "@/components/ui/DataDisplay";
import EnquiryRowActions from "@/components/platform/EnquiryRowActions";
import { listAccountEnquiries } from "@/lib/actions/platform-enquiries.actions";
import { formatDateTime } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function PlatformEnquiriesPage() {
  const enquiries = await listAccountEnquiries();

  return (
    <div className="space-y-4">
      <PageHeader
        title="Demonstration requests & enquiries"
        description="Public requests for a demonstration and account enquiries. Review, contact the prospect, record the outcome, and provision only through the normal controlled tenant flow."
      />

      {enquiries.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-600">
          No requests yet. Demonstration requests from the contact page and account
          enquiries from the pricing page appear here.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">Business</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Contact</th>
                <th className="px-4 py-3">Interested in</th>
                <th className="px-4 py-3">Received</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Provision</th>
              </tr>
            </thead>
            <tbody>
              {enquiries.map((enquiry) => (
                <tr key={enquiry.id} className="border-t border-slate-100 align-top">
                  <td className="px-4 py-3">
                    <p className="font-medium text-slate-900">{enquiry.businessName}</p>
                    {enquiry.message && (
                      <p className="mt-1 max-w-md text-xs text-slate-500">{enquiry.message}</p>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                        enquiry.enquiryType === "DEMO_REQUEST"
                          ? "bg-brand-50 text-brand-800"
                          : "bg-slate-100 text-slate-700"
                      }`}
                    >
                      {enquiry.enquiryType === "DEMO_REQUEST" ? "Demo request" : "Account enquiry"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-slate-700">
                    <p>{enquiry.contactName}</p>
                    <p className="text-xs text-slate-500">{enquiry.phone}</p>
                    {enquiry.email && (
                      <p className="text-xs text-slate-500">{enquiry.email}</p>
                    )}
                  </td>
                  <td className="px-4 py-3 text-slate-700">
                    <p>{enquiry.interestedPlan ?? "Not specified"}</p>
                    {enquiry.locationCount !== null && (
                      <p className="text-xs text-slate-500">
                        {enquiry.locationCount} location
                        {enquiry.locationCount === 1 ? "" : "s"}
                      </p>
                    )}
                    {enquiry.modules && (
                      <p className="text-xs text-slate-500">
                        {enquiry.modules === "both"
                          ? "Mobile money + Susu"
                          : enquiry.modules === "susu"
                            ? "Susu"
                            : "Mobile money"}
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-500">
                    {formatDateTime(enquiry.createdAt)}
                  </td>
                  <td className="px-4 py-3">
                    <EnquiryRowActions id={enquiry.id} status={enquiry.status} />
                  </td>
                  <td className="px-4 py-3">
                    {enquiry.status === "provisioned" || enquiry.status === "converted" ? (
                      <span className="text-xs text-slate-500">Provisioned</span>
                    ) : (
                      <a
                        className="text-xs font-medium text-brand-700 underline"
                        href={`/platform/provision?enquiryId=${encodeURIComponent(enquiry.id)}`}
                      >
                        Provision
                      </a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
