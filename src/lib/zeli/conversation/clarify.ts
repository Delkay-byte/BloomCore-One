/**
 * Ambiguity detection.
 *
 * A short request that names no business subject cannot be answered honestly
 * from records. Instead of a generic "unsupported" reply, Zeli asks one
 * targeted clarifying question and remembers what it asked for, so the next
 * message completes the request.
 */

export interface Ambiguity {
  reason: string;
  askedFor: "business_topic";
}

const GENERIC_NOUNS =
  /^(the )?(report|reports|data|numbers|figures|details|info|information|summary|status|overview|results|breakdown|analytics|stats|statistics)$/;

const GENERIC_REQUESTS = [
  /^(show|open|give|get|see|display)( me)?( the| some| any)?( report|reports|data|numbers|figures|details|info|information|summary|status|overview|results|breakdown|analytics|stats)$/,
  /^(what|how)('s| is| are)?( the)?( numbers|figures|data|status|report|results)$/,
  /^(compare|explain)( it| that| this| them| those)?$/,
  /^(which|what) (report|metric|branch|period)( should i| do you mean| are you asking about)?$/,
  /^(tell me )?(more|everything)$/,
  /^(how are we doing|how is business|how's business)$/,
];

export function detectAmbiguity(question: string): Ambiguity | null {
  const text = question
    .toLowerCase()
    .replace(/[?!.]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  if (GENERIC_NOUNS.test(text)) {
    return {
      reason: "You have not named a business subject yet.",
      askedFor: "business_topic",
    };
  }
  if (GENERIC_REQUESTS.some((pattern) => pattern.test(text))) {
    return {
      reason: "That request could mean several different reports.",
      askedFor: "business_topic",
    };
  }
  return null;
}
