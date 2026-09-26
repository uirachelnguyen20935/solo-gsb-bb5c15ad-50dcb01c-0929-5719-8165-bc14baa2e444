FROM node:20-bookworm-slim

# better-sqlite3 在没有预编译二进制时需要从源码编译
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先拷依赖清单，便于在镜像构建期缓存 node_modules（容器启动时仍会按要求执行 npm install 校验/补装）
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund || true

COPY . .

RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 3000

ENTRYPOINT ["/app/docker-entrypoint.sh"]
