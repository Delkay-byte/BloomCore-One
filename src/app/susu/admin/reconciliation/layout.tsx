import ReconciliationTabs from "./_components/ReconciliationTabs";

export default function ReconciliationLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-5">
      <ReconciliationTabs />
      {children}
    </div>
  );
}
