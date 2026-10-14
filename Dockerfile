# Multi-Stage Production Dockerfile for FilmFinder
FROM node:20-alpine AS dependencies
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# Run container under unprivileged user
USER node

# Copy dependencies and application source
COPY --chown=node:node --from=dependencies /app/node_modules ./node_modules
COPY --chown=node:node package*.json ./
COPY --chown=node:node app.js ./
COPY --chown=node:node aggregation.js ./
COPY --chown=node:node imdb-top-100.json ./
COPY --chown=node:node oscar-nominations.json ./
COPY --chown=node:node views ./views
# The interface and browser scripts are inline in EJS; no static assets are needed.

EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/healthz || exit 1

CMD ["node", "app.js"]
