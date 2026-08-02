# 🚀 Deployment Guide — atlas.onepassgym.com

Step-by-step guide to deploy atlas Scraper on your Hostinger VPS
and map it to `atlas.onepassgym.com`.

---

## Port Reference

| Service | External Port | Notes |
|---------|--------------|-------|
| atlas API | **8747** | Nginx proxies → this |
| MongoDB | **27327** | Non-default, avoids conflicts |
| Redis | **6847** | Non-default, avoids conflicts |

---

## Prerequisites

- Hostinger VPS (Ubuntu 22.04 recommended)
- Domain: `atlas.onepassgym.com` pointing to your VPS IP
- SSH access to VPS

---

## Step 1 — Point DNS to Your VPS

In your domain registrar (or Hostinger DNS panel):

```
Type   Name               Value
────────────────────────────────────────────
A      atlas              <YOUR_VPS_IP>
```

Wait 5–30 minutes for DNS to propagate. Verify:

```bash
ping atlas.onepassgym.com
# Should resolve to your VPS IP
```

---

## Step 2 — Initial VPS Setup

SSH into your VPS:

```bash
ssh root@<YOUR_VPS_IP>
```

Update system + install essentials:

```bash
apt update && apt upgrade -y
apt install -y curl git ufw nginx certbot python3-certbot-nginx
```

Install **Node.js 20** via NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
node --version   # should show v20.x.x
npm --version
```

Install **Docker + Docker Compose**:

```bash
curl -fsSL https://get.docker.com | bash
systemctl enable docker && systemctl start docker

# Docker Compose v2
apt install -y docker-compose-plugin
docker compose version
```

---

## Step 3 — Firewall Setup

```bash
ufw allow OpenSSH
ufw allow 80/tcp      # HTTP (for Certbot + redirect)
ufw allow 443/tcp     # HTTPS
ufw allow 8747/tcp    # atlas API (Nginx will proxy this)
ufw enable
ufw status
```

> **Do NOT open 27327 or 6847 to public.** MongoDB and Redis stay internal.

---

## Step 4 — Deploy the App

```bash
# Create app directory
mkdir -p /var/www/atlas
cd /var/www/atlas

# Clone / upload your project
git clone <YOUR_REPO_URL> .
# OR use scp from your local machine:
# scp -r ./atlas-scraper root@<VPS_IP>:/var/www/atlas/

# Set production env
cp .env.example .env
nano .env
```

Edit these values in `.env` for production:

```env
PORT=8747
NODE_ENV=production
MONGODB_URI=mongodb://127.0.0.1:27327/atlas
REDIS_HOST=127.0.0.1
REDIS_PORT=6847
MEDIA_BASE_URL=https://atlas.onepassgym.com/media
SCRAPER_HEADLESS=true
SCRAPER_CONCURRENCY=3
LOG_LEVEL=info
```

---

## Step 5 — Start with Docker Compose

```bash
cd /var/www/atlas

# Build and start all services
docker compose up -d --build

# Verify all 4 containers are running
docker compose ps

# Watch logs
docker compose logs -f api
docker compose logs -f worker
```

Expected output:
```
NAME                    STATUS
atlas-api          running (healthy)
atlas-worker       running
atlas-mongo        running (healthy)
atlas-redis        running (healthy)
```

Test that the API is responding:
```bash
curl http://localhost:8747/health
# { "status": "ok", "service": "atlas Scraper", ... }
```

---

## Step 6 — Configure Nginx Reverse Proxy

Create the Nginx site config:

```bash
nano /etc/nginx/sites-available/atlas.onepassgym.com
```

Paste this config:

```nginx
server {
    listen 80;
    server_name atlas.onepassgym.com;

    # Let Certbot handle HTTPS redirect after SSL setup
    location / {
        proxy_pass         http://127.0.0.1:8747;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection 'upgrade';
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 300s;
        proxy_connect_timeout 10s;
        client_max_body_size 50M;
    }

    # Serve media files directly via Nginx (faster than Node)
    location /media/ {
        alias /var/www/atlas/media/;
        expires 7d;
        add_header Cache-Control "public, immutable";
        try_files $uri $uri/ =404;
    }

    # Gzip
    gzip on;
    gzip_types text/plain application/json application/javascript text/css;
    gzip_min_length 1000;
}
```

Enable site and test:

```bash
ln -s /etc/nginx/sites-available/atlas.onepassgym.com /etc/nginx/sites-enabled/
nginx -t        # must say: syntax is ok
systemctl reload nginx
```

Test HTTP first:
```bash
curl http://atlas.onepassgym.com/health
```

---

## Step 7 — SSL Certificate (HTTPS)

```bash
certbot --nginx -d atlas.onepassgym.com
```

Follow prompts:
- Enter your email
- Agree to ToS
- Select option **2** (redirect HTTP → HTTPS)

Certbot auto-updates your Nginx config. Verify:

```bash
curl https://atlas.onepassgym.com/health
# { "status": "ok", ... }
```

Auto-renewal is set up automatically. Test it:
```bash
certbot renew --dry-run
```

---

## Step 8 — Verify Scheduled Jobs

The scraper auto-queues Delhi, Ghaziabad, Gurugram, and Noida on **first startup**.
Then repeats every **Sunday at 2:00 AM IST** automatically.

Check logs to confirm:

```bash
docker compose logs api | grep -i "ncr\|queued\|scheduled"
```

Expected output on first run:
```
🆕 First run detected — immediately queuing NCR cities
  ✅ Queued: Delhi, India → jobId: xxxx
  ✅ Queued: Ghaziabad, Uttar Pradesh, India → jobId: xxxx
  ✅ Queued: Gurugram, Haryana, India → jobId: xxxx
  ✅ Queued: Noida, Uttar Pradesh, India → jobId: xxxx
