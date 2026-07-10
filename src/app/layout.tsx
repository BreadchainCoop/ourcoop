import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "@/components/providers";

export const metadata: Metadata = {
  title: "O.U.R.COOP — Artist-Cooperative Funding",
  description:
    "The O.U.R.COOP artist cooperative funds art projects from shared yield: members stake together, the principal stays theirs, and 100-point ballots decide which projects the interest funds. Built on the open-source crowdstake protocol.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
