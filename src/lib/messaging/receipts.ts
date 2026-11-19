/**
 * Receipt content shared by WhatsApp template messages and SMS.
 *
 * The body is deliberately short and contains no PIN, OTP, internal risk
 * assessment or another customer's data. Amounts are formatted only after the
 * transaction has committed.
 */

export type ReceiptTransactionType = "contribution" | "withdrawal" | "reversal";

export interface ReceiptInput {
  businessName: string;
  transactionType: ReceiptTransactionType;
  amount: number;
  currency: string;
  reference: string;
  occurredAt: Date;
  accountReference: string;
  confirmationStatus: string;
}

export interface ReceiptContent {
  title: string;
  body: string;
  parameters: string[];
}

const TYPE_LABEL: Record<ReceiptTransactionType, string> = {
  contribution: "Contribution received",
  withdrawal: "Withdrawal paid",
  reversal: "Transaction reversed",
};

export function formatReceiptAmount(amount: number, currency: string): string {
  const value = Math.abs(Number(amount)).toLocaleString("en-GH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${currency.toUpperCase() === "GHS" ? "GHS " : `${currency.toUpperCase()} `}${value}`;
}

export function buildReceiptContent(input: ReceiptInput): ReceiptContent {
  const title = TYPE_LABEL[input.transactionType];
  const amount = formatReceiptAmount(input.amount, input.currency);
  const when = input.occurredAt.toISOString().slice(0, 16).replace("T", " ");
  const body = `${input.businessName}: ${title} ${amount}. Ref ${input.reference}. Account ${input.accountReference}. ${when} UTC. Status ${input.confirmationStatus}.`;
  return {
    title,
    body: body.slice(0, 320),
    parameters: [
      input.businessName.slice(0, 60),
      title,
      amount,
      input.reference.slice(0, 60),
      input.accountReference.slice(0, 40),
      `${when} UTC`,
      input.confirmationStatus.slice(0, 30),
    ],
  };
}
