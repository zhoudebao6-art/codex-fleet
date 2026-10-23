import type { Metadata } from "next";
import "./globals.css";
import "./fleet-polish.css";
import "./fleet-detail.css";

export const metadata: Metadata = {
  title: "协作台 · Codex Fleet",
  description: "在手机、平板和电脑上安排 Codex 任务，查看设备协作、文件交接和结果。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">{children}</body>
    </html>
  );
}
