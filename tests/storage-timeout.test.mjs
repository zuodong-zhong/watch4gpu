import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { buildStorageProbe, createStorageCollector, validateStorageConfig } from "../lib/storage.mjs";

const config = {
  sshHost: "storage-gateway",
  disks: Array.from({ length: 16 }, (_, index) => ({ path: `/disk${index}` })),
};

// Execute the actual generated shell, replacing only timeout/df with a virtual
// clock. Each stalled df consumes its entire supplied budget, without sleeping
// or contacting SSH. Exiting the shell models the outer SSH deadline, retaining
// stdout exactly as run() does when it kills the connection.
function simulatedRun({ healthyPath = "", connectMs = 8_000 } = {}) {
  return async (command, args, input, timeoutMs) => {
    assert.equal(command, "ssh");
    const result = spawnSync("sh", ["-c", `
      storage_limit=$1
      storage_elapsed=$2
      storage_healthy=$3
      timeout() {
        storage_duration=\${1%s}
        case "$storage_duration" in
          *.*) storage_seconds=\${storage_duration%.*}; storage_fraction=\${storage_duration#*.}000 ;;
          *) storage_seconds=$storage_duration; storage_fraction=000 ;;
        esac
        storage_fraction=$(printf '%.3s' "$storage_fraction")
        storage_cost=$((storage_seconds * 1000 + 1$storage_fraction - 1000))
        for storage_path do :; done
        if [ "$storage_path" = "$storage_healthy" ]; then storage_cost=1; fi
        storage_elapsed=$((storage_elapsed + storage_cost + 1))
        if [ "$storage_elapsed" -ge "$storage_limit" ]; then exit 124; fi
        if [ "$storage_path" = "$storage_healthy" ]; then
          printf '/dev/mock xfs 1000 200 800 20%% %s\\n' "$storage_path"
          return 0
        fi
        return 124
      }
      ${args.at(-1)}
    `, "storage-test", String(timeoutMs), String(connectMs), healthyPath], { encoding: "utf8", timeout: 5_000 });
    if (result.error) throw result.error;
    assert.equal(result.stderr, "");
    if (result.status !== 0) {
      assert.equal(result.status, 124);
      throw Object.assign(new Error(`连接超时（${timeoutMs / 1000} 秒）`), { probeOutput: result.stdout });
    }
    assert.match(result.stdout, /__WATCH4GPU_DONE__\n$/);
    return result.stdout;
  };
}

test("storage accepts 16 disks but rejects 17, and small collections retain an 8 second per-disk budget", () => {
  assert.equal(validateStorageConfig(config).disks.length, 16);
  assert.throws(() => validateStorageConfig({ ...config, disks: [...config.disks, { path: "/disk16" }] }), /1–16/);
  assert.match(buildStorageProbe({ ...config, disks: config.disks.slice(0, 2) }), /timeout 8s df/);
});

test("all 16 consecutive disk timeouts finish within the default SSH deadline", async () => {
  const result = await createStorageCollector(simulatedRun())(config);
  assert.equal(result.ok, false);
  assert.equal(result.disks.length, 16);
  assert.ok(result.disks.every((disk) => /^读取超时/.test(disk.error)), JSON.stringify(result.disks.map((disk) => disk.error)));
  for (const disk of result.disks) {
    assert.equal(disk.ok, false);
    assert.equal(disk.error, "读取超时（5 秒）");
  }
});

test("15 stalled disks cannot prevent the last healthy disk from being collected", async () => {
  const result = await createStorageCollector(simulatedRun({ healthyPath: "/disk15" }))(config);
  assert.equal(result.ok, false);
  assert.equal(result.disks[15].ok, true);
  assert.equal(result.disks[15].availableBytes, 800);
  assert.ok(result.disks.slice(0, 15).every((disk) => disk.error === "读取超时（5 秒）"));
});

test("explicit UI/API deadlines also budget all disks without extending the requested timeout", async () => {
  for (const [timeoutMs, diskSeconds] of [[5_000, 0.156], [15_000, 0.468], [25_000, 0.937], [45_000, 2.187], [60_000, 3.125], [90_000, 5], [120_000, 6.875]]) {
    const simulate = simulatedRun({ connectMs: Math.min(8_000, timeoutMs / 4) });
    const collect = createStorageCollector((command, args, input, actualTimeoutMs) => {
      assert.equal(actualTimeoutMs, timeoutMs);
      return simulate(command, args, input, actualTimeoutMs);
    });
    const result = await collect(config, timeoutMs);
    assert.equal(result.disks.length, 16);
    for (const disk of result.disks) assert.equal(disk.error, `读取超时（${diskSeconds} 秒）`);
  }
});
