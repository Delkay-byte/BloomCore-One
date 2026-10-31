import Link from "next/link";
import { SearchX } from "lucide-react";

export default function NotFound() {
  return (
    <div className="min-h-[60vh] flex items-center justify-center px-4">
      <div className="card max-w-md w-full text-center">
        <SearchX className="mx-auto text-brand-300 mb-3" size={32} aria-hidden />
        <h1 className="text-lg font-semibold text-slate-900">Page not found</h1>
        <p className="text-sm text-slate-500 mt-2">
          The page you are looking for does not exist or may have moved.
        </p>
        <div className="flex justify-center mt-5">
          <Link href="/" className="btn btn-primary btn-sm">
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}
