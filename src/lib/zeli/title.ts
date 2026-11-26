/**
 * Deterministic, privacy-safe Zeli conversation titles.
 *
 * Titles are derived from the topic of the first meaningful message, never
 * from customer names, phone numbers, wallet numbers or amounts. No external
 * model is called.
 */

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

const GREETING = /^(hi|hello|hey|good\s+(morning|afternoon|evening)|thanks|thank you)\b/i;

function topic(question: string): string {
  const text = question.toLowerCase();
  if (/(remit|collector|hand.?in)/.test(text)) return "Collector Remittance Review";
  if (/(withdraw|payout|cash.?out)/.test(text)) return "Susu Withdrawal Analysis";
  if (/(shortage|shortfall|difference|variance)/.test(text)) {
    return "Daily Shortage Investigation";
  }
  if (/(anomal|unusual|fraud|suspicious)/.test(text)) return "Anomaly Review";
  if (/(transfer|float)/.test(text)) return "Branch Transfer Review";
  if (/(shift|handover)/.test(text)) return "Shift Handover Review";
  if (/(expense|spend|cost)/.test(text)) return "Expense Review";
  if (/(customer|active account|engagement|new account)/.test(text)) {
    return "Customer Activity Review";
  }
  if (/(branch|location)/.test(text)) return "Branch Cash Performance";
  if (/(profit|revenue|income|commission)/.test(text)) {
    return "Income and Expense Review";
  }
  if (/(contribution|summary|overview|report|month|period)/.test(text)) {
    return "Business Summary";
  }
  return "";
}

export function generateConversationTitle(question: string): string {
  const clean = question.replace(/\s+/g, " ").trim();
  if (!clean || GREETING.test(clean) || clean.split(" ").length <= 2) {
    return "Business Question";
  }
  const month = MONTHS.find((name) => new RegExp("\\b" + name + "\\b", "i").test(clean));
  const found = topic(clean);
  if (!found) return month ? `${month} Business Review` : "Business Review";
  return month && !found.startsWith(month) ? `${month} ${found}` : found;
}
