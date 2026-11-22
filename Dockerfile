FROM oven/bun:1.3.5

WORKDIR /app

COPY package.json bun.lock ./

RUN bun install --frozen-lockfile --production

COPY src ./src

EXPOSE 6767

CMD ["sh", "-c", "bun run db:init && bun run src/index.ts"]
