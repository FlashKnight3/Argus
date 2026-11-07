import { AlertOctagon, X } from 'lucide-react';
import { useEffect } from 'react';

export function Toast({ message, onClose }: { message: string; onClose: () => void }) {
  useEffect(() => {
    const id = setTimeout(onClose, 6000);
    return () => clearTimeout(id);
  }, [message, onClose]);
  return (
    <div role="alert" className="animate-fade-in fixed bottom-5 left-1/2 z-50 flex max-w-lg -translate-x-1/2 items-start gap-2.5 rounded-xl border border-red/40 bg-ink-850 px-4 py-3 text-[13px] text-fg shadow-2xl">
      <AlertOctagon className="mt-0.5 h-4 w-4 shrink-0 text-red" />
      <span className="flex-1">{message}</span>
      <button type="button" onClick={onClose} className="text-fg-subtle hover:text-fg" aria-label="Dismiss">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
