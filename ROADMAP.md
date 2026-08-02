# 🗺️ atlas — Feature Upgrade Roadmap

> **Living document.** Updated as features are completed or priorities change.  
> Last review: **2026-04-18**

---

## Status Legend

| Icon | Status |
|------|--------|
| ⬜ | Not started |
| 🟡 | In progress |
| ✅ | Completed |
| ❌ | Cancelled / Deprioritized |

---

## Phase 1 — Hardening & Observability (Priority: 🔴 Critical)

These are foundational improvements that de-risk the existing system before adding new features.

### ⬜ 1.1 API Key Authentication

**Problem:** All endpoints including destructive ones (`queue/clear`, `delete jobs`) are completely open.

**Scope:**
- Add `X-API-Key` header middleware
- Generate API keys via environment variable (start simple)
- Protect all `/api/*` routes
- Leave `GET /health` and `GET /` public

**Effort:** ~1 hour | **Impact:** High

---

### ✅ 1.2 Webhook Notifications (Completed: 2026-04-18)

**Problem:** Multi-hour city crawls run silently. No way to know when a crawl finishes or fails unless you poll the API.

**Scope:**
- Event bus (Node.js EventEmitter) for internal pub/sub
- Emit events: `job:started`, `job:progress`, `job:completed`, `job:failed`, `job:cancelled`
- Webhook registration API (`POST /api/webhooks`)
- POST event payloads to registered URLs with retry
- Config stored in `config/webhooks.json`

**Integrations:** Slack, Discord, custom HTTP endpoints

**Effort:** ~2 hours | **Impact:** High

---

### ✅ 1.3 Real-Time SSE Events + Live Dashboard (Completed: 2026-04-18)

**Problem:** No visual monitoring of crawl progress. Terminal logs are the only feedback.

**Scope:**
- `GET /api/events` — Server-Sent Events stream
- Ring buffer of last 100 events
- Single-file HTML dashboard (`/dashboard`)
  - Active job progress bars
  - Live event feed
  - Queue stats panel
  - Quick action buttons (trigger crawl, cancel, clear)
- Dark theme, modern design

**Effort:** ~3 hours | **Impact:** High

---

### ✅ 1.4 Fix Known Technical Debt (Completed: 2026-04-18)

**Problem:** Multiple small issues accumulating (see `ARCHITECTURE.md` TD-01 through TD-08).

**Scope:**
- Remove VPS credentials from `.env`
- Fix `atlas`/`atlas` DB name mismatch
- Delete stray `{src` directory
- Clean up deprecated `mergeGymData()` in `dedup.js`
- Fix `ensureIndexes.js` collection name mismatch
- Skip unnecessary MongoDB writes when nothing changed in `upsertGym.js`

**Effort:** ~1 hour | **Impact:** Medium (prevents future confusion)

---

## Phase 2 — Data Intelligence (Priority: 🟡 High)

Leverage the crawled data to provide insights beyond raw storage.

### ⬜ 2.1 Gym Quality Score Engine

**Problem:** Raw data exists but there's no computed fitness venue "quality" metric for ranking.

**Scope:**
- Composite score algorithm: `f(rating, totalReviews, completeness, recency, photoCount, hasWebsite, hasPhone)`
- Store as `qualityScore` (0-100) on Gym document
- Recalculate on every upsert
- API: `GET /api/gyms?sortBy=qualityScore`
- Expose breakdown in gym detail response

**Effort:** ~2 hours | **Impact:** High (enables smart sorting for OnePassGym app)

---

### ⬜ 2.2 Review Sentiment Analysis

**Problem:** Reviews are stored as raw text. No structured sentiment data.

**Scope:**
- Lightweight keyword-based sentiment scoring (no external API needed)
- Positive/negative/neutral classification per review
- Aggregate `sentimentScore` per gym (-1.0 to +1.0)
- Extract key topics: "cleanliness", "equipment", "trainers", "parking", "price"
- Store as `sentimentBreakdown` on Gym document

**Effort:** ~3 hours | **Impact:** Medium (valuable for consumer app, gym comparisons)

---

### ⬜ 2.3 Competitor Analysis Engine

**Problem:** No way to compare gyms in the same area or track competitive dynamics.

**Scope:**
- For each gym, auto-find competitors within 2km radius
- Calculate: price comparison, rating gap, review velocity, amenity overlap
- API: `GET /api/gyms/:id/competitors`
- Store competitor links and comparison metrics
- Weekly auto-refresh as part of scheduler

**Effort:** ~4 hours | **Impact:** High (unique value-add for gym owners as OnePassGym partners)

---

### ⬜ 2.4 Trending & Activity Detection

**Problem:** No visibility into which gyms are gaining or losing popularity over time.

**Scope:**
- Track `totalReviews` delta per crawl cycle
- Calculate `reviewVelocity` (reviews/week)
- Detect: "trending up", "trending down", "new listing", "closing risk"
- API: `GET /api/gyms/trending`
- Webhook/notification when a gym shows notable activity change

**Effort:** ~3 hours | **Impact:** Medium (market intelligence)

---

## Phase 3 — Platform Expansion (Priority: 🟢 Medium)

Expand the scraping capability and data sources beyond Google Maps.

### ⬜ 3.1 Multi-Source Enrichment (Justdial / Sulekha)

**Problem:** Google Maps is the only data source. Some gyms have richer data on other platforms.

**Scope:**
- Add `justdialScraper.js` — scrape Justdial fitness listings
- Cross-reference with existing gym records (phone + name matching)
- Fill missing fields: pricing, timing, membership plans
- New enrichment scheduler job

**Effort:** ~6 hours | **Impact:** High (significantly richer gym profiles)

---

### ⬜ 3.2 Instagram Social Proof Scraper

