import { cn } from "@/lib/utils";
import { cva } from "class-variance-authority";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-xs font-medium border transition-colors",
  {
    variants: {
      variant: {
        default: "bg-surface-2 text-subtle border-border-subtle",
        running: "bg-active/10 text-active border-active/20",
        queued: "bg-muted/10 text-muted border-muted/20",
        failed: "bg-accent/10 text-accent border-accent/20",
        primary: "bg-primary/10 text-primary border-primary/20",
      },
    },
    defaultVariants: { variant: "default" },
  }
);

export function Badge({ className, variant, children, ...props }) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props}>
      {children}
    </span>
  );
}

export function StatusBadge({ status, children }) {
  const variantMap = {
    running: "running",
    active: "running",
    completed: "running",
    healthy: "running",
    live: "running",
    queued: "queued",
    idle: "queued",
    waiting: "queued",
    pending: "queued",
    failed: "failed",
    blocked: "failed",
    error: "failed",
    quarantined: "failed",
    cancelled: "failed",
  };
  const variant = variantMap[status] || "default";
  return <Badge variant={variant}>{children || status}</Badge>;
}
