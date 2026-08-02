# 🚀 Production Release Guide — atlas Scraper

This guide details the steps to publish the atlas API-first scraper specifically for a production environment (`NODE_ENV=production`).

---

## 1. Environment Handling Changes

As part of the latest production hardening, **Local Mode has been disabled for production deployments.** 
When `NODE_ENV=production` is set in the environment:
- The `/dashboard` endpoint automatically injects the production configuration.
- The **"Local / Production" toggle switch is forcefully hidden** and disabled in the UI.
- All scheduled system tasks, API requests, and Mission Control interactions will point directly to `https://atlas.onepassgym.com`.
- Swagger API Docs will restrict server selection to only the Production server URL.

---

## 2. Server Deployment Variables (`.env`)

Before restarting or applying updates, verify that your `/var/www/atlas/.env` file is properly configured with production defaults:

```env
PORT=8747
NODE_ENV=production

# The application respects these PROD_ variables automatically in production mode:
PROD_MONGODB_URI="mongodb://147.79.71.238:27328/atlas?directConnection=true"
PROD_REDIS_HOST=127.0.0.1
PROD_REDIS_PORT=6847
PROD_MEDIA_BASE_URL=https://atlas.onepassgym.com/media

# Fallbacks/Globals
API_KEYS=YOUR_SECURE_API_KEY_HERE
LOG_LEVEL=info
SCRAPER_HEADLESS=true
```

*(Note: Never configure `NODE_ENV=development` or `local` if the system is live, to protect the integrity of the data stream).*

---

## 3. Pulling & Releasing to Production

Run the following routine on the Hostinger VPS to deploy new changes without downtime if possible:

```bash
# 1. SSH into the production VPS
ssh root@147.79.71.238

# 2. Navigate to the installation directory
cd /var/www/atlas

# 3. Pull latest changes from the master/main branch
git pull origin main

# 4. Re-build the docker containers to catch new Node dependencies or code
# The -d flag detaches and runs in background, --build forces rebuild
docker compose up -d --build

# 5. Flush outdated or broken queue items if necessary (Optional)
curl -X POST https://atlas.onepassgym.com/api/system/schedule/trigger/stale \
  -H "X-API-Key: YOUR_SECURE_API_KEY_HERE"
```

## 4. Verification & Health Checks

After running `docker compose up -d --build`, check that the deployment is stable:

1. **Verify API is alive:**
   ```bash
   curl -I https://atlas.onepassgym.com/health
   # Expected output: HTTP/2 200 (or HTTP/1.1 200 OK)
   ```

2. **Verify Mission Control is on Prod Mode:**
   Visit `https://atlas.onepassgym.com/dashboard`.
   You should NOT see the `Local | Production` toggle button in the top left, confirming `__SERVER_ENV__` was injected successfully as `production`.

3. **Check Container Logs (Post-deployment):**
   ```bash
   docker compose logs --tail=100 -f api
   docker compose logs --tail=100 -f worker
   ```

## 5. Rollback Process

If the release fails or produces errors:
1. Revert the commit locally and push, OR checkout the last stable commit hash via git:
   ```bash
   git checkout <previous_working_commit_hash>
   ```
2. Re-run building with docker compose:
   ```bash
   docker compose up -d --build
   ```
3. Monitor logs to ensure rollback restored stability.

---

**End of Release Guide**
