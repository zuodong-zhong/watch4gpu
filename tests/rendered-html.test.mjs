import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the real GPU dashboard shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>GPU Watch<\/title>/i);
  assert.match(html, /资源状态/);
  assert.match(html, /aria-label="搜索节点"/);
  assert.match(html, /aria-label="集群资源概览"/);
  assert.match(html, /正在连接本地采集服务/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|GPU OPERATIONS|LOCAL CONTROL ROOM/);
});

test("keeps resource totals mutually exclusive and error states honest", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /occupiedGpuTotal\s*=\s*allGpus\.length\s*-\s*freeGpuTotal/);
  assert.match(page, /serviceError\s*&&\s*nodes\.length\s*===\s*0/);
  assert.match(page, /!serviceError\s*&&\s*filteredNodes\.length\s*===\s*0/);
  assert.match(page, /上限未知/);
  assert.doesNotMatch(page, /busyCount|window\.confirm/);
});

test("protects keyboard, mobile, and local development behavior", async () => {
  const [page, css, server] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../server.mjs", import.meta.url), "utf8"),
  ]);

  assert.match(page, /event\.key === "Escape"/);
  assert.match(page, /TIMEOUT_STORAGE_KEY/);
  assert.match(page, /REFRESH_OPTIONS/);
  assert.match(page, /new URLSearchParams\(\{ timeoutSeconds:/);
  assert.match(page, /aria-haspopup="dialog"/);
  assert.match(page, /暂停后仍可使用顶部按钮手动刷新/);
  assert.match(page, /较慢的中转节点建议选择 45 秒以上/);
  assert.match(page, /focusableSelector/);
  assert.match(page, /previousFocusRef\.current\?\.focus/);
  assert.match(page, /aria-modal="true"/);
  assert.match(page, /<details className="workload-details" open>/);
  assert.doesNotMatch(page, /process-details/);
  assert.doesNotMatch(page, /等 \$\{gpu\.processes\.length\} 个进程/);
  assert.match(page, /<div className="processes">/);
  assert.match(page, /<MetricRing value=\{gpu\.utilization\} label="利用率" \/>/);
  assert.match(page, /<MetricRing value=\{memoryPercent\} label="显存" \/>/);
  assert.doesNotMatch(page, /metric-pointer/);
  assert.doesNotMatch(css, /\.metric-track/);
  assert.match(css, /\.gpu-vitals \{[^}]*grid-template-columns:\s*76px 76px minmax\(0, 1fr\)/);
  assert.match(css, /\.metric-ring \{[^}]*width:\s*76px/);
  assert.match(css, /\.memory-copy \{[^}]*justify-self:\s*end;[^}]*text-align:\s*right/);
  assert.match(css, /\.process-owner \{[^}]*font:\s*600 12px\/18px/);
  assert.match(css, /\.modal-head > button \{[\s\S]*?width: 44px;[\s\S]*?height: 44px;/);
  assert.match(css, /\.collection-popover \{/);
  assert.match(css, /\.collection-options button\.active \{/);
  assert.doesNotMatch(css, /\.top-actions select\s*\{\s*display:\s*none/);
  assert.doesNotMatch(css, /\.top-actions \.primary::after/);
  assert.match(server, /WATCH4GPU_ALLOWED_ORIGINS/);
  assert.match(server, /url\.hostname === "localhost"/);
  assert.doesNotMatch(server, /Access-Control-Allow-Origin": "http:\/\/localhost:3000"/);
});

test("keeps the public defaults free of private cluster configuration", async () => {
  const [nodesText, namesText, page, server, readme, login] = await Promise.all([
    readFile(new URL("../data/nodes.json", import.meta.url), "utf8"),
    readFile(new URL("../data/user-names.json", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../server.mjs", import.meta.url), "utf8"),
    readFile(new URL("../README.md", import.meta.url), "utf8"),
    readFile(new URL("../login.sh", import.meta.url), "utf8"),
  ]);

  assert.deepEqual(JSON.parse(nodesText), { nodes: [] });
  assert.deepEqual(JSON.parse(namesText), {});
  assert.match(server, /data", "nodes\.local\.json/);
  assert.match(server, /WATCH4GPU_USER_PATH_PREFIXES/);
  assert.match(page, /NEXT_PUBLIC_WATCH4GPU_USER_NAMES/);
  assert.match(login, /WATCH4GPU_EXPECT_SCRIPT/);
  assert.match(readme, /192\.0\.2\.10/);

  const publicText = [nodesText, namesText, page, server, readme, login].join("\n");
  assert.doesNotMatch(publicText, /(?:10(?:\.\d{1,3}){3}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|192\.168(?:\.\d{1,3}){2})/);
  assert.doesNotMatch(publicText, /\/Users\/(?!<your-account>)[^/\s]+/);
});
