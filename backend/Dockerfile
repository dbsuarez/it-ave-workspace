FROM node:20-alpine3.20

# Match the PostgreSQL 15 server. Newer pg_dump versions add settings that PostgreSQL 15 cannot restore.
RUN apk add --no-cache postgresql15-client

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 3001
CMD ["node", "server.js"]
