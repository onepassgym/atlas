import { useRouter, matchRoute } from "@/stores/router";
import { useAppStore } from "@/stores/appStore";
import Sidebar from "./Sidebar";
import TopBar from "./TopBar";
import CommandPalette from "./CommandPalette";
import { lazy, Suspense, useEffect } from "react";
import { TableSkeleton } from "@/components/ui/skeleton";

const Overview = lazy(() => import("@/pages/Overview"));
const SpacesList = lazy(() => import("@/pages/SpacesList"));
const SpaceDetail = lazy(() => import("@/pages/SpaceDetail"));
const Globe = lazy(() => import("@/pages/Globe"));
const Crawls = lazy(() => import("@/pages/Crawls"));
const Enrichment = lazy(() => import("@/pages/Enrichment"));
const Health = lazy(() => import("@/pages/Health"));
const Schedule = lazy(() => import("@/pages/Schedule"));
const Logs = lazy(() => import("@/pages/Logs"));

function PageFallback() {
  return (
    <div className="p-4">
      <TableSkeleton rows={10} cols={5} />
    </div>
  );
}

function Router() {
  const path = useRouter((s) => s.path);

  // Space detail match
  const spaceMatch = matchRoute(path, "/spaces/:opgId");

  if (path === "/" || path === "/overview") return <Overview />;
  if (path === "/spaces") return <SpacesList />;
  if (spaceMatch) return <SpaceDetail opgId={spaceMatch.opgId} />;
  if (path === "/globe") return <Globe />;
  if (path === "/crawls") return <Crawls />;
  if (path === "/enrichment") return <Enrichment />;
  if (path === "/health") return <Health />;
  if (path === "/schedule") return <Schedule />;
  if (path === "/logs") return <Logs />;

  // Default fallback
  return <Overview />;
}

export default function AppShell() {
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const commandOpen = useAppStore((s) => s.commandOpen);
  const setCommandOpen = useAppStore((s) => s.setCommandOpen);

  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setCommandOpen(!commandOpen);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [commandOpen, setCommandOpen]);

  return (
    <div className="flex h-screen overflow-hidden bg-surface-0">
      <Sidebar collapsed={sidebarCollapsed} />
      <div className="flex flex-1 flex-col overflow-hidden">
        <TopBar />
        <main className="flex-1 overflow-y-auto">
          <Suspense fallback={<PageFallback />}>
            <Router />
          </Suspense>
        </main>
      </div>
      <CommandPalette open={commandOpen} onClose={() => setCommandOpen(false)} />
    </div>
  );
}
