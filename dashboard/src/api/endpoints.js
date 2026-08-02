import { api } from "./client";

// Spaces (v5 uses /api/spaces, fallback to /api/gyms for compat)
export const spacesApi = {
  list: (params) => api.get(`/api/spaces?${new URLSearchParams(params)}`),
  detail: (opgId) => api.get(`/api/spaces/${opgId}`),
  stats: () => api.get(`/api/spaces/stats`),
  patch: (opgId, data) => api.patch(`/api/spaces/${opgId}`, data),
  nearby: (params) => api.get(`/api/spaces/nearby?${new URLSearchParams(params)}`),
};

// Crawls
export const crawlsApi = {
  jobs: (params) => api.get(`/api/crawl/jobs?${new URLSearchParams(params)}`),
  status: (jobId) => api.get(`/api/crawl/status/${jobId}`),
  queueStats: () => api.get(`/api/crawl/queue/stats`),
  coverage: () => api.get(`/api/crawl/coverage`),
  categories: () => api.get(`/api/crawl/categories`),
  queueCity: (data) => api.post("/api/crawl/city", data),
  queueBatch: (data) => api.post("/api/crawl/batch", data),
  cancel: (jobId) => api.post(`/api/crawl/cancel/${jobId}`),
  retryFailed: () => api.post("/api/crawl/retry/failed"),
  retryIncomplete: () => api.post("/api/crawl/retry/incomplete"),
  startNow: (jobId) => api.post(`/api/crawl/start-now/${jobId}`),
  deleteJob: (jobId) => api.delete(`/api/crawl/jobs/${jobId}`),
};

// Enrichment
export const enrichmentApi = {
  stats: () => api.get("/api/enrichment/stats"),
  queue: (params) => api.get(`/api/enrichment/queue?${new URLSearchParams(params)}`),
  trigger: () => api.post("/api/system/schedule/trigger/enrichment"),
};

// Media
export const mediaApi = {
  downloadPhoto: (spaceOpgId, photoOpgId) =>
    api.post(`/api/spaces/${spaceOpgId}/photos/${photoOpgId}/download`),
  downloadAll: (spaceOpgId) =>
    api.post(`/api/spaces/${spaceOpgId}/photos/download-all`),
};

// System
export const systemApi = {
  logs: (params) => api.get(`/api/system/logs?${new URLSearchParams(params)}`),
  logsLatest: () => api.get("/api/system/logs/latest"),
  schedule: () => api.get("/api/system/schedule"),
  updateSchedule: (data) => api.post("/api/system/schedule", data),
  addCity: (data) => api.post("/api/system/schedule/city", data),
  removeCity: (data) => api.delete(`/api/system/schedule/city?${new URLSearchParams(data)}`),
  triggerFrequency: (data) => api.post("/api/system/schedule/trigger", data),
  triggerStale: () => api.post("/api/system/schedule/trigger/stale"),
  triggerEnrichment: () => api.post("/api/system/schedule/trigger/enrichment"),
};

// Events (SSE)
export const eventsApi = {
  history: (params) => api.get(`/api/events/history?${new URLSearchParams(params)}`),
  stats: () => api.get("/api/events/stats"),
};

// Health
export const healthApi = {
  check: () => api.get("/health"),
};

// Data Health
export const dataHealthApi = {
  recommendations: () => api.get("/api/data-health/recommendations"),
};
