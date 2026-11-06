/**
 * Conversational act recognition for the local Zeli assistant.
 *
 * This module classifies the *social* and *instructional* shape of a message.
 * It deliberately does not classify business questions: those go through
 * `classifyIntent` so that business answers stay grounded in server-computed
 * records.
 *
 * Every recogniser is deterministic and local. No text leaves the process.
 */

export type ZeliConversationAct =
  | "greeting"
  | "help"
  | "thanks"
  | "farewell"
  | "identity"
  | "smalltalk"
  | "general_knowledge"
  | "instruction";

const BUSINESS_VOCABULARY =
  /(contribution|withdraw|remit|variance|branch|customer|account|susu|momo|daily|transaction|payment|balance|exception|income|expense|report|analytics|collection|handover|deposit|savings|cycle)/i;

const GREETING =
  /^(hi|hello|hey|hiya|greetings|yo|good (morning|afternoon|evening))\b/i;

const HELP =
  /\b(help|what can you do|what do you do|how can you help|how do i use you|capabilities|commands|get started|guide me|your features)\b/i;

const THANKS = /\b(thanks|thank you|thankyou|cheers|appreciate it|much appreciated)\b/i;

const FAREWELL = /\b(bye|goodbye|see you|talk later|later|good night)\b/i;

const IDENTITY =
  /\b(who are you|what are you|what'?s your name|your name|are you (an? )?(ai|bot|robot|chatgpt|human|real person)|are you human)\b/i;

const SMALLTALK =
  /\b(how are you|how'?s it going|how is your day|nice to meet you|good to see you)\b/i;

const GENERAL_KNOWLEDGE =
  /\b(weather|capital of|president of|tell me a joke|write (me )?(a )?(poem|story|essay|song)|translate|recipe|football|soccer|movie|music|history of|who won|meaning of life|recipe for|define [a-z]+ as|explain (photosynthesis|gravity|electricity|the internet))\b/i;

/**
 * Financial-instruction detection.
 *
 * Zeli is read-only. A message that asks Zeli itself to move money or change a
 * record must be refused, even if it names a supported screen. A genuine
 * "how do I…" question is not an instruction and still gets guidance.
 */
const INSTRUCTION_PATTERNS = [
  /\b(approve|authorise|authorize|confirm)\b[^.]{0,40}\b(withdrawal|payment|refund|payout|transaction|remittance)\b/i,
  /\b(post|record|reverse|void|delete|cancel|refund|pay out|payout|transfer|credit|debit|adjust|change|update)\b[^.]{0,40}\b(withdrawal|contribution|payment|balance|transaction|record|refund|payout|account|remittance)\b/i,
  /\b(give|send|transfer|pay)\b[^.]{0,30}\b(ghs|gh₵|cedis|money|funds|cash)\b/i,
  /\b(reset|change)\b[^.]{0,30}\b(password|pin|mfa|two-factor|role|permission)\b/i,
  /\b(give|grant)\b[^.]{0,30}\b(admin|access|permission|super ?admin)\b/i,
  /^(please\s+)?(approve|post|reverse|refund|delete|pay|transfer|adjust|change|update)\b/i,
];

const QUESTION_OPENERS =
  /^(how|what|where|when|why|who|which|explain|can i|should i|do i|does|is it|am i|tell me how)\b/i;

export function isFinancialInstruction(question: string): boolean {
  const text = question.toLowerCase().replace(/\s+/g, " ").trim();
  if (QUESTION_OPENERS.test(text)) return false;
  return INSTRUCTION_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Classify a non-business message. Callers must confirm that the message did
 * not already match a business intent; this function does not know about
 * records, periods or tenants.
 */
export function classifyConversationAct(
  question: string,
  role: string
): ZeliConversationAct | null {
  const text = question.toLowerCase().replace(/\s+/g, " ").trim();
  if (!text) return null;

  if (isFinancialInstruction(text)) return "instruction";

  if (IDENTITY.test(text)) return "identity";
  if (HELP.test(text) && !BUSINESS_VOCABULARY.test(text)) return "help";

  // A greeting is short and does not also ask a business question.
  if (GREETING.test(text) && text.length <= 60 && !BUSINESS_VOCABULARY.test(text)) {
    return "greeting";
  }
  if (SMALLTALK.test(text) && text.length <= 80) return "smalltalk";
  if (THANKS.test(text) && text.length <= 60) return "thanks";
  if (FAREWELL.test(text) && text.length <= 40) return "farewell";

  if (GENERAL_KNOWLEDGE.test(text)) return "general_knowledge";

  // A bare general question that is not about business data. The caller shows
  // an honest limitation instead of inventing an answer.
  if (
    /\?$/.test(text) &&
    !BUSINESS_VOCABULARY.test(text) &&
    /^(what|who|when|where|why|how|tell me|do you know|can you explain)\b/.test(text) &&
    role !== "admin"
  ) {
    return "general_knowledge";
  }
  if (
    /\?$/.test(text) &&
    !BUSINESS_VOCABULARY.test(text) &&
    /^(what is|who is|tell me about|do you know)\b/.test(text)
  ) {
    return "general_knowledge";
  }

  return null;
}
