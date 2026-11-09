#!/usr/bin/env bash
# Linux / macOS 终端启动脚本。
set -e
cd "$(dirname "$0")"
exec python3 server.py --open "$@"
