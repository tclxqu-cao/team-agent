export const metadata = {
  title: "AgentRoam",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "AgentRoam", statusBarStyle: "default" },
  icons: { icon: "/pwa/icon-192.png", apple: "/pwa/icon-192.png" },
  description: "General-purpose AI agent API server",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}<script src="/pwa/install.js" defer /></body>
    </html>
  );
}
