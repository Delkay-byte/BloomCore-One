import { redirect } from "next/navigation";
import { readMfaChallenge } from "@/lib/security/mfa-challenge";
import MfaEnrollFlow from "@/components/security/MfaEnrollFlow";

export const metadata = { title: "Set up two-factor authentication" };

export default async function MfaEnrollPage() {
  const challenge = await readMfaChallenge();
  if (!challenge || challenge.mode !== "enroll") {
    redirect("/login");
  }
  return <MfaEnrollFlow />;
}
