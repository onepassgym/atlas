import { cn } from "@/lib/utils";

export function Sheet({ open, onClose, children, className, side = "right" }) {
  if (!open) return null;

  const sideClasses = {
    right: "right-0 top-0 h-full w-[420px] max-w-[90vw] animate-in slide-in-from-right",
    left: "left-0 top-0 h-full w-[420px] max-w-[90vw] animate-in slide-in-from-left",
  };

  return (
    <div className="fixed inset-0 z-50">
      <div className="fixed inset-0 bg-black/40" onClick={onClose} />
      <div
        className={cn(
          "fixed border-l border-border bg-surface-1 p-4 overflow-y-auto shadow-lg",
          sideClasses[side],
          className
        )}
      >
        {children}
      </div>
    </div>
  );
}
