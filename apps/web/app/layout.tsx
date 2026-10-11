import type { ReactNode } from "react";

import { HydrationActionReplay, hydrationActionReplayScript } from "../components/hydration-action-replay";
import "./globals.css";

export const metadata = {
  title: "Drama Practice — Your private rehearsal room",
  description: "A private, script-grounded study and rehearsal room for actors.",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <script dangerouslySetInnerHTML={{ __html: hydrationActionReplayScript }} />
        {children}
        <HydrationActionReplay />
      </body>
    </html>
  );
}
