import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { X } from "lucide-react";

export function Dialog({ open, onClose, children, className }) {
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);

  useEffect(() => {
    if (open) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => { document.body.style.overflow = ""; };
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="fixed inset-0 bg-black/60" onClick={onClose} />
      <div
        ref={ref}
        className={cn(
          "relative z-50 w-full max-w-lg rounded-md border border-border bg-surface-1 p-6 shadow-lg",
          className
        )}
      >
        <button
          onClick={onClose}
          className="absolute right-3 top-3 text-muted hover:text-white cursor-pointer"
        >
          <X size={16} />
        </button>
        {children}
      </div>
    </div>
  );
}

export function DialogTitle({ children, className }) {
  return <h2 className={cn("text-base font-semibold text-white mb-4", className)}>{children}</h2>;
}
