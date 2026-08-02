import { useEffect, useRef, useState } from "react";
import { useRouter } from "@/stores/router";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard,
  Building2,
  Globe,
  Waypoints,
  Sparkles,
  HeartPulse,
  Calendar,
  ScrollText,
  Search,
  RefreshCw,
  RotateCcw,
} from "lucide-react";

const COMMANDS = [
  { id: "overview", label: "Go to Overview", icon: LayoutDashboard, action: "/" },
  { id: "spaces", label: "Go to Spaces", icon: Building2, action: "/spaces" },
  { id: "globe", label: "Go to Globe", icon: Globe, action: "/globe" },
  { id: "crawls", label: "Go to Crawls", icon: Waypoints, action: "/crawls" },
  { id: "enrichment", label: "Go to Enrichment", icon: Sparkles, action: "/enrichment" },
  { id: "health", label: "Go to Health", icon: HeartPulse, action: "/health" },
  { id: "schedule", label: "Go to Schedule", icon: Calendar, action: "/schedule" },
  { id: "logs", label: "Go to Logs", icon: ScrollText, action: "/logs" },
  { id: "new-crawl", label: "New Crawl", icon: RefreshCw, action: "/crawls", keywords: "queue city" },
  { id: "retry-failed", label: "Retry Failed Jobs", icon: RotateCcw, action: "/crawls", keywords: "retry" },
];

export default function CommandPalette({ open, onClose }) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef(null);
  const navigate = useRouter((s) => s.navigate);

  useEffect(() => {
    if (open) {
      setQuery("");
      setSelected(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  const filtered = COMMANDS.filter((cmd) => {
    const q = query.toLowerCase();
    return (
      cmd.label.toLowerCase().includes(q) ||
      cmd.id.includes(q) ||
      (cmd.keywords && cmd.keywords.includes(q))
    );
  });

  const handleKeyDown = (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (filtered[selected]) {
        navigate(filtered[selected].action);
        onClose();
      }
    } else if (e.key === "Escape") {
      onClose();
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center pt-[15vh]">
      <div className="fixed inset-0 bg-black/60" onClick={onClose} />
      <div className="relative z-[101] w-full max-w-md rounded-lg border border-border bg-surface-1 shadow-2xl overflow-hidden">
        {/* Input */}
        <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2.5">
          <Search size={15} className="text-muted" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setSelected(0); }}
            onKeyDown={handleKeyDown}
            placeholder="Type a command or search..."
            className="flex-1 bg-transparent text-sm text-white placeholder:text-muted outline-none"
          />
        </div>

        {/* Results */}
        <div className="max-h-64 overflow-y-auto py-1">
          {filtered.length === 0 && (
            <p className="px-3 py-4 text-center text-xs text-muted">No results found.</p>
          )}
          {filtered.map((cmd, i) => {
            const Icon = cmd.icon;
            return (
              <button
                key={cmd.id}
                onClick={() => { navigate(cmd.action); onClose(); }}
                className={cn(
                  "flex w-full items-center gap-2.5 px-3 py-2 text-sm text-subtle hover:bg-surface-2 cursor-pointer",
                  i === selected && "bg-surface-2 text-white"
                )}
              >
                <Icon size={15} strokeWidth={1.75} className="text-muted" />
                <span>{cmd.label}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
