# syntax=docker/dockerfile:1
FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile && pnpm build
RUN pnpm --filter tokenyard deploy --prod /out

FROM node:22-slim
ENV TOKENYARD_HOME=/data
WORKDIR /app
COPY --from=build /out ./
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
# Inside the container the gateway must listen on all interfaces. Publish the port on the
# host's loopback only (see docs/docker.md); never expose it to a network.
ENTRYPOINT ["node", "dist/cli.mjs"]
CMD ["start", "--host", "0.0.0.0", "--port", "8787"]
