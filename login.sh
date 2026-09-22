#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 || ! "$1" =~ ^[0-9]+$ ]]; then
  echo "Usage: bash login.sh <gpu-node-id>" >&2
  exit 1
fi

gpu_node_id="$1"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# Prefer the explicitly configured path, then the script's own directory.  The
# gateway account's HOME is not necessarily the directory containing login.sh.
expect_script="${WATCH4GPU_EXPECT_SCRIPT:-$script_dir/connect.exp}"

if [[ ! -f "$expect_script" ]]; then
  echo "Expect script not found: $expect_script" >&2
  echo "Set WATCH4GPU_EXPECT_SCRIPT or place connect.exp beside login.sh on the gateway." >&2
  exit 1
fi

exec expect "$expect_script" "$gpu_node_id"
