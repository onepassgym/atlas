# atlas Local Development Guide

This guide will walk you through setting up and running the atlas Google Maps Scraper and Mission Control Dashboard on your local machine for development.

## Prerequisites
- **Node.js**: v20 or higher
- **NPM**: v10 or higher
- **Docker Desktop** (Highly Recommended for databases)

---

## The "One Command" Start
We have configured a `dev:all` script that launches all 5 application processes (API, 3 workers, and Frontend) simultaneously with color-coded logs in a single terminal.

Before you can run it, you must ensure your databases (MongoDB & Redis) are running.

## 🛠️ Step 1: Start the Databases (Choose A or B)

The application requires **MongoDB** (running on port `27328`) and **Redis** (running on port `6847`).

### Option A: Using Docker (Recommended & Easiest)
This is the smoothest way to run the databases on the exact custom ports required by the `.env` file without installing them natively to your Mac.

1. Open **Docker Desktop** on your Mac.
2. Wait for the Docker Daemon to start (the whale icon turns green in your top menu bar).
3. Open terminal, navigate to the `atlas05` root folder, and start just the databases in the background:
   ```bash
   docker compose up -d mongo redis
   ```
*(This maps Mongo to 27328 and Redis to 6847 exactly as the app expects).*

### Option B: Using Native Homebrew (If you absolutely cannot use Docker)
To run natively, you must map your local default installs to the custom ports expected by the app.

1. Install Mongo and Redis:
   ```bash
   brew tap mongodb/brew
   brew install mongodb-community redis
   ```
2. Start them natively on the custom ports requested by your `.env`:
   ```bash
   mongod --dbpath /tmp/mongodb --port 27328 --fork --logpath /tmp/mongodb.log
   redis-server --port 6847 --daemonize yes
   ```
*(Alternatively, you can edit your `.env` file to set `DEV_MONGODB_URI=mongodb://127.0.0.1:27017/atlas05` and `DEV_REDIS_PORT=6379` to use the brew defaults, then just run `brew services start mongodb-community` and `brew services start redis`)*.

---

## 🐳 Option C: "The Powerhouse" — Full Docker Stack (Recommended)
This is the most seamless way to develop. It runs the entire infrastructure (API, MongoDB, Redis, all Workers, AND the Dashboard) in Docker with full **Hot-Reloading** (HMR) enabled.

1. **Ensure Docker Desktop is running.**
2. **Setup environment variables:** Ensure your `.env` file is present in the root.
3. **Launch everything:**
   ```bash
   docker compose up --build
   ```
   *This starts 7 containers in total:*
   - `atlas-api`: The backend server (Port 8747)
   - `atlas-dashboard`: The React SPA (Port 5173 with HMR!)
   - `atlas-worker`: The main scraper
   - `atlas05-enrichment-worker`: The enrichment engine
   - `atlas05-media-worker`: Media processor
   - `atlas-mongo`: Database (Port 27328)
   - `atlas-redis`: Cache/Queue (Port 6847)

**Why use this?** Any changes you make to your code (in `./src` or `./dashboard/src`) will be instantly detected by the containers, and they will restart/reload automatically.

---

## 🚀 Alternative: Host Mode (Manual)
If you prefer running Node directly on your Mac (Option A or B):

```bash
npm run dev:all
```

**What this does under the hood:**
This utilizes the `concurrently` package to spawn 5 independent processes in one terminal window:
1. `[cyan]` **API Server:** Boots on `http://localhost:8747`
2. `[magenta]` **Main Worker:** Handles the heavy lifting for Google Maps venue scraping.
3. `[yellow]` **Enrichment Worker:** Manages the continuous LIFO/FIFO data staleness loop.
4. `[green]` **Chain Worker:** Manages the gym chain intelligence engine.
5. `[blue]` **Dashboard Frontend:** Boots the Vite React SPA on `http://localhost:5173`.

---

## 🛑 Step 3: Stopping the Environment

- **To stop the application:** Simply press `Ctrl + C` in the terminal where `npm run dev:all` is running. Concurrently will safely shut down the API, workers, and frontend.
- **To stop the databases (If using Docker):** Run `docker compose stop mongo redis`.

## 💡 Troubleshooting

- **`EADDRINUSE: address already in use :::8747`**
  A ghost process hasn't cleanly shut down. Run `lsof -ti:8747 | xargs kill -9` to free the port.

- **`ECONNREFUSED 127.0.0.1:27328` or `6847`**
  Your MongoDB or Redis instance crashed or was never started. Ensure Docker Desktop is actually running, or your manual brew commands succeeded.

- **Browser Crashes (Playwright)**
  If the scraper fails immediately, assure Playwright browsers are installed: `npx playwright install chromium --with-deps`.

---

## 🛠️ Useful Docker Commands

- **View Logs:**
  ```bash
  docker compose logs -f
  ```
  *(To follow logs for a specific service: `docker compose logs -f api`)*

- **Shutdown and Clean Volumes:**
  ```bash
  docker compose down -v
  ```

- **Restart a single service:**
  ```bash
  docker compose restart enrichment-worker
  ```
