FROM node:20-slim

WORKDIR /app

# Install cloudflared for Cloudflare tunnel support
RUN apt-get update && apt-get install -y curl openssh-server && \
    curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
    -o /usr/local/bin/cloudflared && \
    chmod +x /usr/local/bin/cloudflared && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY dist/ ./dist/

COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh

EXPOSE 3000 22

ENTRYPOINT ["./entrypoint.sh"]
