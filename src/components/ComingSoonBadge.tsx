/**
 * The single "Coming soon" marker used for unavailable external integrations.
 *
 * It exists so the wording, the accessibility text and the visual weight are the same
 * everywhere, and so a screen can never imply that a provider action happened. It is
 * deliberately *not* used for WhatsApp: that integration is being built by the owner
 * and is not marked unavailable here.
 */

export function ComingSoonBadge({
  label = "Coming soon",
  detail,
}: {
  label?: string;
  detail?: string;
}) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-slate-300 bg-white px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600"
      data-testid="coming-soon"
      role="status"
      aria-label={
        detail ? `${label}: ${detail}` : `${label}. This external integration is not available yet.`
      }
      title={detail ?? "This external integration is not available yet."}
    >
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-slate-400" />
      {label}
    </span>
  );
}

export default ComingSoonBadge;
