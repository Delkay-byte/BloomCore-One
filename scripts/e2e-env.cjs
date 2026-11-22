/**
 * Environment for the E2E application server.
 *
 * The browser acceptance suite must be deterministic and must never be able to
 * reach a real provider. That means:
 *
 *  - one disposable SQLite database, resolved by `test-database-paths.cjs`;
 *  - every external provider credential explicitly blank, so no test can
 *    initiate a live payment, send a real WhatsApp/SMS message or call a paid AI
 *    provider even when the developer's `.env` holds production credentials;
 *  - the same session/security settings the suite was written against.
 *
 * Previously the suite inherited `.env`, so a machine with a Paystack key saw a
 * different "checkout configured" state and the acceptance result depended on
 * the developer's local secrets.
 */

/** Providers that must be blanked for the browser suite. */
const BLANKED_KEYS = [
  "PAYSTACK_SECRET_KEY",
  "PAYSTACK_PUBLIC_KEY",
  "PAYSTACK_LOCAL_LIVE_TEST",
  "PAYSTACK_LOCAL_TEST_TENANT",
  "PAYSTACK_LOCAL_LIVE_ALLOWED_TENANT_IDS",
  "PLATFORM_PAYMENT_NOTIFICATION_EMAIL",
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_MODEL",
  "ZELI_TEAM_TESTING_ALLOWED",
  "ZELI_TEAM_TESTING_TENANT_CODE",
  "ZELI_SYNTHETIC_TESTING_ALLOWED",
  "ZELI_APPROVAL_REFERENCE",
  "WHATSAPP_ACCESS_TOKEN",
  "WHATSAPP_PHONE_NUMBER_ID",
  "WHATSAPP_BUSINESS_ACCOUNT_ID",
  "WHATSAPP_APP_SECRET",
  // The reader is `WHATSAPP_VERIFY_TOKEN` in src/lib/messaging/whatsapp.ts. The
  // older name is blanked too so a shell that still exports it cannot change the
  // webhook's response in the suite.
  "WHATSAPP_VERIFY_TOKEN",
  "WHATSAPP_WEBHOOK_VERIFY_TOKEN",
  "WHATSAPP_DELIVERY_ENABLED",
  "WHATSAPP_DELIVERY_ALLOWLIST",
  "MESSAGING_DISPATCH_TOKEN",
  "SMS_STATUS_WEBHOOK_SECRET",
  "SMS_PROVIDER",
  "ANOMALY_SCAN_TOKEN",
  "ZELI_EXTERNAL_AI_DISABLED",
  "DEEPSEEK_INVESTIGATION_MODEL",
  "RESEND_API_KEY",
  "PLATFORM_OIDC_CLIENT_SECRET",
  "PLATFORM_OIDC_CC_API_KEY",
];

/**
 * @param {string} databaseUrl Absolute `file:` URL for the disposable E2E database.
 * @param {Record<string, string | undefined>} [base]
 * @returns {Record<string, string>} every value is a string, never undefined
 */
function e2eServerEnv(databaseUrl, base = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(base)) {
    if (typeof value === "string") env[key] = value;
  }
  for (const key of BLANKED_KEYS) env[key] = "";
  return {
    ...env,
    DATABASE_URL: databaseUrl,
    NODE_ENV: "production",
    JWT_SECRET: "e2e-secret-not-for-production",
    TURNSTILE_ENABLED: "false",
    MFA_ENFORCEMENT: "optional",
    RATE_LIMIT_HMAC_SECRET: "e2e-rate-limit-secret-32-bytes-long",
    MFA_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    PAYSTACK_ENABLED: "false",
    PLATFORM_OIDC_ENABLED: "false",
    OFFLINE_COLLECTIONS_ENABLED: "true",
    OFFLINE_MOMO_ENABLED: "true",
  };
}

exports.BLANKED_E2E_KEYS = BLANKED_KEYS;
exports.e2eServerEnv = e2eServerEnv;
