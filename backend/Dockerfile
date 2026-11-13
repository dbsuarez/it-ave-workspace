FROM node:20-alpine

RUN apk add --no-cache postgresql-client

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 3001
CMD ["node", "server.js"]
