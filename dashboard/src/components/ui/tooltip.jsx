import { cn } from "@/lib/utils";

export function Tooltip({ children, content, className }) {
  return (
    <span className={cn("group relative inline-flex", className)}>
      {children}
      <span className="pointer-events-none absolute bottom-full left-1/2 z-50 -translate-x-1/2 mb-1.5 rounded-sm bg-ink px-2 py-1 text-xs text-white opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap border border-border">
        {content}
      </span>
    </span>
  );
}
