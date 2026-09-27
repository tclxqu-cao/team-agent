export const metadata = {
  title: "AgentRoam",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "AgentRoam", statusBarStyle: "black-translucent" },
  icons: { icon: "/pwa/icon-192.png", apple: "/pwa/icon-192.png" },
  description: "General-purpose AI agent API server",
};

// Paint the document chrome and root surface before route CSS or client code runs.
// Individual apps replace these values with the selected skin after hydration.
const INITIAL_BACKGROUND = "#070a0b";
export const viewport = { themeColor: INITIAL_BACKGROUND, colorScheme: "dark" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" style={{ background: INITIAL_BACKGROUND, colorScheme: "dark" }}>
      <body style={{ margin: 0, minHeight: "100dvh", background: INITIAL_BACKGROUND }}>
        {children}<script src="/pwa/install.js" defer />
      </body>
    </html>
  );
}
