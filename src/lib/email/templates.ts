/**
 * MaaCash-branded transactional email templates.
 *
 * Plain HTML with inline styles for mobile clients. Every interpolated user
 * value is escaped. Action links are built from the canonical application
 * origin, never an internal host.
 */

import { appBaseUrl } from "./resend";

const BRAND = "#0f5132";
const INK = "#0f172a";
const MUTED = "#475569";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function layout(options: {
  heading: string;
  intro: string;
  actionLabel: string;
  actionUrl: string;
  expiry: string;
  securityNote: string;
}): string {
  const safeUrl = escapeHtml(options.actionUrl);
  return `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;color:${INK};">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f1f5f9;padding:24px 12px;">
      <tr><td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:520px;background:#ffffff;border-radius:12px;overflow:hidden;">
          <tr><td style="background:${BRAND};padding:20px 24px;color:#ffffff;font-size:20px;font-weight:bold;">MaaCash</td></tr>
          <tr><td style="padding:28px 24px 8px;">
            <h1 style="margin:0 0 12px;font-size:20px;line-height:1.3;color:${INK};">${escapeHtml(options.heading)}</h1>
            <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:${MUTED};">${escapeHtml(options.intro)}</p>
            <p style="margin:0 0 20px;">
              <a href="${safeUrl}" style="display:inline-block;background:${BRAND};color:#ffffff;text-decoration:none;font-weight:bold;padding:12px 20px;border-radius:8px;">${escapeHtml(options.actionLabel)}</a>
            </p>
            <p style="margin:0 0 8px;font-size:13px;line-height:1.6;color:${MUTED};">${escapeHtml(options.expiry)}</p>
            <p style="margin:0 0 20px;font-size:13px;line-height:1.6;color:${MUTED};">${escapeHtml(options.securityNote)}</p>
          </td></tr>
          <tr><td style="padding:16px 24px 24px;border-top:1px solid #e2e8f0;font-size:12px;line-height:1.6;color:#64748b;">
            If the button does not work, copy this address into your browser:<br />
            <span style="word-break:break-all;color:${MUTED};">${safeUrl}</span>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

export function verificationEmail(options: {
  fullName: string;
  email: string;
  token: string;
  expiresInHours: number;
}) {
  const url = `${appBaseUrl()}/verify-email?token=${encodeURIComponent(options.token)}`;
  const intro = `Hello ${options.fullName}, confirm this email address to finish setting up your MaaCash account.`;
  return {
    subject: "Verify your MaaCash email address",
    html: layout({
      heading: "Verify your email address",
      intro,
      actionLabel: "Verify email address",
      actionUrl: url,
      expiry: `This link expires in ${options.expiresInHours} hours and can be used once.`,
      securityNote:
        "If you did not expect this email, do not use the link. Your account stays pending and no one can sign in as you.",
    }),
    text: `${intro}\n\nVerify: ${url}\n\nThis link expires in ${options.expiresInHours} hours and can be used once.\n\nIf you did not expect this email, do not use the link.`,
  };
}

export function passwordResetEmail(options: {
  fullName: string;
  token: string;
  expiresInMinutes: number;
}) {
  const url = `${appBaseUrl()}/reset-password?token=${encodeURIComponent(options.token)}`;
  const intro = `Hello ${options.fullName}, a password reset was requested for your MaaCash account.`;
  return {
    subject: "Reset your MaaCash password",
    html: layout({
      heading: "Reset your password",
      intro,
      actionLabel: "Choose a new password",
      actionUrl: url,
      expiry: `This link expires in ${options.expiresInMinutes} minutes and can be used once.`,
      securityNote:
        "If you did not request this, ignore this email. Your current password keeps working and no one can sign in with this link.",
    }),
    text: `${intro}\n\nReset: ${url}\n\nThis link expires in ${options.expiresInMinutes} minutes and can be used once.\n\nIf you did not request this, ignore this email.`,
  };
}

export function platformPaymentEmail(options: {
  tenantName: string;
  tenantCode: string;
  planName: string;
  billingTerm: string;
  amount: number;
  currency: string;
  reference: string;
  paidAt: string | null;
  periodEnd: string | null;
  dashboardUrl: string;
}): { subject: string; html: string; text: string } {
  const amount = `${options.currency.toUpperCase() === "GHS" ? "GHS " : `${options.currency} `}${options.amount.toLocaleString(
    "en-GH",
    { minimumFractionDigits: 0, maximumFractionDigits: 2 }
  )}`;
  const rows: [string, string][] = [
    ["Business", `${options.tenantName} (${options.tenantCode})`],
    ["Package", `${options.planName} · ${options.billingTerm}`],
    ["Amount", amount],
    ["Payment reference", options.reference],
    ["Paid at", options.paidAt ?? "Confirmed by provider"],
    ["Access until", options.periodEnd ?? "See the console"],
  ];

  const table = rows
    .map(
      ([label, value]) =>
        `<tr><td style="padding:6px 0;color:${MUTED};font-size:13px;width:40%;">${escapeHtml(
          label
        )}</td><td style="padding:6px 0;color:${INK};font-size:14px;font-weight:600;">${escapeHtml(
          value
        )}</td></tr>`
    )
    .join("");

  const intro = `A verified Paystack payment has been applied to ${options.tenantName}. Access was granted only after MaaCash verified the transaction server-side.`;
  const url = options.dashboardUrl;

  return {
    subject: `Payment received: ${options.tenantName} — ${amount}`,
    html: `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;color:${INK};">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f1f5f9;padding:24px 12px;">
      <tr><td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:520px;background:#ffffff;border-radius:12px;overflow:hidden;">
          <tr><td style="background:${BRAND};padding:20px 24px;color:#ffffff;font-size:20px;font-weight:bold;">MaaCash</td></tr>
          <tr><td style="padding:28px 24px 8px;">
            <h1 style="margin:0 0 12px;font-size:20px;line-height:1.3;color:${INK};">Payment received</h1>
            <p style="margin:0 0 18px;font-size:15px;line-height:1.6;color:${MUTED};">${escapeHtml(
              intro
            )}</p>
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-top:1px solid #e2e8f0;border-bottom:1px solid #e2e8f0;margin-bottom:18px;">${table}</table>
            <p style="margin:0 0 20px;">
              <a href="${escapeHtml(
                url
              )}" style="display:inline-block;background:${BRAND};color:#ffffff;text-decoration:none;font-weight:bold;padding:12px 20px;border-radius:8px;">Open the platform console</a>
            </p>
            <p style="margin:0 0 20px;font-size:13px;line-height:1.6;color:${MUTED};">This message contains no card, wallet or verification-code details. If you were not expecting this payment, review the tenant before acting on it.</p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`,
    text: `Payment received\n\n${intro}\n\n${rows
      .map(([label, value]) => `${label}: ${value}`)
      .join("\n")}\n\nOpen the platform console: ${url}\n`,
  };
}
