#!/bin/bash
# 在一台有 Docker 的 Linux 机器上拉起联调环境：MySQL 8 + 真库基座/模拟网关 + 应用（对外只用一个端口，默认 5400）
# 用法：deploy.sh <应用包 zip> ；目录默认 /opt/dh-verify
set -euo pipefail
ZIP=${1:?需要应用包 zip 路径}
ROOT=${DH_ROOT:-/opt/dh-verify}
HERE=$(cd "$(dirname "$0")" && pwd)
UUID=${APP_UUID:-aaaaaaaa-0000-4000-8000-000000000000}
SCHEMA=${APP_SCHEMA:-dh_app}
NODE_IMG=node:22.21.1-slim
# 对外只占一个端口：门户、网关前缀下的应用、基座接口都走它；应用容器不单独暴露端口
DH_PORT=${DH_PORT:-5400}
mkdir -p "$ROOT/mysql-data" "$ROOT/base"

# 数据库口令只在本机生成并保存，不进仓库
[ -f "$ROOT/dev.env" ] || { umask 077; echo "MYSQL_ROOT_PASSWORD=$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')" > "$ROOT/dev.env"; }
. "$ROOT/dev.env"

docker network inspect dh-net >/dev/null 2>&1 || docker network create dh-net >/dev/null
docker rm -f dh-web dh-base >/dev/null 2>&1 || true

if ! docker ps --format '{{.Names}}' | grep -qx dh-mysql; then
  docker rm -f dh-mysql >/dev/null 2>&1 || true
  docker run -d --name dh-mysql --restart unless-stopped --network dh-net --memory 600m \
    -e MYSQL_ROOT_PASSWORD="$MYSQL_ROOT_PASSWORD" -v "$ROOT/mysql-data:/var/lib/mysql" mysql:8.0 \
    --character-set-server=utf8mb4 --performance-schema=OFF --innodb-buffer-pool-size=128M --max-allowed-packet=64M >/dev/null
fi

# 应用：按基座流程解压并安装（本机连不上内网源时只替换源地址，包名/版本/校验值不变）
APP="$ROOT/live"; rm -rf "$APP"; mkdir -p "$APP"; (cd "$APP" && unzip -q "$ZIP")
if [ "${USE_PUBLIC_REGISTRY:-1}" = 1 ]; then
  sed -i 's#https://cmc.centralrepo.rnd.huawei.com/artifactory/api/npm/npm-central-repo/#https://registry.npmjs.org/#g' "$APP/package-lock.json" "$APP/.npmrc"
fi
docker run --rm -v "$APP:/app" -w /app $NODE_IMG sh -c 'npm ci --omit=dev --ignore-scripts --no-audit --no-fund 2>&1 | tail -1'

cp "$HERE/server.mjs" "$HERE/package.json" "$ROOT/base/"; cp "$APP/db/init.sql" "$ROOT/base/init.sql"
docker run --rm -v "$ROOT/base:/base" -w /base $NODE_IMG sh -c 'npm install --omit=dev --no-audit --no-fund 2>&1 | tail -1'

docker run -d --name dh-base --restart unless-stopped --network dh-net -p ${DH_PORT}:5401 -v "$ROOT/base:/base" -w /base \
  -e MYSQL_HOST=dh-mysql -e MYSQL_PASSWORD="$MYSQL_ROOT_PASSWORD" -e APP_SCHEMA="$SCHEMA" -e APP_UUID="$UUID" \
  -e APP_UPSTREAM=http://dh-web:5400 -e INIT_SQL=/base/init.sql -e GATEWAY_STRIP="${GATEWAY_STRIP:-1}" $NODE_IMG node server.mjs >/dev/null

# 模拟基座行为：往应用目录放一个 CommonJS 的 dh-identity-loader.js 并预加载。
# 根目录 package.json 一旦声明 "type": "module"，这里就会像真实基座上一样启动失败。
{ for i in $(seq 1 15); do echo "// platform identity loader (emulated) line $i"; done; echo 'const http = require("http");'; echo 'void http;'; } > "$APP/dh-identity-loader.js"

docker run -d --name dh-web --restart unless-stopped --network dh-net -v "$APP:/app" -w /app \
  -e PORT=5400 -e APP_UUID="$UUID" -e APP_SCHEMA="$SCHEMA" -e APP_DATASOURCE_ID=2 \
  -e BASE_QUERY_URL=http://dh-base:5401/query -e BASE_EXECUTE_URL=http://dh-base:5401/execute \
  ${DH_ADMIN_USERS:+-e DH_ADMIN_USERS="$DH_ADMIN_USERS"} $NODE_IMG node -r ./dh-identity-loader.js run.js >/dev/null

for i in $(seq 1 60); do curl -sf -m 3 "http://127.0.0.1:${DH_PORT}/digital-human/dh/${UUID}/api/healthz" >/dev/null 2>&1 && break; sleep 2; done
docker logs --tail 4 dh-base
curl -s -m 5 "http://127.0.0.1:${DH_PORT}/digital-human/dh/${UUID}/api/healthz" | head -c 240; echo
