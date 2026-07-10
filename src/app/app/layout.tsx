import type { Metadata } from "next";
import { DappNav } from "@/components/dapp/dapp-nav";
import { InstanceHeaderBanner } from "@/components/dapp/instance-branding";

export const metadata: Metadata = {
  title: "O.U.R.COOP — App",
  description: "Deposit, vote, and distribute cooperative yield on O.U.R.COOP.",
};

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-paper-main min-h-screen">
      <DappNav />
      <InstanceHeaderBanner />
      <main className="section-container py-10">{children}</main>
    </div>
  );
}
