import type { Metadata, Viewport } from "next";
import "./globals.css";
import EnvironmentBadge from "@/components/EnvironmentBadge";
import TabSessionProvider from "@/components/TabSessionProvider";
import ToastProvider from "@/components/ui/Toast";
import {
  PRODUCT_DESCRIPTOR,
  PRODUCT_NAME,
  PRODUCT_POSITIONING,
  PRODUCT_TAGLINE,
  SITE_URL,
  absoluteUrl,
} from "@/lib/site";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: `${PRODUCT_NAME} — ${PRODUCT_DESCRIPTOR}`,
    template: `%s · ${PRODUCT_NAME}`,
  },
  description: PRODUCT_POSITIONING,
  applicationName: PRODUCT_NAME,
  manifest: "/manifest.json",
  openGraph: {
    type: "website",
    siteName: PRODUCT_NAME,
    title: `${PRODUCT_NAME} — ${PRODUCT_DESCRIPTOR}`,
    description: PRODUCT_POSITIONING,
    images: [
      {
        url: absoluteUrl("/branding/bloomcore-one-og.png"),
        width: 1200,
        height: 630,
        alt: `${PRODUCT_NAME} — ${PRODUCT_TAGLINE}`,
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: `${PRODUCT_NAME} — ${PRODUCT_DESCRIPTOR}`,
    description: PRODUCT_POSITIONING,
    images: [absoluteUrl("/branding/bloomcore-one-og.png")],
  },
  icons: {
    icon: [
      { url: "/branding/bloomcore-one-icon.svg", type: "image/svg+xml" },
      { url: "/branding/bloomcore-one-icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: [{ url: "/apple-icon.png", sizes: "180x180", type: "image/png" }],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: PRODUCT_NAME,
  },
};

// maximumScale removed: users must be able to pinch-zoom (WCAG 1.4.4).
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0e4d34",
};

// Nonce-based CSP requires every HTML page to be rendered per request so
// Next.js can attach the request nonce to its script tags.
export const dynamic = "force-dynamic";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning>
        <ToastProvider>
          <TabSessionProvider />
          <EnvironmentBadge />
          {children}
        </ToastProvider>
      </body>
    </html>
  );
}
