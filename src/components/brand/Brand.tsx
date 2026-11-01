import { PRODUCT_DESCRIPTOR } from "@/lib/site";

/**
 * ============================================================================
 * BLOOMCORE ONE BRAND COMPONENTS
 * ============================================================================
 *
 * The mark is inline SVG so it inherits the page's rendering context and needs
 * no extra request. The wordmark is HTML text (not vector text inside an SVG)
 * so it always uses the application's own Noto Sans stack and stays selectable
 * and translatable.
 *
 * Geometry (48x48 tile, shared with public/branding/*.svg):
 *   * forest tile — the platform
 *   * open ring — connected operational paths
 *   * gold core — the single control point at the centre
 */

const RING_PATH =
  "M31.17 34.24A12.5 12.5 0 1 1 31.17 13.76";

export type MarkTone = "tile" | "onDark" | "monoBlack" | "monoWhite";

const MARK_COLOURS: Record<MarkTone, { ring: string; core: string; tile: string | null }> = {
  tile: { ring: "#F6F5EC", core: "#C9A227", tile: "#0E4D34" },
  onDark: { ring: "#F6F5EC", core: "#C9A227", tile: null },
  monoBlack: { ring: "#111111", core: "#111111", tile: null },
  monoWhite: { ring: "#FFFFFF", core: "#FFFFFF", tile: null },
};

export function BrandMark({
  size = 40,
  tone = "tile",
  className,
  title,
}: {
  size?: number;
  tone?: MarkTone;
  className?: string;
  /** Provide only when the mark is the accessible name; omit when decorative. */
  title?: string;
}) {
  const colours = MARK_COLOURS[tone];

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      className={className}
      role={title ? "img" : "presentation"}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      {colours.tile ? (
        <rect width="48" height="48" rx="11.5" fill={colours.tile} />
      ) : null}
      <path
        d={RING_PATH}
        fill="none"
        stroke={colours.ring}
        strokeWidth="6.5"
      />
      <circle cx="24" cy="24" r="4.4" fill={colours.core} />
    </svg>
  );
}

/**
 * Mark plus wordmark. `tone="dark"` is for use on the forest surfaces
 * (sidebars, footers); `tone="light"` is for white/ivory pages.
 */
export function BrandLockup({
  size = 36,
  tone = "light",
  descriptor = false,
  className,
}: {
  size?: number;
  tone?: "light" | "dark";
  /** Show the "Business & Financial Operations Platform" descriptor line. */
  descriptor?: boolean;
  className?: string;
}) {
  const dark = tone === "dark";

  return (
    <span className={`inline-flex items-center gap-2.5 ${className ?? ""}`}>
      <BrandMark size={size} tone={dark ? "onDark" : "tile"} />
      <span className="flex flex-col leading-none">
        <span
          className={`font-semibold tracking-tight ${dark ? "text-white" : "text-ink-deep"}`}
          style={{ fontSize: Math.round(size * 0.6) }}
        >
          {/* Gold is the brand accent, but the accent gold (#C9A227) only
              reaches 2.4:1 on white and 2.2:1 on ivory. The wordmark is text,
              so it uses the darkened gold ramp: gold-700 clears WCAG AA
              (5.2:1 on white, 4.7:1 on ivory). On the forest surfaces the
              lighter gold has room and keeps its brightness. */}
          BloomCore
          <span className={dark ? "text-gold-400" : "text-gold-700"}> One</span>
        </span>
        {descriptor ? (
          <span
            className={`mt-1 text-[0.625rem] font-medium uppercase tracking-[0.14em] ${
              dark ? "text-brand-200" : "text-ink-muted"
            }`}
          >
            {PRODUCT_DESCRIPTOR}
          </span>
        ) : null}
      </span>
    </span>
  );
}
