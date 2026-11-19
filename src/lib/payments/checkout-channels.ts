import {
  DEFAULT_HOSTED_CHECKOUT_CHANNEL,
  isHostedCheckoutChannel,
  type HostedCheckoutChannel,
} from "@/lib/payments/checkout-url";

/**
 * Payment methods MaaCash is allowed to request from Paystack.
 *
 * `channels` narrows the hosted page to one method. Paystack's documented
 * behaviour does not guarantee a default when several channels are supplied,
 * so MaaCash always sends exactly the method the customer chose.
 *
 * Bank Transfer is opt-in because it depends on the merchant account and
 * currency being enabled for that channel. It is never offered by guesswork.
 */
export function supportedCheckoutChannels(
  currency: string,
  env: NodeJS.ProcessEnv = process.env
): HostedCheckoutChannel[] {
  const channels: HostedCheckoutChannel[] = ["mobile_money", "card"];
  const bankTransferEnabled =
    (env.PAYSTACK_CHECKOUT_BANK_TRANSFER ?? "").trim().toLowerCase() === "true";
  if (bankTransferEnabled && currency.toUpperCase() === "GHS") {
    channels.push("bank_transfer");
  }
  return channels;
}

export function resolveCheckoutChannel(input: {
  requested: unknown;
  currency: string;
  env?: NodeJS.ProcessEnv;
}): HostedCheckoutChannel {
  const supported = supportedCheckoutChannels(input.currency, input.env);
  const requested =
    input.requested === undefined || input.requested === null || input.requested === ""
      ? DEFAULT_HOSTED_CHECKOUT_CHANNEL
      : input.requested;
  if (!isHostedCheckoutChannel(requested) || !supported.includes(requested)) {
    throw new CheckoutChannelError(
      `${requested === "bank_transfer" ? "Bank Transfer is" : "That payment method is"} not available for this account and currency. No money was taken.`,
      "channel_unavailable"
    );
  }
  return requested;
}

export class CheckoutChannelError extends Error {
  code: string;
  constructor(message: string, code = "channel_unavailable") {
    super(message);
    this.name = "CheckoutChannelError";
    this.code = code;
  }
}
