FROM oven/bun:1-alpine

RUN apk add --no-cache ffmpeg

ENV NODE_ENV=production

WORKDIR /app

COPY --chown=bun:bun package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY --chown=bun:bun . .

USER bun

CMD ["bun", "run", "start"]
