import type { Metadata } from "next";
import { SessionProvider } from "@/components/cases/Session";
import { ConsoleNav } from "@/components/cases/ConsoleNav";

export const metadata: Metadata = {
  title: "NETRA — cases",
  description: "Complaint-driven investigation: protect the victim, trace the money, freeze evidence-backed mule accounts.",
};

export default function CasesLayout({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <div className="flex min-h-screen flex-col bg-void">
        <ConsoleNav />
        <div className="flex-1">{children}</div>
      </div>
    </SessionProvider>
  );
}
