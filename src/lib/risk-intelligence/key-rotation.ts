/**
 * Dual-key rotation planning. Pure metadata only — no secret value is read,
 * held, logged or returned by this module.
 *
 * A query must try the active key and every supported previous version so
 * existing eligible signals stay matchable during rotation. Contributions
 * always use the active key. An existing hash is never regenerated: the
 * original identity inputs are not retained, so the only safe operation is to
 * match against candidate versions and then retire a key deliberately.
 */

export interface RotationState {
  active: number;
  previous: number[];
  retired: number[];
}

/** Candidates for a lookup: active first, then supported previous versions. */
export function candidateKeyVersions(
  active: number,
  previous: readonly number[]
): number[] {
  return [active, ...previous.filter((version) => version !== active)].filter(
    (version, index, all) => all.indexOf(version) === index
  );
}

/**
 * Versions that may now be retired. The active key is never in this list, and
 * an already retired version stays retired. Retirement needs an authorised
 * decision in the calling action; this function only computes candidates.
 */
export function retirementPlan(state: RotationState): number[] {
  const retired = new Set(state.retired);
  return state.previous.filter(
    (version) => version !== state.active && !retired.has(version)
  );
}

/** A version is supported while it is active or still in the previous set. */
export function isSupportedVersion(version: number, state: RotationState): boolean {
  return version === state.active || state.previous.includes(version);
}
