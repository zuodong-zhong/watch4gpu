import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import { buildStorageProbe, createStorageCollector, parseStorageProbe, validateStorageConfig } from "../lib/storage.mjs";
import { formatStorageBytes, mergeStorageStatus, storageCapacityTone } from "../lib/storage-status.mjs";
import { createApiServer } from "../server.mjs";

const config = { sshHost: "storage-gateway", disks: [{ label: "共享盘", path: "/shared" }, { label: "系统盘", path: "/" }] };
const checkedAt = "2026-01-01T00:00:00.000Z";
function section(index, row, code = 0) {
  return `__WATCH4GPU_DISK_${index}__\nFilesystem Type 1-blocks Used Available Capacity Mounted on\n${row}\n__WATCH4GPU_DISK_END_${index}__:${code}\n`;
}
const output = section(0, "storage:/shared nfs 3377699720527872 2251799813685248 1125899906842624 67% /shared")
  + section(1, "/dev/sda4 xfs 939868164096 939868143616 20480 100% /") + "__WATCH4GPU_DONE__\n";

test("storage config rejects shell arguments, traversal, malformed paths and duplicates", () => {
  assert.deepEqual(validateStorageConfig({ disks: [] }), { sshHost: "", disks: [] });
  for (const sshHost of ["-oProxyCommand=bad", "user@host", "host; id", "host\nother", "$(id)", 22]) {
    assert.throws(() => buildStorageProbe({ ...config, sshHost }));
  }
  for (const path of ["shared", "/shared; id", "/$(id)", "/shared'", "/a/../shared", "/a/./shared", "/shared\n/"]) {
    assert.throws(() => buildStorageProbe({ ...config, disks: [{ path }] }));
  }
  assert.throws(() => validateStorageConfig({ ...config, disks: [{ path: "/shared" }, { path: "/shared/" }] }), /重复/);
  assert.throws(() => validateStorageConfig({ sshHost: "host", disks: [] }));
  assert.throws(() => validateStorageConfig({ ...config, disks: [{ path: "/", label: {} }] }));
  const probe = buildStorageProbe(config);
  assert.match(probe, /LC_ALL=C timeout 8s df -P -B1 -T -- '\/shared'/);
  assert.doesNotMatch(probe, /\b(?:sudo|du|rm|mkdir|touch|tee)\b|>\s*\//);
});

test("reads byte-accurate large shared disks, full disks and locale noise", () => {
  const disks = parseStorageProbe(`login warning\n${output}`, config, checkedAt);
  assert.equal(disks[0].availableBytes, 1024 ** 5);
  assert.equal(disks[0].totalBytes, 3 * 1024 ** 5);
  assert.equal(disks[0].filesystem, "nfs");
  assert.equal(disks[1].availableBytes, 20480);
  assert.equal(disks[1].usedPercent, 100);
  assert.equal(disks[1].checkedAt, checkedAt);
  assert.equal(formatStorageBytes(disks[1].availableBytes), "20 KiB");
  assert.equal(formatStorageBytes(disks[0].availableBytes), "1 PiB");
  assert.equal(formatStorageBytes(undefined), "未知");
  assert.equal(formatStorageBytes(0), "0 B");
  assert.equal(storageCapacityTone(disks[0]), "normal");
  assert.equal(storageCapacityTone(disks[1]), "critical");
});

test("unmounted paths never borrow the root filesystem's available capacity", () => {
  const [disk] = parseStorageProbe(section(0, "/dev/root xfs 100000 1 99999 1% /"), config, checkedAt);
  assert.equal(disk.ok, false);
  assert.match(disk.error, /未在 \/shared 检测到独立挂载/);
  assert.equal(disk.availableBytes, undefined);
});

test("missing, invalid, timed out and truncated disks stay unknown while complete disks survive", () => {
  const disks = parseStorageProbe(section(0, "df: /shared: No such file or directory", 1) + section(1, "", 124), config, checkedAt);
  assert.ok(disks.every((disk) => !disk.ok));
  assert.match(disks[0].error, /No such file/);
  assert.match(disks[1].error, /超时/);
  const partial = parseStorageProbe(output.slice(0, output.indexOf("__WATCH4GPU_DISK_END_1__")), config, checkedAt, "SSH 连接超时");
  assert.equal(partial[0].ok, true);
  assert.equal(partial[1].ok, false);
  assert.equal(partial[1].error, "SSH 连接超时");
  for (const row of ["invalid output", "/dev/root xfs 0 0 0 0% /", "/dev/root xfs 99999999999999999 1 0 100% /"]) {
    assert.equal(parseStorageProbe(section(1, row), config, checkedAt)[1].ok, false);
  }
  const overfull = parseStorageProbe(section(1, "/dev/root xfs 100 110 -10 110% /"), config, checkedAt)[1];
  assert.equal(overfull.availableBytes, 0);
  assert.equal(storageCapacityTone(overfull), "critical");
});

test("storage collection deduplicates requests and preserves each disk on failure, then recovers", async () => {
  let finish;
  let calls = 0;
  const collect = createStorageCollector(async (command, args, input, timeoutMs) => {
    calls += 1;
    assert.equal(command, "ssh");
    assert.equal(args.at(-2), config.sshHost);
    assert.ok(args.includes("BatchMode=yes"));
    assert.ok(!args.includes("-p"), "SSH alias supplies its configured port");
    if (calls === 1) {
      assert.equal(timeoutMs, 90_000);
      return new Promise((resolve) => { finish = resolve; });
    }
    if (calls === 2) throw new Error("offline");
    return output;
  });
  const first = collect(config);
  assert.equal(first, collect(config, 120_000));
  await nextTurn();
  assert.equal(calls, 1);
  finish(output);
  const fresh = await first;
  assert.equal(fresh.ok, true);
  const failed = await collect(config);
  assert.equal(failed.ok, false);
  assert.ok(failed.disks.every((disk) => disk.ok && disk.refreshFailed));
  assert.deepEqual(failed.disks.map((disk) => disk.checkedAt), fresh.disks.map((disk) => disk.checkedAt));
  assert.equal(failed.disks[0].availableBytes, fresh.disks[0].availableBytes);
  const recovered = await collect(config);
  assert.equal(recovered.ok, true);
  assert.ok(recovered.disks.every((disk) => !disk.refreshFailed));
});

test("changed storage targets queue, snapshot config and never inherit another host's readings", async () => {
  let finish;
  const hosts = [];
  const collect = createStorageCollector(async (_, args) => {
    hosts.push(args.at(-2));
    if (hosts.length === 1) return new Promise((resolve) => { finish = resolve; });
    throw new Error("new target offline");
  });
  const first = collect(config);
  const other = { sshHost: "other-gateway", disks: config.disks.map((disk) => ({ ...disk })) };
  const second = collect(other);
  other.sshHost = "mutated";
  other.disks[0].path = "/mutated";
  await nextTurn();
  assert.deepEqual(hosts, [config.sshHost]);
  finish(output);
  await first;
  const result = await second;
  assert.deepEqual(hosts, [config.sshHost, "other-gateway"]);
  assert.equal(result.disks[0].path, "/shared");
  assert.ok(result.disks.every((disk) => !disk.ok && disk.availableBytes == null));
});

test("partial output refreshes good disks without relabeling older readings as current", async () => {
  let calls = 0;
  const collect = createStorageCollector(async () => {
    if (++calls === 1) return output;
    throw Object.assign(new Error("connection timed out"), { probeOutput: section(0, "storage:/shared nfs 1000 900 100 90% /shared") });
  });
  const initial = await collect(config);
  const partial = await collect(config);
  assert.equal(partial.ok, false);
  assert.equal(partial.disks[0].availableBytes, 100);
  assert.equal(partial.disks[0].refreshFailed, undefined);
  assert.equal(storageCapacityTone(partial.disks[0]), "warning");
  assert.equal(partial.disks[1].checkedAt, initial.disks[1].checkedAt);
  assert.equal(partial.disks[1].refreshFailed, true);
  const disabled = await collect({ disks: [] });
  assert.equal(disabled.configured, false);
  assert.deepEqual(disabled.disks, []);
  assert.equal(calls, 2);
});

test("browser merge keeps timestamps on API failures but drops removed disks and changed hosts", () => {
  const previous = { configured: true, sshHost: config.sshHost, ok: true, attemptedAt: checkedAt, disks: parseStorageProbe(output, config, checkedAt) };
  const incoming = { ...previous, ok: false, disks: [{ path: "/shared", label: "新名称", ok: false, error: "offline" }] };
  const merged = mergeStorageStatus(previous, incoming);
  assert.equal(merged.disks.length, 1);
  assert.equal(merged.disks[0].label, "新名称");
  assert.equal(merged.disks[0].refreshFailed, true);
  assert.equal(merged.disks[0].checkedAt, checkedAt);
  assert.equal(mergeStorageStatus(previous, { ...incoming, sshHost: "different" }).disks[0].availableBytes, undefined);
});

function request(server, path) {
  return new Promise((resolve) => {
    let status;
    server.emit("request", { method: "GET", headers: {}, url: path }, {
      setHeader() {}, writeHead(code) { status = code; },
      end(body) { resolve({ status, body: JSON.parse(body) }); },
    });
  });
}

test("storage API uses only local targets, validates deadlines and does not invoke GPU collection", async () => {
  const calls = [];
  const server = createApiServer({
    getStorageConfig: async () => config,
    collectStorage: async (...args) => { calls.push(args); return { configured: true, disks: [] }; },
    collectNode: () => assert.fail("disk collection must not poll GPUs"),
  });
  const result = await request(server, "/api/storage?timeoutSeconds=45&sshHost=evil&path=/etc");
  assert.equal(result.status, 200);
  assert.deepEqual(calls, [[config, 45_000]]);
  assert.equal((await request(server, "/api/storage?timeoutSeconds=999")).status, 400);
  assert.equal(calls.length, 1);
});
