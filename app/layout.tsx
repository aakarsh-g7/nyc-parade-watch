import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "NYC Parade Trip Watch",
  description: "Plan a walking or transit trip through New York City and adapt to disruptions during the Thanksgiving Day Parade.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
