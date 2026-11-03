"use client";
import { SkeletonPage } from "@/components/ui/Skeletons";

import { useEffect, useState } from "react";
import { getCustomerProfile } from "@/lib/actions/susu-customer.actions";
import { formatDate } from "@/lib/utils";
import CediAmount from "@/components/CediAmount";

interface ProfileData {
  customer: {
    id: string;
    customerId: string;
    fullName: string;
    phone?: string | null;
    email?: string | null;
    address?: string | null;
    dailyContribution: number;
    status: string;
    registeredAt: Date;
  };
  account: {
    id: string;
    accountId: string;
    dailyContribution: number;
    status: string;
    cardCustody: string;
  };
  currentCollector: { fullName: string } | null;
  currentCycle: {
    cycleNumber: number;
    startDate: Date;
    endDate: Date;
    status: string;
  } | null;
}

export default function CustomerProfilePage() {
  const [data, setData] = useState<ProfileData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    async function loadProfile() {
      try {
        const result = await getCustomerProfile();
        setData(result as unknown as ProfileData);
      } catch (err) {
        setError("Failed to load profile");
      } finally {
        setLoading(false);
      }
    }
    loadProfile();
  }, []);

  if (loading) return <SkeletonPage variant="detail" />;

  if (error || !data) {
    return (
      <div className="text-center py-20">
        <p className="text-slate-500">{error || "Unable to load profile"}</p>
      </div>
    );
  }

  const { customer, account, currentCollector, currentCycle } = data;

  return (
    <div className="space-y-6">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-slate-900">My Profile</h1>
        <p className="text-slate-500 mt-1">Your Susu account information</p>
      </div>

      <div className="card">
        <div className="flex items-center gap-4 p-4 bg-blue-50 rounded-lg mb-6">
          <div className="w-16 h-16 rounded-full bg-blue-100 flex items-center justify-center">
            <span className="text-2xl font-bold text-blue-700">
              {customer.fullName.charAt(0).toUpperCase()}
            </span>
          </div>
          <div>
            <h2 className="text-xl font-semibold text-slate-900">{customer.fullName}</h2>
            <p className="text-sm text-slate-500">Susu Customer</p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
          <div className="bg-white border border-slate-200 rounded-lg p-4">
            <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
              Customer ID
            </label>
            <p className="text-slate-900 mt-1 font-mono font-medium">{customer.customerId}</p>
          </div>
          <div className="bg-white border border-slate-200 rounded-lg p-4">
            <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
              Phone
            </label>
            <p className="text-slate-900 mt-1 font-medium">{customer.phone || "Not provided"}</p>
          </div>
          <div className="bg-white border border-slate-200 rounded-lg p-4">
            <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
              Email
            </label>
            <p className="text-slate-900 mt-1 font-medium">{customer.email || "Not provided"}</p>
          </div>
          <div className="bg-white border border-slate-200 rounded-lg p-4">
            <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
              Address
            </label>
            <p className="text-slate-900 mt-1 font-medium">{customer.address || "Not provided"}</p>
          </div>
          <div className="bg-white border border-slate-200 rounded-lg p-4">
            <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
              Daily Contribution
            </label>
            <p className="text-slate-900 mt-1 font-medium text-green-700"><CediAmount amount={customer.dailyContribution} />/day</p>
          </div>
          <div className="bg-white border border-slate-200 rounded-lg p-4">
            <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
              Account Status
            </label>
            <p className="text-slate-900 mt-1 font-medium">
              <span className={`badge ${customer.status === "active" ? "badge-green" : "badge-red"}`}>
                {customer.status}
              </span>
            </p>
          </div>
        </div>

        <div className="border-t pt-6">
          <h3 className="font-semibold mb-4">Account Details</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
            <div className="bg-white border border-slate-200 rounded-lg p-4">
              <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                Account Number
              </label>
              <p className="text-slate-900 mt-1 font-mono font-semibold text-lg">{account.accountId}</p>
            </div>
            <div className="bg-white border border-slate-200 rounded-lg p-4">
              <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                Card Status
              </label>
              <p className="text-slate-900 mt-1 font-medium capitalize">{account.cardCustody}</p>
            </div>
          </div>

          {currentCollector && (
            <div className="bg-white border border-slate-200 rounded-lg p-4 mb-4">
              <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                Current Collector
              </label>
              <p className="text-slate-900 mt-1 font-medium">{currentCollector.fullName}</p>
            </div>
          )}

          {currentCycle && (
            <div className="bg-white border border-slate-200 rounded-lg p-4">
              <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                Current Cycle
              </label>
              <div className="mt-1">
                <p className="font-medium">Cycle {currentCycle.cycleNumber}</p>
                <p className="text-sm text-slate-500">
                  {formatDate(currentCycle.startDate)} – {formatDate(currentCycle.endDate)}
                </p>
                <span className={`badge ${currentCycle.status === "active" ? "badge-green" : "badge-blue"}`} mt-1>
                  {currentCycle.status}
                </span>
              </div>
            </div>
          )}

          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mt-6">
            <p className="text-sm text-blue-800">
              <strong>Note:</strong> Profile information is read-only. Contact your administrator
              to update your name, phone, email, address, or assigned collector.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}