import { create } from "zustand";

function getHashPath() {
  const hash = window.location.hash.slice(1) || "/";
  return hash;
}

export const useRouter = create((set) => ({
  path: getHashPath(),
  params: {},

  navigate: (path, params = {}) => {
    window.location.hash = path;
    set({ path, params });
  },
}));

// Listen to hash changes
window.addEventListener("hashchange", () => {
  const path = getHashPath();
  useRouter.setState({ path });
});

export function matchRoute(path, pattern) {
  if (pattern === path) return {};
  const patternParts = pattern.split("/");
  const pathParts = path.split("/");
  if (patternParts.length !== pathParts.length) return null;
  const params = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(":")) {
      params[patternParts[i].slice(1)] = pathParts[i];
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}
