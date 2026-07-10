import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "O.U.R.COOP — Governance",
  description:
    "The cooperative's live governance: funds, project proposals, 100-point member ballots, funding rounds, and withdrawal votes.",
};

export default function CoopLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return children;
}
