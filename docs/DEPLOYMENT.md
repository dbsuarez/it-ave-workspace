# IT Avenue Workspace - Deployment Guide

This guide covers deploying IT Avenue Workspace to a production server (e.g., Hostinger KVM).

## Prerequisites

- A Linux server (Ubuntu 22.04 LTS recommended) with at least 2GB RAM and 2 CPU cores
- A domain name pointing to your server's IP address
- Root access to the server
- Docker and Docker Compose installed on the server

## 1. Prepare the Server

```bash
# Update the system
sudo apt update && sudo apt upgrade -y

# Install Docker and Docker Compose
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo usermod -aG docker $USER

# Install Nginx
sudo apt install -y nginx
```

## 2. Deploy the Application

```bash
# Clone the repository
git clone https://github.com/dbsuarez/it-ave-workspace.git
cd itavenue-workspace

# Copy environment files and edit them
cp .env.example .env
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env 2>/dev/null || true

# Edit .env files with your values
nano .env
nano backend/.env
```

### Important Environment Variables

**Backend (.env):**
- `GHIDRA_INSTALL_DIR` - Path to extracted Ghidra 12.1.x (if using REA integration)
- `JAVA_HOME` - Path to JDK 21+
- `GHIDRA_INSTALL_DIR` - Path to extracted Ghidra 12.1.x
- `DATABASE_URL` - PostgreSQL connection string
- `JWT_SECRET` - Long random secret for JWT signing
- `SUPERADMIN_USERNAME` - Username for the initial superadmin account

**Frontend:**
- `VITE_API_URL` - Your deployed backend URL (e.g., `https://itavenue.yourdomain.com`)

## 3. Start the Backend

```bash
cd D:\Development\itavenue-workspace
docker compose up -d
```

Verify the backend is running:
```bash
docker compose ps
curl http://localhost:3001/api/health
```

## 4. Configure Nginx Reverse Proxy

Install the Nginx configuration:

```bash
# Copy the Nginx config
sudo cp deploy/nginx.conf /etc/nginx/sites-available/itavenue

# Enable the site
sudo ln -s /etc/nginx/sites-available/itavenue /etc/nginx/sites-enabled/

# Remove default site
sudo rm /etc/nginx/sites-enabled/default

# Test and reload Nginx
sudo nginx -t
sudo systemctl reload nginx
```

## 5. Set Up SSL with Let's Encrypt

```bash
# Install Certbot
sudo apt install -y certbot python3-certbot-nginx

# Obtain SSL certificate
sudo certbot --nginx -d itavenue.yourdomain.com

# Set up auto-renewal
sudo crontab -e
# Add: 0 3 * * * /usr/bin/certbot renew --quiet
```

## 6. Create Systemd Service for Backend

```bash
# Copy the systemd service file
sudo cp deploy/itavenue-backend.service /etc/systemd/system/

# Enable and start the service
sudo systemctl daemon-reload
sudo systemctl enable itavenue-backend
sudo systemctl start itavenue-backend
```

Verify the service is running:
```bash
systemctl status itavenue-backend
```

## 7. Build and Run the Desktop App

### Windows (.exe installer)
```bash
cd frontend
npm install
npm run dist
```
This produces an NSIS installer in `dist/`.

### macOS (.dmg)
```bash
cd frontend
npm run dist
```
This produces a DMG in `dist/`.

### Linux (AppImage)
```bash
cd frontend
npm run dist
```
This produces an AppImage in `dist/`.

## 8. Android Capacitor Wrapper

The Android wrapper is in `frontend/android-capacitor/`. To build:

```bash
cd frontend/android-capacitor
npm install
npx cap init
npm run dist          # Build the web app first
npx cap sync          # Sync web assets to Android
npx cap open android  # Open in Android Studio
```

Then build the APK/AAB from Android Studio.

## Environment Variables Reference

### Backend (.env)

| Variable | Description | Example |
|----------|-------------|---------|
| `BACKEND_PORT` | Backend port | `3001` |
| `FRONTEND_URL` | Frontend URL for CORS | `https://itavenue.yourdomain.com` |
| `POSTGRES_USER` | Database user | `itavenue` |
| `POSTGRES_PASSWORD` | Database password | `changeme` |
| `POSTGRES_DB` | Database name | `itavenue` |
| `DATABASE_URL` | Full PostgreSQL connection string | `postgresql://itavenue:change_me@db:5432/itavenue` |
| `JWT_SECRET` | JWT signing secret | `replace_with_secure_random` |
| `JWT_EXPIRES_IN` | JWT expiry | `7d` |
| `SUPERADMIN_USERNAME` | Initial superadmin username | `admin` |
| `MAX_FILE_SIZE_MB` | Max upload size in MB | `25` |
| `UPLOAD_DIR` | Upload directory | `/app/uploads` |
| `WEBRTC_ICE_SERVERS` | WebRTC ICE servers (JSON) | `[{"urls":"stun:stun.l.google.com:19302"}]` |

### Frontend

| Variable | Description | Example |
|----------|-------------|---------|
| `VITE_API_URL` | Backend API URL | `https://itavenue.yourdomain.com` |

## Troubleshooting

### Backend won't start
```bash
docker compose logs backend
```

### Database connection issues
```bash
docker compose logs db
docker exec -it itavenue-db psql -U itavenue -d itavenue -c "\dt"
```

### Frontend build fails
```bash
cd frontend
rm -rf node_modules package-lock.json
npm install
npm run dist
```

### Mobile app build fails
```bash
cd frontend/android-capacitor
npm install
npx cap sync
npx cap open android
# Then build in Android Studio
```

## Support

For issues, check the logs:
- Backend: `docker logs itavenue-backend`
- Database: `docker logs itavenue-db`
- Frontend: Check Electron DevTools (Ctrl+Shift+I)
