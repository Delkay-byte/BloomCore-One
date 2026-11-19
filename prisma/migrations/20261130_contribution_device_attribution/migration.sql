-- Device attribution for offline collections.
--
-- Additive. Contributions submitted through the offline queue carry the
-- verified DeviceEnrollment identifier and a snapshot of its label. Online
-- contributions leave both columns null.

ALTER TABLE "Contribution" ADD COLUMN "recordedDeviceId" TEXT;
ALTER TABLE "Contribution" ADD COLUMN "recordedDeviceName" TEXT;
