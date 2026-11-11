#!/bin/sh
# Ubuntu / Linux 一键部署入口
# 用法: ./deploy-linux.sh [install|restore|status|diag|verify|help]
set -e
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$SCRIPT_DIR/deploy-linux.js" "${@:-status}"
