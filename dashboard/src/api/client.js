const ENV_CONFIG = {
  local: "",
  release: "",
};

let currentEnv = "local";
let apiKey = "";

// Read persisted key immediately on module load
const LS_KEYS = ['atlas_api_key', 'api_key', 'apiKey', 'x-api-key'];
for (const k of LS_KEYS) {
  const v = typeof localStorage !== 'undefined' ? localStorage.getItem(k) : null;
  if (v) { apiKey = v; break; }
}

export function setEnv(env, url = "") {
  currentEnv = env;
  if (url) ENV_CONFIG[env] = url;
}

export function getEnv() {
  return currentEnv;
}

export function setApiKey(key) {
  apiKey = key;
  // Persist so the key survives page reloads
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('atlas_api_key', key);
  }
}

export function getApiKey() {
  return apiKey;
}

export function getBaseUrl() {
  return ENV_CONFIG[currentEnv] || "";
}

export async function apiFetch(path, options = {}) {
  const base = getBaseUrl();
  const url = `${base}${path}`;
  const headers = { ...options.headers };

  // Re-resolve from localStorage each call in case it was set after module load
  const resolvedKey = apiKey || localStorage.getItem('atlas_api_key') || '';
  if (resolvedKey) headers["X-API-Key"] = resolvedKey;

  if (options.body && typeof options.body === "object" && !(options.body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(options.body);
  }

  const res = await fetch(url, { ...options, headers });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`${res.status}: ${text}`);
  }

  const ct = res.headers.get("content-type") || "";
  if (ct.includes("text/plain")) return { success: true, text: await res.text() };
  return res.json();
}

export const api = {
  get: (path) => apiFetch(path),
  post: (path, body) => apiFetch(path, { method: "POST", body }),
  patch: (path, body) => apiFetch(path, { method: "PATCH", body }),
  delete: (path) => apiFetch(path, { method: "DELETE" }),
};
