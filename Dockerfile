# Tahap 2: Node 22 + Prisma SQLite. LibreOffice (Tahap 3) menyusul.
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci && npx prisma generate

FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
# Render via OnlyOffice Document Server terpisah (lihat docker-compose.yml),
# jadi image backend tetap ramping — tanpa LibreOffice.
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY dist ./dist
COPY prisma ./prisma
COPY public ./public
VOLUME ["/app/storage"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
