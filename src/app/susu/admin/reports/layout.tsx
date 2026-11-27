import ReportTabs from "./_components/ReportTabs";

export default function SusuReportsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-5">
      <ReportTabs />
      {children}
    </div>
  );
}