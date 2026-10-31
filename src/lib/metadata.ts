import type { Metadata } from "next";
import { SITE_URL_IS_PROVISIONAL } from "./site";

/**
 * Metadata for one public page.
 *
 * While the site is served from its temporary hosting address, no canonical
 * <link> is emitted: this deployment must not claim to be the canonical home of
 * the brand. Set SITE_URL (or NEXT_PUBLIC_SITE_URL) to the confirmed public
 * domain and every public page starts declaring its own canonical URL.
 */
export function pageMetadata({
  path,
  title,
  description,
  absolute = false,
}: {
  path: string;
  /** Page title WITHOUT the product name — the root layout template appends it. */
  title: string;
  description: string;
  /** True for the home page, whose title already names the product. */
  absolute?: boolean;
}): Metadata {
  return {
    title: absolute ? { absolute: title } : title,
    description,
    ...(SITE_URL_IS_PROVISIONAL
      ? {}
      : { alternates: { canonical: path } }),
  };
}
