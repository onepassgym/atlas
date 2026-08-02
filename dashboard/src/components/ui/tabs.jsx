import { cn } from "@/lib/utils";

export function Tabs({ className, children, ...props }) {
  return (
    <div className={cn("flex flex-col", className)} {...props}>
      {children}
    </div>
  );
}

export function TabsList({ className, children, ...props }) {
  return (
    <div
      className={cn(
        "inline-flex items-center gap-0 border-b border-border-subtle",
        className
      )}
      role="tablist"
      {...props}
    >
      {children}
    </div>
  );
}

export function TabsTrigger({ className, active, children, ...props }) {
  return (
    <button
      role="tab"
      aria-selected={active}
      className={cn(
        "px-3 py-2 text-sm font-medium text-muted transition-colors border-b-2 border-transparent hover:text-white cursor-pointer",
        active && "text-white border-primary",
        className
      )}
      {...props}
    >
      {children}
    </button>
  );
}

export function TabsContent({ className, active, children, ...props }) {
  if (!active) return null;
  return (
    <div className={cn("pt-4", className)} role="tabpanel" {...props}>
      {children}
    </div>
  );
}
