import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "FlipRouter MTG — Backpack Vendor & Buylist Liquidation Router",
  description:
    "Deterministic 4-pile MTG collection liquidation router across TCGplayer, Mana Pool, 85% TCG Low P2P, Card Kingdom Cash/Credit Arbitrage, and Card Conduit with cent-exact IRS Schedule C COGS allocation.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>): React.ReactElement {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-slate-950 text-slate-100">
        {children}
      </body>
    </html>
  );
}
