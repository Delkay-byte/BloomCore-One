import { redirect } from "next/navigation";
import { readMfaChallenge } from "@/lib/security/mfa-challenge";
import MfaVerifyForm from "@/components/security/MfaVerifyForm";

export const metadata = { title: "Two-factor verification" };

export default async function MfaVerifyPage() {
  const challenge = await readMfaChallenge();
  if (!challenge || challenge.mode !== "verify") {
    redirect("/login");
  }
  return <MfaVerifyForm />;
}
