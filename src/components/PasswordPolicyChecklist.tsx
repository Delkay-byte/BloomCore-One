"use client";

import { Check } from "lucide-react";
import { PASSWORD_REQUIREMENTS } from "@/lib/security/password-policy";

/** Live checklist shown before submission; the server remains authoritative. */
export default function PasswordPolicyChecklist({
  password,
}: {
  password: string;
}) {
  return (
    <ul className="space-y-1 text-xs" aria-label="Password requirements">
      {PASSWORD_REQUIREMENTS.map((requirement) => {
        const met = requirement.test(password);
        return (
          <li key={requirement.id} className={met ? "text-emerald-700" : "text-slate-500"}>
            <Check size={12} className="mr-1 inline" aria-hidden />
            {requirement.label}
          </li>
        );
      })}
    </ul>
  );
}
