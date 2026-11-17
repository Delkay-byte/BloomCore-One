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
        title="Account enquiries"
        description="Prospective businesses that asked for a MaaCash account. Review, contact, and provision through the normal controlled tenant flow."
      />

      {enquiries.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-600">
          No enquiries yet. Enquiries submitted from the public pricing page appear here.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">Business</th>
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
