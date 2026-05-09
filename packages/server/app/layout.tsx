export const metadata = {
  title: "Customer Agent - API",
  description: "General-purpose AI agent API server",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
