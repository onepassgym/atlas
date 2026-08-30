/**
 * API Client — fetch wrapper with auth + base URL
 */

let currentEnv = 'local';

const ENV_CONFIG = {
  local: '',          // same-origin in dev (Vite proxy), same-origin in prod
  prod: '',           // set dynamically
};

export function setEnv(env, prodUrl = '') {
  currentEnv = env;
  if (prodUrl) ENV_CONFIG.prod = prodUrl;
}

export function getEnv() { return currentEnv; }

export function getBaseUrl() {
  return ENV_CONFIG[currentEnv] || '';
}

export function getProxyUrl(url) {
  if (!url || typeof url !== 'string') return null;
  if (url.startsWith('/api/')) return `${getBaseUrl()}${url}`;
  return `${getBaseUrl()}/api/media/proxy?url=${encodeURIComponent(url)}`;
}

export async function apiFetch(path, options = {}) {
  const base = getBaseUrl();
  const url = `${base}${path}`;

  const headers = {
    ...options.headers,
  };

  if (options.body && typeof options.body === 'object' && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.body);
  }

  const res = await fetch(url, { ...options, headers });
  
  if (!res.ok && res.status === 401) {
    throw new Error('Unauthorized — check API key');
  }

  // Handle non-JSON responses (e.g., log tails)
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('text/plain')) {
    return { success: true, text: await res.text() };
  }

  return res.json();
}

// Shorthand helpers
export const api = {
  get:    (path) => apiFetch(path),
  post:   (path, body) => apiFetch(path, { method: 'POST', body }),
  put:    (path, body) => apiFetch(path, { method: 'PUT', body }),
  patch:  (path, body) => apiFetch(path, { method: 'PATCH', body }),
  delete: (path) => apiFetch(path, { method: 'DELETE' }),
};
