FROM node:20-alpine

WORKDIR /app

# Install dependencies first (cached layer)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy app files
COPY listener.js ./
COPY public/ ./public/

EXPOSE 3000 3001

CMD ["node", "listener.js"]
