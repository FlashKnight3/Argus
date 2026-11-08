import { useMemo, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { suggest, type Suggestion } from './search';
import { siteName } from './ui';
import type { SupplyState } from './useSupply';

/** Search box with typed matches and, when empty, recommendations based on what the network needs. */
export function DrugSearch({ state, value, onChange, onPick, placeholder = 'Search drugs by name or NDC' }: {
  state: SupplyState; value: string; onChange: (v: string) => void; onPick: (s: Suggestion) => void; placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const blur = useRef<number | undefined>(undefined);
  const items = useMemo(() => suggest(value, {
    shortages: state.shortages, items: state.inventory, forecasts: state.forecasts,
    siteName: id => siteName(state.sites, id),
    revisionOf: key => state.inventory.find(i => i.key === key)?.revision ?? -1,
  }), [value, state.shortages, state.inventory, state.forecasts, state.sites]);
  const pick = (s: Suggestion) => { onPick(s); setOpen(false); };

  return <div className="search" onFocus={() => { window.clearTimeout(blur.current); setOpen(true); }}
    onBlur={() => { blur.current = window.setTimeout(() => setOpen(false), 120); }}>
    <div className="search-input"><Search size={16}/>
      <input value={value} placeholder={placeholder} aria-label={placeholder}
        onChange={e => { onChange(e.target.value); setActive(0); setOpen(true); }}
        onKeyDown={e => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(a + 1, items.length - 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); }
          else if (e.key === 'Enter' && open && items[active]) { e.preventDefault(); pick(items[active]); }
          else if (e.key === 'Escape') setOpen(false);
        }} />
      {value && <button className="clear" aria-label="Clear search" onMouseDown={e => e.preventDefault()} onClick={() => onChange('')}><X size={14}/></button>}
    </div>
    {open && items.length > 0 && <div className="suggest" role="listbox">
      {items.map((s, i) => <div key={s.key}>
        {(i === 0 || items[i - 1].group !== s.group) && <div className="suggest-group">{s.group}</div>}
        <button className={`suggest-item ${i === active ? 'active' : ''}`} role="option" aria-selected={i === active}
          onMouseDown={e => e.preventDefault()} onMouseEnter={() => setActive(i)} onClick={() => pick(s)}>
          <span className={`dot ${s.kind === 'drug' ? 'drug' : s.risk ?? ''}`}/>
          <span><strong>{s.title}</strong><small>{s.detail}</small></span>
        </button></div>)}
    </div>}
  </div>;
}
