#!/bin/sh
set -e

echo "[cue-scheduler] 启动前安装/校验依赖 (npm install)..."
npm install --omit=dev --no-audit --no-fund

echo "[cue-scheduler] 初始化数据库并启动服务..."
exec node src/server.js
