FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN corepack pnpm install --frozen-lockfile
COPY . .
RUN corepack pnpm build
RUN corepack pnpm prune --prod

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production SOURCE_DIR=/app/source
COPY --from=build /app/package.json /app/pnpm-lock.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/apps ./source/apps
COPY --from=build /app/packages ./source/packages
COPY --from=build /app/tests ./source/tests
COPY --from=build /app/scripts ./source/scripts
COPY --from=build /app/docs ./source/docs
COPY --from=build /app/.github ./source/.github
COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/tsconfig.json /app/tsconfig.server.json /app/vite.config.ts /app/postcss.config.cjs /app/vitest.config.ts /app/playwright.config.ts /app/Dockerfile /app/compose.yaml /app/compose.agent.yaml /app/LICENSE /app/README.md /app/DESIGN.md /app/.env.example /app/.env.agent.example /app/.dockerignore ./source/
EXPOSE 3000
CMD ["node", "dist/server/apps/api/index.js"]
