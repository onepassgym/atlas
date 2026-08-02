import { useRouter } from "@/stores/router";
import { useAppStore } from "@/stores/appStore";
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
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";

const NAV_ITEMS = [
  { path: "/", icon: LayoutDashboard, label: "Overview" },
  { path: "/spaces", icon: Building2, label: "Spaces" },
  { path: "/globe", icon: Globe, label: "Globe" },
  { path: "/crawls", icon: Waypoints, label: "Crawls" },
  { path: "/enrichment", icon: Sparkles, label: "Enrichment" },
  { path: "/health", icon: HeartPulse, label: "Health" },
  { path: "/schedule", icon: Calendar, label: "Schedule" },
  { path: "/logs", icon: ScrollText, label: "Logs" },
];

export default function Sidebar({ collapsed }) {
  const path = useRouter((s) => s.path);
  const navigate = useRouter((s) => s.navigate);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);

  const isActive = (itemPath) => {
    if (itemPath === "/") return path === "/" || path === "/overview";
    return path.startsWith(itemPath);
  };

  return (
    <aside
      className={cn(
        "flex flex-col border-r border-border-subtle bg-surface-1 transition-all duration-200",
        collapsed ? "w-12" : "w-48"
      )}
    >
      {/* Logo */}
      <div className="flex h-12 items-center gap-2 px-3 border-b border-border-subtle">
        {!collapsed && (
          <span className="text-sm font-semibold text-white tracking-tight">Atlas</span>
        )}
      </div>

      {/* Nav items */}
      <nav className="flex-1 py-2 space-y-0.5 px-1.5">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const active = isActive(item.path);
          return (
            <button
              key={item.path}
              onClick={() => navigate(item.path)}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors cursor-pointer",
                active
                  ? "bg-primary/10 text-primary"
                  : "text-muted hover:text-white hover:bg-surface-2"
              )}
              title={collapsed ? item.label : undefined}
            >
              <Icon size={16} strokeWidth={1.75} />
              {!collapsed && <span>{item.label}</span>}
            </button>
          );
        })}
      </nav>

      {/* Collapse toggle */}
      <div className="border-t border-border-subtle p-1.5">
        <button
          onClick={toggleSidebar}
          className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-muted hover:text-white hover:bg-surface-2 cursor-pointer"
        >
          {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          {!collapsed && <span className="text-xs">Collapse</span>}
        </button>
      </div>
    </aside>
  );
}
