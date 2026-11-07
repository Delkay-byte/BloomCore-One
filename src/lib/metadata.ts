import type { Metadata } from "next";
import {
  IS_STAGING_DEPLOYMENT,
  PRODUCT_NAME,
  PRODUCT_TAGLINE,
  SITE_URL_IS_PROVISIONAL,
  absoluteUrl,
} from "./site";

const OG_IMAGE = "/branding/maacash-og.png";

/**
 * Root robots directive. Staging is private acceptance infrastructure, so it
 * is explicitly excluded from indexing. Production keeps Next.js's default
 * behaviour (no robots meta emitted).
 */
export function rootRobotsMetadata(): Metadata["robots"] | undefined {
  return IS_STAGING_DEPLOYMENT ? { index: false, follow: false } : undefined;
}

/**
 * Metadata for one public page.
 *
 * While the site is served from its temporary hosting address, no canonical
 * <link> is emitted: this deployment must not claim to be the canonical home of
 * the brand. Set SITE_URL (or NEXT_PUBLIC_SITE_URL) to the confirmed public
 * domain and every public page starts declaring its own canonical URL plus an
 * Open Graph URL on the same host.
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
  const socialTitle = absolute ? title : `${title} · ${PRODUCT_NAME}`;

  return {
    title: absolute ? { absolute: title } : title,
    description,
    openGraph: {
      type: "website",
      siteName: PRODUCT_NAME,
      title: socialTitle,
      description,
      url: path,
      images: [
        {
          url: absoluteUrl(OG_IMAGE),
          width: 1200,
          height: 630,
          alt: `${PRODUCT_NAME} — ${PRODUCT_TAGLINE}`,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: socialTitle,
      description,
      images: [absoluteUrl(OG_IMAGE)],
    },
    ...(SITE_URL_IS_PROVISIONAL || IS_STAGING_DEPLOYMENT
      ? {}
      : { alternates: { canonical: path } }),
  };
}