**Problem:** Social media presence (follower count, posting frequency) is a strong gym quality signal not captured.

**Scope:**
- Extract Instagram handle from gym website (if available)
- Scrape: follower count, post count, latest post date
- Store as `socialProof` sub-document on Gym
- Update monthly via scheduler

**Effort:** ~4 hours | **Impact:** Medium

---

### ⬜ 3.3 Pricing & Membership Data Extraction

**Problem:** `priceLevel` from Google Maps is vague ("₹₹"). No actual membership pricing.

**Scope:**
- Scrape gym websites for pricing pages (if `contact.website` exists)
- Extract: monthly/quarterly/annual membership prices
- Store as `pricing` sub-document with structured fields
- Flag gyms with known pricing for OnePassGym app prioritization

**Effort:** ~5 hours | **Impact:** High (direct value for gym comparison app)

---

### ⬜ 3.4 Proxy Rotation & IP Pool

**Problem:** Single IP will eventually get rate-limited by Google Maps during heavy crawl cycles.

**Scope:**
- Integrate residential proxy provider (SmartProxy / BrightData)
- Rotate IP per browser session
- Fallback to direct connection if proxy fails
- Track proxy success/failure rates

**Effort:** ~3 hours | **Impact:** High (production survivability)

---

## Phase 4 — API Consumers & Ecosystem (Priority: 🔵 Future)

Build on top of the data platform for end-user products.

### ⬜ 4.1 Public Gym Search API (v2)

**Problem:** Current API is internal. No versioned, documented public API for the OnePassGym consumer app.

**Scope:**
- `v2` API prefix with breaking-change protection
- Standardized pagination (cursor-based for mobile)
- Field selection via `?fields=name,rating,contact`
- Compressed responses (already have `compression` middleware)
- API key tiers: free (100 req/day), premium (unlimited)

**Effort:** ~4 hours | **Impact:** High (enables mobile app development)

---

### ⬜ 4.2 Gym Owner Portal API

**Problem:** `atlas.isPartner` fields exist in the schema but no partner-facing features.

**Scope:**
- Partner registration flow
- Gym claim/verify endpoint
- Partner dashboard endpoints: analytics, review alerts, competitor insights
- Ability to update: description, photos, pricing, amenities
- Webhook to notify partners of new reviews

**Effort:** ~8 hours | **Impact:** High (monetization path)

---

### ⬜ 4.3 Data Export & Reporting

**Problem:** `GET /api/gyms/export` is crude JSON stream. No structured reports.

**Scope:**
- CSV export with column selection
- PDF report generation per city (gym count, avg rating, category breakdown)
- Scheduled email reports (weekly summary)
- Filterable date range exports

**Effort:** ~4 hours | **Impact:** Medium

---

### ⬜ 4.4 Map-Based Visual Explorer

**Problem:** No visual way to explore the scraped gym data geographically.

**Scope:**
- Lightweight Leaflet/Mapbox web page
- Cluster markers by density
- Click marker → gym card with photo, rating, contact
- Filter by category, rating, amenities
- Heatmap overlay for gym density

**Effort:** ~5 hours | **Impact:** Medium (great for demos and internal use)

---

## Phase 5 — AI & Intelligence (Priority: 🟣 Aspirational)

### ⬜ 5.1 AI-Powered Gym Descriptions

**Scope:** Generate marketing-quality descriptions for gyms with incomplete data using the existing review text + amenity data as context.

### ⬜ 5.2 Anomaly Detection

**Scope:** Auto-detect: suspicious review patterns (fake reviews), sudden rating drops, unusually high photo deletion rates.

### ⬜ 5.3 Gym Recommendation Engine

**Scope:** Given a user's location + preferences, recommend top gyms using quality score + sentiment + proximity + pricing.

---

## Completed Features (Archive)

| Feature | Date | Phase |
|---------|------|-------|
| Core Google Maps scraper | 2026-04-01 | Foundation |
| BullMQ queue + worker | 2026-04-05 | Foundation |
| 6-tier deduplication | 2026-04-08 | Foundation |
| Multi-tier scheduling | 2026-04-10 | Foundation |
| Swagger API docs | 2026-04-12 | Hardening |
| Graceful cancellation | 2026-04-12 | Hardening |
| Docker Compose deployment | 2026-04-13 | Ops |
| VPS deployment to Hostinger | 2026-04-13 | Ops |
| Normalized data model (categories, amenities, place types) | 2026-04-14 | Data |
| Change log tracking | 2026-04-14 | Data |
| Staleness-aware re-crawling | 2026-04-14 | Intelligence |
| Enrichment (completeness-based re-crawl) | 2026-04-14 | Intelligence |
| Webhook Event Bus (job/gym events) | 2026-04-18 | Hardening |
| Real-time Dashboard (SSE Mission Control) | 2026-04-18 | Hardening |
| Tech Debt Cleanup (stray files, DB naming) | 2026-04-18 | Hardening |

---

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-04-18 | Prioritize webhook/dashboard over proxy rotation | Observability is more impactful than scale right now |
| 2026-04-14 | Separate reviews/photos into own collections | Gym documents were too large; enables independent scaling |
| 2026-04-12 | Redis-based cancellation over BullMQ built-in | BullMQ `moveToFailed()` doesn't allow graceful mid-job stops |
| 2026-04-08 | 6-tier dedup in upsertGym.js over standalone dedup module | Reduces double-lookup overhead; single transactional flow |

---

> **How to use this document:**
> 1. Before starting any upgrade, check this roadmap for existing plans
> 2. Move items to 🟡 when starting, ✅ when done
> 3. Add new ideas to the appropriate phase
> 4. Update the Decision Log for any non-obvious choices
> 5. Archive completed features at the bottom
