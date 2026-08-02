import { useAppStore } from "@/stores/appStore";
import { useRouter } from "@/stores/router";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Search, Plus, Command } from "lucide-react";
import { useQueueStats } from "@/hooks/useQueueStats";

export default function TopBar() {
  const env = useAppStore((s) => s.env);
  const setCommandOpen = useAppStore((s) => s.setCommandOpen);
  const navigate = useRouter((s) => s.navigate);
  const { data: stats } = useQueueStats();

  const envColor = env === "local" ? "text-active" : "text-accent";
  const envLabel = env === "local" ? "LOCAL" : "RELEASE";

  return (
    <header className="flex h-12 items-center gap-3 border-b border-border-subtle bg-surface-1 px-4">
      {/* Environment indicator */}
      <span className={`text-xs font-bold uppercase tracking-wider ${envColor}`}>
        {envLabel}
      </span>

      {/* Search trigger */}
      <button
        onClick={() => setCommandOpen(true)}
        className="flex items-center gap-2 rounded-md border border-border-subtle bg-surface-0 px-3 py-1.5 text-xs text-muted hover:border-border hover:text-subtle transition-colors cursor-pointer flex-1 max-w-xs"
      >
        <Search size={13} />
        <span>Search spaces, commands...</span>
        <kbd className="ml-auto flex items-center gap-0.5 rounded border border-border-subtle px-1 py-0.5 text-[10px] text-muted">
          <Command size={10} />K
        </kbd>
      </button>

      {/* Queue health pill */}
      {stats && (
        <div className="flex items-center gap-2 text-xs tabular-nums">
          <span className="flex items-center gap-1">
            <span className="h-1.5 w-1.5 rounded-full bg-active animate-pulse" />
            <span className="text-muted">Crawl</span>
            <span className="text-white">{stats.crawl?.active || 0}</span>
            <span className="text-muted">/</span>
            <span className="text-subtle">{stats.crawl?.waiting || 0}</span>
          </span>
          <span className="text-border">|</span>
          <span className="flex items-center gap-1">
            <span className="text-muted">Enrich</span>
            <span className="text-white">{stats.enrichment?.active || 0}</span>
            <span className="text-muted">/</span>
            <span className="text-subtle">{stats.enrichment?.waiting || 0}</span>
          </span>
        </div>
      )}

      {/* Primary action */}
      <Button size="sm" onClick={() => navigate("/crawls")} className="ml-auto">
        <Plus size={14} />
        New Crawl
      </Button>
    </header>
  );
}
