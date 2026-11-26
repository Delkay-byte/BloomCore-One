-- Bind the selected hosted-checkout payment method to the charge attempt.
-- Existing attempts keep NULL because their channel cannot be proven.
ALTER TABLE "ZeliChargeAttempt" ADD COLUMN "checkoutChannel" TEXT;