⏰ Scheduler started — NCR cities crawl: every Sunday 02:00 AM IST
```

Check job status via API:
```bash
curl https://atlas.onepassgym.com/api/crawl/jobs
```

---

## Step 9 — Keep Containers Running on Reboot

Docker Compose services already have `restart: unless-stopped`.
Just make sure Docker starts on boot:

```bash
systemctl enable docker
```

Optionally add a cron to auto-start compose if VPS reboots:

```bash
crontab -e
# Add this line:
@reboot cd /var/www/atlas && docker compose up -d
```

---

## Useful Commands (Day-to-Day)

```bash
# View all service status
docker compose ps

# View live API logs
docker compose logs -f api

# View live worker logs (see scraping progress)
docker compose logs -f worker

# Restart just the worker
docker compose restart worker

# Check queue status
curl https://atlas.onepassgym.com/api/crawl/queue/stats

# Check DB stats
docker compose exec api node scripts/dbStats.js

# Manually trigger NCR crawl now (without waiting for Sunday)
curl -X POST https://atlas.onepassgym.com/api/crawl/batch \
  -H "Content-Type: application/json" \
  -d '{"cities": ["Delhi, India", "Ghaziabad, Uttar Pradesh, India", "Gurugram, Haryana, India", "Noida, Uttar Pradesh, India"]}'

# Add a new city
curl -X POST https://atlas.onepassgym.com/api/crawl/city \
  -H "Content-Type: application/json" \
  -d '{"cityName": "Mumbai, India"}'

# Pull latest code + redeploy
cd /var/www/atlas
git pull origin main
docker compose up -d --build

# Stop everything
docker compose down

# Stop + wipe all data (careful!)
docker compose down -v
```

---

## Media File Access

Photos are stored at `/var/www/atlas/media/` on the VPS
and served at `https://atlas.onepassgym.com/media/`.

Example URL:
```
https://atlas.onepassgym.com/media/photos/my-gym-delhi/abc123.jpg
https://atlas.onepassgym.com/media/thumbnails/th_abc123.jpg
```

Nginx serves these directly (bypasses Node.js) for maximum speed.

---

## MongoDB Direct Access (from VPS)

```bash
# Connect to MongoDB inside Docker
docker compose exec mongo mongosh atlas

# From VPS host (using mapped port 27327)
mongosh mongodb://127.0.0.1:27327/atlas

# Useful queries
db.gyms.countDocuments()
db.gyms.find({ areaName: /Delhi/i }).limit(5).pretty()
db.crawl_jobs.find({ status: 'running' }).pretty()
```

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `502 Bad Gateway` | API container not running — `docker compose restart api` |
| `curl: (6) Could not resolve host` | DNS not propagated yet — wait & retry |
| MongoDB connection failed | Check `docker compose ps` — mongo container healthy? |
| SSL cert fails | Make sure port 80 is open in UFW and DNS resolves correctly |
| Worker not processing jobs | Redis not healthy? `docker compose restart redis worker` |
| Photos not serving | Check `/var/www/atlas/media/` permissions: `chmod -R 755 media/` |
| Job stuck in `queued` | Worker crashed — `docker compose logs worker` to diagnose |

---

## Architecture on VPS

```
Internet
    │
    ▼
Nginx :443 (HTTPS)
atlas.onepassgym.com
    │
    ├─ /api/*    → proxy → Node.js API :8747
    ├── /media/* → static → /var/www/atlas/media/
    └─ /health   → proxy → Node.js API :8747

Node.js API :8747
    ├─ Express routes
    ├─ node-cron scheduler (Sunday 2AM IST)
    └─ Bull job producer

Bull Queue (Redis :6847)
    │
    ▼
Queue Worker (Node.js)
    ├─ Playwright (Chromium headless)
    ├─ Google Maps scraper
    └─ MongoDB writer

MongoDB :27327
    └─ atlas DB
         ├─ gyms collection
         └─ crawl_jobs collection
```
