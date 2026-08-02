import { create } from "zustand";
import { getEnv, setEnv, setApiKey } from "@/api/client";

export const useAppStore = create((set, get) => ({
  env: getEnv(),
  sidebarCollapsed: false,
  commandOpen: false,

  setEnvironment: (env, url) => {
    setEnv(env, url);
    set({ env });
  },

  setApiKey: (key) => {
    setApiKey(key);
  },

  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setCommandOpen: (open) => set({ commandOpen: open }),
}));
