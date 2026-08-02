const ENV_CONFIG = {
  local: "",
  release: "",
};

let currentEnv = "local";
let apiKey = "";

export function setEnv(env, url = "") {
  currentEnv = env;
  if (url) ENV_CONFIG[env] = url;
}

export function getEnv() {
  return currentEnv;
}

export function setApiKey(key) {
  apiKey = key;
}

export function getBaseUrl() {
  return ENV_CONFIG[currentEnv] || "";
}

export async function apiFetch(path, options = {}) {
  const base = getBaseUrl();
  const url = `${base}${path}`;
  const headers = { ...options.headers };

  if (apiKey) headers["X-API-Key"] = apiKey;

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
