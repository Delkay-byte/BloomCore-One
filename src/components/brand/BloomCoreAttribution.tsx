import { ExternalLink } from "lucide-react";

/**
 * The single product-attribution link.
 *
 * It opens the official BloomCore Technologies website in a new tab with
 * `noopener noreferrer`, sits below the application content and is never fixed
 * over a financial action.
 */
export default function BloomCoreAttribution({
  className = "",
}: {
  className?: string;
}) {
  return (
    <a
      href="https://bloomcoretech.com"
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-flex items-center gap-1 text-xs text-slate-500 underline-offset-2 hover:text-brand-700 hover:underline ${className}`}
    >
      Powered by BloomCore Technologies
      <ExternalLink size={11} aria-hidden />
    </a>
  );
}
