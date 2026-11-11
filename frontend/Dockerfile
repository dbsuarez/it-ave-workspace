# IT Avenue Workspace - Frontend (Electron) Dockerfile
# Builds the Electron desktop application for Windows/Linux/macOS
FROM node:20-alpine

WORKDIR /app

# Install build dependencies for native modules
RUN apk add --no-cache python3 make g++ && rm -rf /var/cache/apk/*

# Copy package files and install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy application code
COPY . .

# Build the Electron app (produces unpacked dist)
RUN npm run build

# Expose nothing - this is a desktop app build, not a server
# The built app is in frontend/dist/
