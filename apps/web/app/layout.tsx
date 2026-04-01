import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "No Doctor — nodoctor.ng",
  description: "Medical guidance from the Nigeria Standard Treatment Guidelines, available to everyone.",
  metadataBase: new URL("https://nodoctor.ng"),
  openGraph: {
    title: "No Doctor — nodoctor.ng",
    description: "Medical guidance from Nigeria's Standard Treatment Guidelines.",
    url: "https://nodoctor.ng",
    siteName: "nodoctor.ng",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
