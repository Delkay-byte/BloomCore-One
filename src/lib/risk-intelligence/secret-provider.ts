/**
 * Risk Intelligence HMAC secret provider.
 *
 * Secrets never live in the application database, source code, logs or audit
 * rows. This module defines the production provider boundary and ships a local
 * environment-backed provider for the existing development workflow. A managed
 * production secret store can be registered by infrastructure without changing
 * application code; no vendor is selected here.
 *
 * `.env.risk-intelligence.local` stays in local development only and its salt
 * must never be reused as a production secret.
 */

export interface RiskSecretAccessMetadata {
  version: number;
  providerId: string;
  operation: "contribute" | "query" | "configuration";
  at: string;
  /** Never include a key, salt, hash input or hash output. */
  outcome: "used" | "unavailable";
}

export interface RiskSecretProvider {
  readonly id: string;
  /** Version used for new contributions. */
  activeVersion(): number;
  /** Supported versions, including the active one; retired versions are absent. */
  supportedVersions(): number[];
  /** Returns the raw secret only to the hashing module, never to callers. */
  keyFor(version: number): string | null;
}

type AccessSink = (metadata: RiskSecretAccessMetadata) => void;

let accessSink: AccessSink | null = null;
const accessHistory: RiskSecretAccessMetadata[] = [];
const HISTORY_LIMIT = 200;

/** Infrastructure may install a durable, metadata-only audit sink. */
export function setRiskSecretAccessSink(sink: AccessSink | null): void {
  accessSink = sink;
}

export function auditSecretAccess(metadata: RiskSecretAccessMetadata): void {
  accessHistory.push(metadata);
  if (accessHistory.length > HISTORY_LIMIT) accessHistory.shift();
  accessSink?.(metadata);
}

/** Metadata only. Safe to include in a diagnostic report. */
export function recentSecretAccess(): readonly RiskSecretAccessMetadata[] {
  return accessHistory.map((entry) => ({ ...entry }));
}

class EnvironmentSecretProvider implements RiskSecretProvider {
  readonly id = "environment-local";

  activeVersion(): number {
    const raw = process.env.RISK_INTELLIGENCE_ACTIVE_KEY_VERSION ?? "1";
    const version = Number(raw);
    return Number.isInteger(version) && version > 0 ? version : 1;
  }

  supportedVersions(): number[] {
    const active = this.activeVersion();
    const raw = process.env.RISK_INTELLIGENCE_SUPPORTED_VERSIONS;
    if (!raw) return [active];
    const parsed = raw
      .split(",")
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isInteger(value) && value > 0);
    return [...new Set([active, ...parsed])].sort((a, b) => b - a);
  }

  keyFor(version: number): string | null {
    const named = process.env[`RISK_INTELLIGENCE_KEY_V${version}`];
    if (named && named.trim().length >= 24) return named.trim();
    // Single-key deployments use the established local salt for version 1.
    if (version === 1) {
      const legacy = process.env.RISK_INTELLIGENCE_SALT;
      return legacy && legacy.trim().length >= 24 ? legacy.trim() : null;
    }
    return null;
  }
}

let registered: RiskSecretProvider | null = null;

/** Called once by the deployment's infrastructure bootstrap, if it has one. */
export function registerRiskSecretProvider(provider: RiskSecretProvider): void {
  registered = provider;
}

export function getRiskSecretProvider(): RiskSecretProvider {
  return registered ?? new EnvironmentSecretProvider();
}

/** True when the active key is available from the configured provider. */
export function riskSecretsConfigured(): boolean {
  const provider = getRiskSecretProvider();
  const key = provider.keyFor(provider.activeVersion());
  const result = Boolean(key);
  auditSecretAccess({
    version: provider.activeVersion(),
    providerId: provider.id,
    operation: "configuration",
    at: new Date().toISOString(),
    outcome: result ? "used" : "unavailable",
  });
  return result;
}

export function keyForVersion(
  version: number,
  operation: RiskSecretAccessMetadata["operation"]
): string {
  const provider = getRiskSecretProvider();
  const key = provider.keyFor(version);
  auditSecretAccess({
    version,
    providerId: provider.id,
    operation,
    at: new Date().toISOString(),
    outcome: key ? "used" : "unavailable",
  });
  if (!key) {
    throw new Error(
      `Risk Intelligence key version ${version} is unavailable. Shared risk intelligence cannot answer safely.`
    );
  }
  return key;
}
