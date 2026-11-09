#!/bin/zsh
# 双击这个文件即可启动股票罗盘，并自动打开浏览器。
set -e
cd "$(dirname "$0")"
exec python3 server.py --open "$@"
