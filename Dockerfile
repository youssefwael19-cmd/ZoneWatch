# Node 22 is the oldest line still receiving security fixes that also ships a
# built-in WebSocket client, which server/brokers/ctrader.js needs: Node 20 has
# no global WebSocket, so direct cTrader mode could never connect there.
FROM node:22-slim

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application code
COPY . .

# Ensure data directory exists and symlink persisted files onto the host's
# persistent disk, mounted at /app/data (a Render disk, a compose volume, or a
# directory you bind-mount on a plain VM).
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
    ln -sf /app/data/shadow.json /app/shadow.json && \
    ln -sf /app/data/digest.json /app/digest.json && \
    ln -sf /app/data/paperreview.json /app/paperreview.json && \
    ln -sf /app/data/dailyrecap.json /app/dailyrecap.json && \
    ln -sf /app/data/newscalendar.json /app/newscalendar.json

# The host sets PORT and the app honours it (server/index.js reads
# process.env.PORT). 10000 keeps Render's probe happy if this image is ever run
# there. deploy/docker-compose.yml pins PORT=8080 for the self-hosted setup, and
# a container started with no PORT at all still answers on 10000.
ENV NODE_ENV=production
ENV PORT=10000

EXPOSE 10000

CMD ["node", "server/index.js"]
