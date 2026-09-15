# 🏗️ Atlas — Architecture Reference

> **Living document.** Keep this updated as modules change.  
> Last updated: **2026-09-15 (Crawling Process Overhaul & Reliability Hardening)**

---

## Table of Contents

1. [System Overview](#system-overview)
2. [Process Architecture](#process-architecture)
3. [Directory Map](#directory-map)
4. [Module Reference](#module-reference)
   - [API Layer](#api-layer)
   - [Scraper Engine](#scraper-engine)
   - [Queue System & Workers](#queue-system--workers)
   - [Database Layer](#database-layer)
   - [Services](#services)
   - [Media Pipeline](#media-pipeline)
   - [Utilities](#utilities)
   - [Configuration](#configuration)
5. [Data Models](#data-models)
6. [API Route Inventory](#api-route-inventory)
7. [Crawling Architecture](#crawling-architecture)
   - [City Crawl & Batch Pipeline](#city-crawl--batch-pipeline)
   - [Grid Crawl Discovery](#grid-crawl-discovery)
   - [Chain Crawl Pipeline](#chain-crawl-pipeline)
   - [Dual Enrichment Architecture](#dual-enrichment-architecture)
   - [Adaptive Throttle & Circuit Breaker](#adaptive-throttle--circuit-breaker)
8. [Upsert & Deduplication Engine](#upsert--deduplication-engine)
9. [Configuration Reference](#configuration-reference)
10. [Infrastructure](#infrastructure)
11. [Known Technical Debt](#known-technical-debt)
12. [Conventions & Patterns](#conventions--patterns)
13. [Changelog](#changelog)

---

## System Overview

Atlas is an **enterprise Google Maps fitness space & wellness venue discovery, crawling, and enrichment platform** operating across multiple modular Node.js worker and API processes backed by MongoDB and Redis.

| Component | Technology | Purpose |
|-----------|-----------|---------|
| API Server | Express 4 | REST API for crawl management, space data, system control, scheduling |
| Dashboard | React 19 + Vite 6 | Real-time Mission Control SPA for live monitoring |
| Crawl Worker | BullMQ Worker | Executes city discovery, category searches, and batch-scrape jobs |
| Chain Worker | BullMQ Worker | Dedicated worker for chain discovery (locators + OSM + Maps) |
| Enrichment Worker | Standalone Daemon | Continuous background enrichment loop for priority and stale spaces |
| Database | MongoDB 7 (Mongoose 8) | Spaces, reviews, photos, crawl jobs, audit change logs, system state |
| Queue | Redis 7 + BullMQ 5 | Job distribution with priority, batching, retry, and cancellation flags |
| Scraper Engine | Playwright + Chromium | Headless browser automation, stealth rotation, fallback selector chains |
| Scheduler | node-cron | Automated recurring city crawls, staleness detection, maintenance sweeps |

**Key Architectural Principles:**
- **Dual-write / Forward-Compatible Schema** — normalized space domain fields alongside raw source captures and diff history.
- **Batch-Scrape Decoupling** — large city crawls split into discrete BullMQ batch jobs for horizontal scaling and fault isolation.
- **Circuit Breaker & Adaptive Throttling** — dynamic backoff with automatic pool tripping on consecutive blocks to safeguard IPs.
- **6-Tier Space Deduplication** — robust matching across slug, maps URL, placeId, coordinate proximity (50m Jaccard), phone, and name+address.
- **Isolated Browser Contexts** — external website scraping runs in isolated pages to avoid corrupting Google Maps sessions.

---

## Process Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│                        API SERVER (src/server.js)                      │
│                                                                        │
│  Express 4 Application                                                 │
│  ├── indexRoutes      GET / (redirects), GET /health                   │
│  ├── crawlRoutes      POST|GET /api/crawl/* (city, grid, chain, batch) │
│  ├── spaceRoutes      GET|PATCH /api/spaces/* (listing, geo, opgId)    │
│  ├── systemRoutes     GET|POST|DELETE /api/system/*                    │
│  ├── eventRoutes      GET /api/events (SSE real-time bus)              │
│  └── dashboard SPA    GET /dashboard/*                                 │
│                                                                        │
│  Scheduler Service (node-cron)                                         │
│  └── Dispatches scheduled crawl jobs to BullMQ queues                  │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
               ┌────────────────────┼────────────────────┐
               │                    │                    │
               ▼                    ▼                    ▼
     Queue: atlas-crawl     Queue: atlas-chain   Queue: atlas-enrichment
     Redis 7 (:6847)        Redis 7 (:6847)      Redis 7 (:6847)
               │                    │                    │
┌──────────────▼────────┐ ┌─────────▼──────────┐ ┌───────▼────────────────┐
│   CRAWL WORKER        │ │    CHAIN WORKER    │ │   ENRICHMENT WORKER    │
│ (queue/worker.js)     │ │ (queue/chainWorker)│ │(queue/enrichmentWorker)│
│                       │ │                    │ │                        │
│ • Discovery (search)  │ │ • Brand Locators   │ │ • Standalone loop      │
│ • Grid discovery      │ │ • OSM Fallback     │ │ • Redis priority queue │
│ • Parallel batch pool │ │ • Proximity dedupe │ │ • MongoDB oldest sweep │
│ • Circuit breaker     │ │ • p-limit throttle │ │ • Selective scraping   │
│ • Page recycling      │ │ • Google Maps ctx  │ │ • Website photo crawl  │
└──────────────┬────────┘ └─────────┬──────────┘ └───────┬────────────────┘
               │                    │                    │
               └────────────────────┼────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                      MONGODB 7 (atlas / atlas DB)                      │
│                                                                        │
│  Collections:                                                          │
│  ├── spaces             Core fitness venue records (rich schema)       │
│  ├── space_reviews      Separate review documents (deduped by reviewId)│
│  ├── space_photos       Separate photo records & URLs                  │
│  ├── space_chains       Brand chains & store locator configurations    │
│  ├── crawl_jobs         Crawl job tracking, batch metrics, errors      │
│  ├── categories         Normalized category taxonomies                 │
│  ├── amenities          Normalized amenity taxonomy                    │
│  ├── spaceChangeLogs    Audit trail of field mutations                 │
│  ├── systemStates       Global pause & crawl pace controls             │
│  └── enrichment_logs    Enrichment run logs & delta tracking           │
└────────────────────────────────────────────────────────────────────────┘
```

---

## Directory Map

```
atlas/
├── config/
│   ├── index.js                     # Centralized config (env-aware dev/prod)
│   └── schedule.json                # Recurring crawl schedule & staleness thresholds
├── src/
│   ├── server.js                    # Express application entry point
│   ├── api/
│   │   ├── indexRoutes.js           # GET / (redirects), GET /health
│   │   ├── crawlRoutes.js           # Crawl lifecycle endpoints (city, grid, chain, batch)
│   │   ├── spaceRoutes.js           # Space listing, geo search, export, details
│   │   ├── systemRoutes.js          # System state, logs, manual triggers
│   │   └── eventRoutes.js           # SSE event bus streaming
│   ├── scraper/
│   │   ├── googleMapsScraper.js     # Playwright engine, browser pool, fallbacks
│   │   ├── websiteScraper.js        # Isolated external website photo scraper
│   │   ├── spaceProcessor.js        # Scraped raw data transformation pipeline
│   │   ├── enrichmentProcessor.js   # Enrichment merge, tasks 1-5, amenity normalization
│   │   └── chainLocators/           # Brand-specific store locator parsers & OSM fallback
│   ├── queue/
│   │   ├── queues.js                # BullMQ queue definitions, cancellation, batching
│   │   ├── worker.js                # Primary crawl worker (discovery + parallel batches)
│   │   ├── chainWorker.js           # Dedicated space chain crawling worker
│   │   ├── enrichmentWorker.js      # Continuous background enrichment daemon
│   │   └── workerUtils.js           # Shared utilities (TTL sleep, AdaptiveThrottle, breaker)
│   ├── db/
│   │   ├── connection.js            # Mongoose connection & reconnect logic
│   │   ├── ensureIndexes.js         # Imperative index verification on boot
│   │   ├── spaceModel.js            # Canonical Space schema & virtuals
│   │   ├── spaceChainModel.js       # SpaceChain schema for brand networks
│   │   ├── reviewModel.js           # Review schema & relative date parser
│   │   ├── photoModel.js            # Photo metadata & storage schema
│   │   ├── crawlJobModel.js         # Crawl job progress & error tracking
│   │   ├── categoryModel.js         # Category taxonomy lookup
│   │   ├── amenityModel.js          # Amenity taxonomy lookup
│   │   ├── systemStateModel.js      # Global crawl speed & pause state
│   │   ├── spaceChangeLogModel.js   # Audit trail of field mutations
│   │   └── upsertSpace.js           # 6-tier deduplication & upsert engine
│   ├── services/
│   │   ├── eventBus.js              # In-memory & Redis PubSub event dispatcher
│   │   ├── schedulerService.js      # Cron jobs for automated recurring crawls
│   │   ├── enrichmentService.js     # Priority queue & pause controls for enrichment
│   │   └── jobCancelState.js        # Fast cancel check utilities
│   ├── media/
│   │   └── downloader.js            # Sharp & Axios image processor (optional)
│   └── utils/
│       ├── logger.js                # Winston logger with daily rotation
│       ├── apiUtils.js              # Standardized ok(), err(), validate() helpers
│       └── opgId.js                 # OPG public ID generator & validator
├── dashboard/                       # React 19 + Vite 6 Mission Control SPA
├── migration/                       # Database backfills and migrations
├── scripts/                         # CLI tools & utility scripts
├── Dockerfile                       # Production container definition
├── docker-compose.yml               # Multi-service local/production stack
├── ARCHITECTURE.md                  # This document
└── README.md                        # Quickstart documentation
```

---

## Module Reference

### Scraper Engine

| File | Exports | Responsibility |
|------|---------|---------------|
| `googleMapsScraper.js` | `BrowserManager`, `searchSpacesInCity()`, `searchSpacesInGrid()`, `scrapeSpaceDetail()`, `scrapeEnrichmentDetail()`, `scrapeSelective()`, `FITNESS_CATEGORIES` | Core Playwright automation, user-agent pool (2026-era), selector fallback chains, coordinate-preserving URL normalization. |
| `websiteScraper.js` | `scrapeWebsitePhotos()` | Extracts high-res OpenGraph and large images from official websites using an **isolated browser page** that leaves Google Maps unaffected. |
| `spaceProcessor.js` | `processSpace()` | Normalizes raw scraped data, parses relative review dates, transforms amenities, and delegates to `upsertSpace()`. |
| `enrichmentProcessor.js` | `processEnrichmentJob()` | Merges deep enrichment scrape results (Tasks 1–5), normalizes heterogeneous amenity formats, updates operational data, and logs field diffs. |

**Key Scraper Constants:**
- `FITNESS_CATEGORIES` — 10 search categories:
  `gym`, `fitness center`, `yoga studio`, `pilates studio`, `crossfit`, `boxing gym`, `martial arts`, `dance studio`, `climbing gym`, `swimming club`.
- `USER_AGENTS` — Pool of 15 current 2026-era user agents (Chrome 135-136, Firefox 138, Edge 136, Safari 18.x).
- Review depths: 0 (fast), 30 (standard), 150 (deep), 500 (enrichment).
- Selector resilience: Multi-selector fallback chains (`tryText`, `tryAttr`, `tryAll`) across names, ratings, addresses, phones, websites, and opening hours.

### Queue System & Workers

| File | Type | Responsibility |
|------|------|---------------|
| `workerUtils.js` | Shared Lib | Shared worker utilities: `sleep()` with 30s TTL `SystemState` cache, `AdaptiveThrottle` with built-in circuit breaker, `updateJob()`, `shouldStop()`. |
| `worker.js` | Worker | Primary crawler: runs city discovery, category searches, grid searches, and divides found URLs into `batch-scrape` jobs processed via parallel page pools with automatic page recycling. |
| `chainWorker.js` | Worker | Dedicated chain crawler: coordinates brand locator queries, OpenStreetMap fallbacks, freshness filtering (7-day window), and Google Maps verification. |
| `enrichmentWorker.js` | Daemon | Continuous autonomous enrichment daemon polling Redis priority queue and MongoDB staleness targets. |

---

## Crawling Architecture

### City Crawl & Batch Pipeline
1. **Discovery Phase**:
   - The primary worker launches Chromium and opens `SEARCH_POOL` parallel pages.
   - Searches across the 10 `FITNESS_CATEGORIES` for the city, scrolling result feeds and capturing place URLs (preserving `/@lat,lng` coordinate anchors).
   - Pre-filters URLs against MongoDB to skip spaces recently crawled within `SKIP_RECENT_DAYS`.
2. **Batch Generation**:
   - The remaining URL list is sliced into chunks of `BATCH_SIZE` (default 25).
   - Dispatches child `batch-scrape` jobs to BullMQ for parallel, distributed execution.
3. **Batch Execution**:
   - Each batch job spins up a browser context with `PAGE_POOL` parallel pages.
   - Uses work-stealing from a shared URL index to process spaces concurrently.
   - **Page Recycling Budget**: Recycles page tabs every 35 URLs to release Chromium memory.
   - **Circuit Breaker**: Trips if consecutive failures or Google blocks exceed threshold (7), halting the pool immediately.
   - **Safe Completion Detection**: Authoritatively checks `batchesDone >= batches` to mark the parent job completed and defers BullMQ cleanup (`removeJobAndBatches`) out of the lock-holding path.

### Dual Enrichment Architecture
Atlas contains two complementary enrichment execution paths:
1. **Standalone Daemon (`enrichmentWorker.js`)**:
   - An infinite loop process (`npm run worker:enrich`) that polls Redis for on-demand priority space IDs, falling back to the oldest updated spaces in MongoDB.
   - Ideal for continuous, steady background enrichment without cluttering job queues.
2. **Queue-Driven Worker (`worker.js` -> `enrichmentQueue`)**:
   - Processes BullMQ jobs submitted via API or the scheduled cron runner.
   - Ideal for batch operations, scheduled sweeps, and tracking explicit job progress.

Both pathways use the unified `enrichmentProcessor.js` and `googleMapsScraper.js` engines, guaranteeing identical validation and deduplication.

---

## Upsert & Deduplication Engine (`upsertSpace.js`)

All space writes flow through `upsertSpace()` to prevent duplicates:

```
findExistingSpace(data)
  │
  ├── Tier 1: slug match?        ──→ EXACT MATCH
  ├── Tier 2: googleMapsUrl?     ──→ EXACT MATCH
  ├── Tier 3: placeId?           ──→ EXACT MATCH
  ├── Tier 4: geo+name?          ──→ MATCH if within 50m AND Jaccard similarity ≥ 0.50
  ├── Tier 5: phone?             ──→ MATCH if last 10 digits match
  ├── Tier 6: name+address?      ──→ MATCH if exact name + partial address match
  └── null                       ──→ INSERT NEW SPACE
```

- **On INSERT**: Generates a canonical `opgId` (`OPG-KEYWORD-XXXX`), creates the space, inserts reviews, records photos, and logs creation.
- **On UPDATE**: Diffs tracked fields (`name`, `address`, `contact.*`), writes mutations to `spaceChangeLogs`, deduplicates and merges reviews in `space_reviews`, updates media, and overwrites volatile attributes (`rating`, `openingHours`, `priceLevel`, etc.).

---

## Changelog

| Date | Author | Description |
|------|--------|-------------|
| 2026-09-15 | Antigravity | **Crawling Pipeline Audit & Core Fixes (Phase 1–5)**:<br>• **Gap 1**: Upgraded UA pool to 2026-era Chrome 135+, Firefox 138+, Edge 136+, Safari 18.x.<br>• **Gap 3**: Wrapped `urlIndex` in shared state with explicit atomic claim.<br>• **Gap 4**: Fixed `preFilterUrls` error fallback shape `{ fresh, skippedUrls }`.<br>• **Gap 5**: Added resilient selector fallback chains (`tryText`, `tryAttr`, `tryAll`) for Google Maps DOM changes.<br>• **Gap 6**: Added `extractExistingAmenities` normalizer in `enrichmentProcessor.js` to preserve boolean tags and raw arrays.<br>• **Gap 7**: Added 30s TTL cache for `SystemState.getGlobalState()` in `sleep()`.<br>• **Gap 8**: Added circuit breaker to `AdaptiveThrottle` tripping on 7+ consecutive failures/blocks.<br>• **Gap 9**: Isolated `websiteScraper.js` to dedicated page contexts.<br>• **Gap 10**: Added page recycle budget (every 35 URLs) in parallel batch pool.<br>• **Gap 11**: Extracted shared worker utilities into `src/queue/workerUtils.js`.<br>• **Gap 12**: Documented dual enrichment architecture in `enrichmentWorker.js`.<br>• **Gap 13**: Removed 150-review hard-cap in `spaceProcessor.js`.<br>• **Gap 14**: Preserved `/@lat,lng` coordinate anchors in Google Maps URL normalizer.<br>• **Gap 15**: Fixed batch completion criteria in `worker.js`.<br>• **Gap 17**: Deferred `removeJobAndBatches()` out of BullMQ lock-holding path.<br>• **Gap 16**: Modernized `ARCHITECTURE.md`. |
| 2026-05-09 | Antigravity | Migration scheduler refactor, opgId rollout, enrichment session Tasks 1–7. |
| 2026-04-18 | Antigravity | Initial architecture document created. |
