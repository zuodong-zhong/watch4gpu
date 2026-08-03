import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "GPU Watch",
  description: "通过 SSH 统一查看直连与中转节点的 GPU 利用率、显存、温度和进程。",
  icons: { icon: "/favicon.svg?v=3", shortcut: "/favicon.svg?v=3" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
