import type { Metadata, Viewport } from "next";
import "./globals.css";
import EnvironmentBadge from "@/components/EnvironmentBadge";
import ToastProvider from "@/components/ui/Toast";

export const metadata: Metadata = {
  title: "BIK Prestige Enterprise - Management Platform",
  description: "BIK Prestige Enterprise Management Platform — Built by BloomCore Technologies",
  manifest: "/manifest.json",
  icons: {
    icon: "/branding/bik-prestige-icon.svg",
    apple: "/branding/bik-prestige-icon.svg",
  },
  appleWebApp: { capable: true, statusBarStyle: "default", title: "BIK Prestige" },
};

// maximumScale removed: users must be able to pinch-zoom (WCAG 1.4.4).
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0e4d34",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning>
        <ToastProvider>
          <EnvironmentBadge />
          {children}
        </ToastProvider>
      </body>
    </html>
  );
}
