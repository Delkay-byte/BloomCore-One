import Link from "next/link";

export default function UnauthorizedPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
      <div className="text-center">
        <h1 className="text-6xl font-bold text-red-500 mb-4">403</h1>
        <h2 className="text-2xl font-semibold text-slate-800 mb-2">Access Denied</h2>
        <p className="text-slate-600 mb-6">You don&apos;t have permission to access this page.</p>
        <Link href="/login" className="btn btn-primary">Back to Login</Link>
      </div>
    </div>
  );
}
