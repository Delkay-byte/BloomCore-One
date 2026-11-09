import { CANONICAL_PRODUCTION_URL } from "@/lib/site";

/**
 * Transition notice shown only on the old MaaCash Render hostnames.
 *
 * It is deliberately informational: the old origin keeps working and is never
 * redirected, so a device can reconnect and synchronize records that were
 * queued before the custom domain became canonical. The notice uses plain
 * server-rendered HTML and no client storage.
 */
export default function LegacyHostNotice() {
  return (
    <aside
      aria-label="MaaCash domain migration notice"
      data-maacash-legacy-host-notice="true"
      className="border-b border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950"
    >
      <div className="mx-auto flex max-w-7xl flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="max-w-3xl">
          <p className="font-semibold">
            MaaCash has moved to{" "}
            <a
              className="underline underline-offset-2"
              href={CANONICAL_PRODUCTION_URL}
            >
              maacash.bloomcoretech.com
            </a>
          </p>
          <p className="mt-1">
            Before you switch: synchronize any unsynchronized offline records on
            this old address while it is still available. Then sign in online
            again on the new address and prepare the device for offline use
            there. Locally saved financial records stay on this device until
            server synchronization is confirmed.
          </p>
          <p className="mt-2">
            <a className="font-semibold underline underline-offset-2" href="/migrate">
              Check and synchronize this device&apos;s offline records
            </a>
          </p>
        </div>
        <a
          className="shrink-0 font-semibold underline underline-offset-2"
          href={CANONICAL_PRODUCTION_URL}
        >
          Open the new address
        </a>
      </div>
    </aside>
  );
}
