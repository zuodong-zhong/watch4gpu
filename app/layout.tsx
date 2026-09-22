import type { Metadata } from "next";
import { THEME_INIT_SCRIPT } from "./theme";
import "./globals.css";

export const metadata: Metadata = {
  title: "GPU Watch",
  description: "通过 SSH 统一查看直连与中转节点的 GPU 利用率、显存、温度和进程。",
  icons: { icon: "/favicon.svg?v=3", shortcut: "/favicon.svg?v=3" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" data-theme="light" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} /></head>
      <body>{children}</body>
    </html>
  );
}
