import type { Metadata } from "next";
import { ClerkProvider, SignedIn, SignedOut } from "@clerk/nextjs";
import Providers, { AuthenticationPrompt } from "./providers";
import "katex/dist/katex.min.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Magnify | PDF workspace",
  description: "Manage research projects, documents, and conversations in Magnify.",
};

export const dynamic = "force-dynamic";

export default function RootLayout({ children }: LayoutProps<"/">) {
  const clerkConfigured = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && process.env.CLERK_SECRET_KEY);
  const content = clerkConfigured ? (
    <ClerkProvider publishableKey={process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY}>
      <SignedIn>{children}</SignedIn>
      <SignedOut><AuthenticationPrompt /></SignedOut>
    </ClerkProvider>
  ) : <AuthenticationPrompt clerkConfigured={false} />;
  return (
    <html lang="en">
      <body><Providers>{content}</Providers></body>
    </html>
  );
}
