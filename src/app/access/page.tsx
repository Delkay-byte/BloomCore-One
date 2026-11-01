"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import QRCode from "qrcode";
import { Footprints, Smartphone, UserRound } from "lucide-react";
import { ACCESS_LINKS, type AccessLink } from "@/lib/access-links";
import { BrandLockup } from "@/components/brand/Brand";
import { PRODUCT_NAME } from "@/lib/site";

const LINK_ICONS = { customer: UserRound, momo: Smartphone, susu: Footprints } as const;
function LinkIcon({ link }: { link: AccessLink }) {
  const Icon = LINK_ICONS[link.icon as keyof typeof LINK_ICONS] ?? UserRound;
  return <Icon size={30} className={link.admin ? "text-gold-400" : "text-brand-600"} aria-hidden="true" />;
}

function downloadSvg(filename: string, svg: string) {
  const blob = new Blob([svg], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default function AccessPage() {
  const [origin, setOrigin] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [qr, setQr] = useState<Record<string, string>>({});
  const [canShare, setCanShare] = useState(false);

  useEffect(() => {
    setOrigin(window.location.origin);
    setCanShare(typeof navigator !== "undefined" && !!navigator.share);
  }, []);

  // Generate QR codes (SVG) for the PUBLIC login URLs only.
  useEffect(() => {
    if (!origin) return;
    let cancelled = false;
    (async () => {
      const next: Record<string, string> = {};
      for (const link of ACCESS_LINKS) {
        next[link.key] = await QRCode.toString(`${origin}${link.shortPath}`, {
          type: "svg",
          margin: 1,
          width: 168,
        });
      }
      if (!cancelled) setQr(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [origin]);

  function fullUrl(path: string): string {
    return origin ? `${origin}${path}` : path;
  }

  async function copy(link: AccessLink) {
    try {
      await navigator.clipboard.writeText(fullUrl(link.shortPath));
      setCopied(link.key);
      setTimeout(() => setCopied((c) => (c === link.key ? null : c)), 2000);
    } catch {
      /* clipboard unavailable — ignore */
    }
  }

  async function share(link: AccessLink) {
    try {
      await navigator.share({
        title: `${PRODUCT_NAME} — ${link.title} Login`,
        text: `Sign in to ${PRODUCT_NAME} as ${link.title}.`,
        url: fullUrl(link.shortPath),
      });
    } catch {
      /* user cancelled or unsupported — ignore */
    }
  }

  return (
    <div className="access-wrap min-h-screen flex flex-col items-center justify-center bg-gradient-to-br from-slate-100 via-emerald-50 to-amber-50 px-4 py-10">
      <div className="w-full max-w-md">
        {/* Brand */}
        <div className="text-center mb-6">
          <BrandLockup size={52} className="justify-center" />
          <h1 className="sr-only">BloomCore One sign in</h1>
          <h2 className="text-xl font-bold text-slate-900 mt-3">How would you like to sign in?</h2>
          <p className="text-slate-500 mt-1 text-sm">Choose the option that matches your role.</p>
        </div>

        <div className="space-y-4">
          {ACCESS_LINKS.map((link) => (
            <div
              key={link.key}
              className={`card p-5 ${
                link.admin ? "border-2 border-slate-700 bg-slate-900 text-white" : ""
              }`}
            >
              <div className="flex items-start gap-3">
                <LinkIcon link={link} />
                <div className="flex-1 min-w-0">
                  <h3 className={`text-lg font-semibold ${link.admin ? "text-white" : "text-slate-900"}`}>
                    {link.title}
                  </h3>
                  <p className={`text-sm ${link.admin ? "text-slate-300" : "text-slate-500"}`}>
                    {link.description}
                  </p>
                </div>
              </div>

              <p className={`text-xs mt-3 ${link.admin ? "text-slate-400" : "text-slate-500"}`}>
                {link.instruction}
              </p>

              {/* QR code (public URL only) */}
              <div className="mt-4 flex justify-center">
                {qr[link.key] ? (
                  <div
                    className="bg-white p-2 rounded-lg"
                    dangerouslySetInnerHTML={{ __html: qr[link.key] }}
                  />
                ) : (
                  <div className="h-[168px] w-[168px] bg-white rounded-lg animate-pulse" />
                )}
              </div>

              <p
                className={`text-center text-xs mt-2 break-all ${link.admin ? "text-slate-400" : "text-slate-400"}`}
              >
                {fullUrl(link.shortPath)}
              </p>

              <div className="mt-4 flex items-center gap-2">
                <Link
                  href={link.shortPath}
                  className={`btn access-login-btn w-full text-center ${
                    link.admin ? "btn-primary" : "btn-primary"
                  }`}
                >
                  {link.key === "admin" ? "Administrator Login" : `${link.title} Login`}
                </Link>
              </div>

              <div className="mt-2 flex items-center justify-center gap-2 flex-wrap">
                <button
                  type="button"
                  onClick={() => copy(link)}
                  className={`access-copy-btn text-xs px-3 py-1.5 rounded-md ${
                    link.admin
                      ? "text-slate-200 hover:bg-slate-700"
                      : "text-emerald-600 hover:bg-emerald-50"
                  }`}
                >
                  {copied === link.key ? "Link copied" : "Copy Link"}
                </button>
                {canShare && (
                  <button
                    type="button"
                    onClick={() => share(link)}
                    className={`access-share-btn text-xs px-3 py-1.5 rounded-md ${
                      link.admin
                        ? "text-slate-200 hover:bg-slate-700"
                        : "text-emerald-600 hover:bg-emerald-50"
                    }`}
                  >
                    Share
                  </button>
                )}
                {qr[link.key] && (
                  <button
                    type="button"
                    onClick={() => downloadSvg(`bloomcore-one-${link.key}-login.svg`, qr[link.key])}
                    className={`access-download-btn text-xs px-3 py-1.5 rounded-md ${
                      link.admin
                        ? "text-slate-200 hover:bg-slate-700"
                        : "text-emerald-600 hover:bg-emerald-50"
                    }`}
                  >
                    Download QR
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>

        <style>{`
          @media print {
            .access-login-btn, .access-copy-btn, .access-share-btn, .access-download-btn { display: none !important; }
            .access-wrap { background: #fff !important; }
            .access-wrap .card { box-shadow: none !important; border-color: #cbd5e1 !important; }
          }
        `}</style>

        <p className="text-center text-xs text-slate-400 mt-8">
          BloomCore One · Built by BloomCore Technologies
        </p>
      </div>
    </div>
  );
}
