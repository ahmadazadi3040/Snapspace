'use client';
import { useEffect, useState } from 'react';
import { Download, Share } from 'lucide-react';

interface BIPEvent extends Event { prompt: () => Promise<void>; userChoice?: Promise<unknown> }

export function InstallButton() {
  const [evt, setEvt] = useState<BIPEvent | null>(null);
  const [ios, setIos] = useState(false);
  const [hint, setHint] = useState(false);

  useEffect(() => {
    const standalone = window.matchMedia?.('(display-mode: standalone)')?.matches;
    if (standalone) return;
    const ua = navigator?.userAgent ?? '';
    setIos(/iphone|ipad|ipod/i.test(ua) && !/crios|fxios/i.test(ua));
    const h = (e: Event) => { e.preventDefault(); setEvt(e as BIPEvent); };
    window.addEventListener('beforeinstallprompt', h);
    return () => window.removeEventListener('beforeinstallprompt', h);
  }, []);

  if (evt) {
    return (
      <button
        onClick={async () => { try { await evt?.prompt?.(); } catch (e) { console.error(e); } setEvt(null); }}
        className="inline-flex items-center gap-1.5 rounded-md bg-secondary px-3 py-1.5 text-xs font-medium text-secondary-foreground shadow-sm transition hover:bg-secondary/70"
      >
        <Download className="h-3.5 w-3.5" /> Install
      </button>
    );
  }
  if (ios) {
    return (
      <div className="relative">
        <button
          onClick={() => setHint((v: boolean) => !v)}
          className="inline-flex items-center gap-1.5 rounded-md bg-secondary px-3 py-1.5 text-xs font-medium text-secondary-foreground shadow-sm transition hover:bg-secondary/70"
        >
          <Share className="h-3.5 w-3.5" /> Install
        </button>
        {hint && (
          <p className="absolute right-0 top-9 z-50 w-56 rounded-md bg-popover p-2 text-xs text-popover-foreground shadow-lg">
            Tap Share → “Add to Home Screen” to install Snapspace.
          </p>
        )}
      </div>
    );
  }
  return null;
}
