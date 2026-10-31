import MarketingFooter from "@/components/marketing/MarketingFooter";
import MarketingNav from "@/components/marketing/MarketingNav";

/**
 * Public marketing shell. Deliberately lighter than the authenticated
 * application shell (ivory surfaces, wide measure) while using the same
 * forest/gold tokens so the product and its website read as one brand.
 */
export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col bg-white">
      <a
        href="#marketing-main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[100] focus:rounded-control focus:bg-brand-700 focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-white"
      >
        Skip to content
      </a>
      <MarketingNav />
      <main id="marketing-main" className="flex-1">
        {children}
      </main>
      <MarketingFooter />
    </div>
  );
}
