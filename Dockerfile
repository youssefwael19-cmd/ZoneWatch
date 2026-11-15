FROM node:20-slim

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application code
COPY . .

# Ensure data directory exists and symlink persisted files to volume
RUN mkdir -p /app/data && \
    ln -sf /app/data/settings.json /app/settings.json && \
    ln -sf /app/data/zones.json /app/zones.json && \
    ln -sf /app/data/alerts.json /app/alerts.json && \
    ln -sf /app/data/signals.json /app/signals.json && \
    ln -sf /app/data/recap.json /app/recap.json && \
    ln -sf /app/data/heartbeat.json /app/heartbeat.json && \
    ln -sf /app/data/state.json /app/state.json && \
    ln -sf /app/data/lab.json /app/lab.json && \
    ln -sf /app/data/learning.json /app/learning.json && \
    ln -sf /app/data/health.json /app/health.json && \
    ln -sf /app/data/brain.json /app/brain.json && \
    ln -sf /app/data/journal.json /app/journal.json && \
    ln -sf /app/data/executor.json /app/executor.json && \
    ln -sf /app/data/digest.json /app/digest.json && \
    ln -sf /app/data/paperreview.json /app/paperreview.json

# Fly.io sets PORT, default to 8080
ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

CMD ["node", "server/index.js"]
