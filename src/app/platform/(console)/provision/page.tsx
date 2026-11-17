import { PageHeader } from "@/components/ui/DataDisplay";
import { db } from "@/lib/db";
import { getProvisioningOptions } from "@/lib/actions/provisioning.actions";
import ProvisionForm from "./ProvisionForm";

export const dynamic = "force-dynamic";

export default async function ProvisionPage({
  searchParams,
}: {
  searchParams: Promise<{ enquiryId?: string }>;
}) {
  const { enquiryId } = await searchParams;
  const options = await getProvisioningOptions();
  const enquiry = enquiryId
    ? await db.accountEnquiry.findUnique({
        where: { id: enquiryId },
        select: {
          id: true,
          businessName: true,
          contactName: true,
          phone: true,
          email: true,
          locationCount: true,
          interestedPlan: true,
          status: true,
        },
      })
    : null;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Controlled provisioning"
        description="Convert an enquiry into a business in pending payment. Public self-registration stays disabled."
      />
      <ProvisionForm
        plans={options.plans}
        foundingRemaining={options.founding.remaining}
        enquiry={
          enquiry
            ? {
                id: enquiry.id,
                businessName: enquiry.businessName,
                contactName: enquiry.contactName,
                phone: enquiry.phone,
                email: enquiry.email,
                locationCount: enquiry.locationCount,
                interestedPlan: enquiry.interestedPlan,
              }
            : null
        }
      />
    </div>
  );
}
