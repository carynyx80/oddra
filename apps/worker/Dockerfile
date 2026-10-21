# Oddra worker: build from the repository root
#   docker build -f apps/worker/Dockerfile -t oddra-worker .
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages ./packages
COPY apps/worker ./apps/worker
COPY contracts/deployments ./contracts/deployments
RUN npm ci --workspace @oddra/worker --workspace @oddra/db --workspace @oddra/engine --workspace @oddra/shared --include-workspace-root=false \
 && npx prisma generate --schema packages/db/prisma/schema.prisma
ENV NODE_ENV=production PORT=8787
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# apply migrations, then run; SIGTERM releases the leader lease cleanly
CMD ["sh", "-c", "npx prisma migrate deploy --schema packages/db/prisma/schema.prisma && npx tsx packages/db/src/seed.ts && npx tsx apps/worker/src/index.ts"]
