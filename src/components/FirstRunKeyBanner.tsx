import React, { useEffect, useMemo, useState } from 'react';
import { KeyRound, ExternalLink, X, Check, Loader2, Eye, EyeOff, Plus, Trash2, ChevronDown, ChevronUp, Zap } from 'lucide-react';

/**
 * First-Run Key Banner (Plan 10.1).
 *
 * Two modes, both with show/hide toggles, free-form names, and multi-key
 * support per provider:
 *
 *   QUICK   one row → pick provider, optionally tweak the env-var name, paste,
 *           save. Click "+ another" to stack additional inputs that auto-suffix
 *           (GEMINI_API_KEY → GEMINI_API_KEY_2 → _3 …).
 *
 *   BULK    one input per provider already laid out — fill what you have, hit
 *           "Save All". One round-trip writes everything to `.env.local`.
 *
 * Free-form: the "Custom" provider lets you push any NAME=VALUE pair, with
 * the same autoSuffix opt-in for grouped uploads.
 */

interface ProviderDef {
  id: string;
  name: string;
  envVar: string;
  href: string;
  hint: string;
}

const PROVIDERS: ProviderDef[] = [
  { id: 'gemini',  name: 'Gemini',      envVar: 'GEMINI_API_KEY',      href: 'https://aistudio.google.com/apikey',         hint: 'Free tier · supports many keys (auto-suffixed)' },
  { id: 'groq',    name: 'Groq',        envVar: 'GROQ_API_KEY',        href: 'https://console.groq.com/keys',              hint: 'Free Llama-3.3-70B' },
  { id: 'github',  name: 'GitHub',      envVar: 'GITHUB_TOKEN',        href: 'https://github.com/settings/tokens',         hint: 'GPT-4o via GitHub Models' },
  { id: 'hf',      name: 'HuggingFace', envVar: 'HUGGINGFACE_TOKEN',   href: 'https://huggingface.co/settings/tokens',     hint: 'Backup pool' },
  { id: 'custom',  name: 'Custom',      envVar: '',                    href: '',                                           hint: 'Any NAME=VALUE pair you want in .env.local' },
];

interface Row {
  rid: string;
  providerId: string;
  name: string;
  value: string;
  reveal: boolean;
}

let rowCounter = 0;
const newRow = (p: ProviderDef, suffixIndex = 0): Row => ({
  rid: `r${++rowCounter}`,
  providerId: p.id,
  name: suffixIndex > 0 && p.envVar ? `${p.envVar}_${suffixIndex + 1}` : p.envVar,
  value: '',
  reveal: false,
});

export function FirstRunKeyBanner() {
  const [needsKey, setNeedsKey] = useState(false);
  const [dismissed, setDismissed] = useState(() => sessionStorage.getItem('nexus_banner_dismissed') === '1');
  const [expanded, setExpanded] = useState(false);
  const [mode, setMode] = useState<'quick' | 'bulk'>('quick');
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [providerStatus, setProviderStatus] = useState<Record<string, boolean>>({});
  const [lastResults, setLastResults] = useState<Array<{ requested: string; final: string; kept: boolean; validation: { verdict: string; detail: string; provider: string | null } }>>([]);

  // Quick mode: one or more rows for one chosen provider.
  const [quickProvider, setQuickProvider] = useState<ProviderDef>(PROVIDERS[0]);
  const [quickRows, setQuickRows] = useState<Row[]>([newRow(PROVIDERS[0])]);

  // Bulk mode: one starter row per provider; user can add more or wipe any.
  const [bulkRows, setBulkRows] = useState<Row[]>(() => PROVIDERS.filter(p => p.id !== 'custom').map(p => newRow(p)));

  const probe = async () => {
    try {
      const r = await fetch('/api/status');
      const data = await r.json();
      setProviderStatus({
        gemini: data?.gemini === 'ACTIVE',
        groq:   data?.groq === 'ACTIVE',
        github: data?.github === 'ACTIVE',
        hf:     data?.hf === 'ACTIVE',
      });
      setNeedsKey(!['gemini', 'groq', 'github', 'hf'].some(k => data?.[k] === 'ACTIVE'));
    } catch {}
  };

  useEffect(() => { probe(); const t = setInterval(probe, 15_000); return () => clearInterval(t); }, []);

  // Re-seed quick rows when the provider changes.
  useEffect(() => { setQuickRows([newRow(quickProvider)]); }, [quickProvider.id]);

  const flashFor = (ms = 2200) => setTimeout(() => setFlash(null), ms);

  if (!needsKey || dismissed) return null;

  const collectFromQuick = () =>
    quickRows
      .map(r => ({ name: r.name.trim(), value: r.value.trim(), autoSuffix: quickProvider.id !== 'custom' }))
      .filter(r => r.name && r.value);

  const collectFromBulk = () =>
    bulkRows
      .map(r => ({ name: r.name.trim(), value: r.value.trim(), autoSuffix: true }))
      .filter(r => r.name && r.value);

  const submit = async (rows: Array<{ name: string; value: string; autoSuffix: boolean }>) => {
    if (rows.length === 0) { setFlash({ kind: 'err', text: 'Nothing to save — paste at least one key.' }); flashFor(); return; }
    setBusy(true); setFlash(null);
    try {
      const r = await fetch('/api/kernel/env-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys: rows }),
      });
      const data = await r.json();
      if (!r.ok && !Array.isArray(data?.results)) throw new Error(data?.error || 'failed');
      const results = data?.results || [];
      const keptCount = data?.written?.length || 0;
      const droppedCount = data?.removed?.length || 0;
      const errCount = data?.errors?.length || 0;
      setLastResults(results);
      if (keptCount > 0 || droppedCount > 0) {
        const parts: string[] = [];
        if (keptCount > 0) parts.push(`${keptCount} valid`);
        if (droppedCount > 0) parts.push(`${droppedCount} rejected & removed`);
        if (errCount > 0) parts.push(`${errCount} skipped`);
        setFlash({ kind: droppedCount > 0 || errCount > 0 ? 'err' : 'ok', text: parts.join(' · ') });
        // Wipe values for kept rows, leave rejected ones so user can re-edit.
        const droppedSet = new Set((data?.removed || []).map((r: any) => r.requested));
        if (mode === 'quick') setQuickRows(rs => rs.map(r => droppedSet.has(r.name) ? r : { ...r, value: '' }));
        else setBulkRows(rs => rs.map(r => droppedSet.has(r.name) ? r : { ...r, value: '' }));
        flashFor(5000);
        probe();
      } else {
        setFlash({ kind: 'err', text: `No keys saved (${errCount} error${errCount === 1 ? '' : 's'}).` });
        flashFor();
      }
    } catch (e: any) {
      setFlash({ kind: 'err', text: e.message });
      flashFor();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-b border-nexus-gold/20 bg-nexus-gold/[0.04] text-text-main shrink-0">
      {/* Compact header strip — always visible while needsKey */}
      <div className="px-4 py-2 flex items-center gap-3 flex-wrap text-[11px]">
        <KeyRound size={13} className="text-nexus-gold shrink-0" />
        <span className="font-bold text-nexus-gold uppercase tracking-[0.18em] text-[10px]">No AI keys</span>
        <span className="text-text-dim">Add one or many to activate the Sovereign Loop.</span>
        <button
          onClick={() => setExpanded(e => !e)}
          className="ml-auto inline-flex items-center gap-1 px-2 py-0.5 rounded bg-nexus-gold/10 hover:bg-nexus-gold/20 border border-nexus-gold/30 text-nexus-gold font-bold text-[10px] uppercase tracking-widest"
        >
          {expanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
          {expanded ? 'Hide' : 'Add Keys'}
        </button>
        <button
          onClick={() => { sessionStorage.setItem('nexus_banner_dismissed', '1'); setDismissed(true); }}
          className="text-text-dim/40 hover:text-text-dim p-0.5"
          title="Dismiss for this session"
        ><X size={12} /></button>
      </div>

      {expanded && (
        <div className="px-4 pb-3 pt-1 border-t border-nexus-gold/10 space-y-2">
          {/* Mode tabs + provider status pills */}
          <div className="flex items-center gap-2 flex-wrap">
            <div className="inline-flex rounded border border-white/10 overflow-hidden text-[10px]">
              {(['quick', 'bulk'] as const).map(m => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className={`px-3 py-1 uppercase tracking-widest font-bold ${mode === m ? 'bg-nexus-gold/20 text-nexus-gold' : 'text-text-dim hover:text-text-main hover:bg-white/5'}`}
                >{m === 'quick' ? 'One Provider' : 'Bulk Add'}</button>
              ))}
            </div>
            <div className="flex items-center gap-1.5 ml-2">
              {(['gemini', 'groq', 'github', 'hf'] as const).map(k => (
                <span key={k} className={`text-[9px] uppercase tracking-widest font-bold px-1.5 py-0.5 rounded border ${providerStatus[k] ? 'border-emerald-400/40 bg-emerald-400/10 text-emerald-400' : 'border-white/10 bg-white/[0.02] text-text-dim/50'}`}>
                  {providerStatus[k] ? '●' : '○'} {k}
                </span>
              ))}
            </div>
          </div>

          {mode === 'quick' && (
            <QuickPanel
              provider={quickProvider}
              setProvider={setQuickProvider}
              rows={quickRows}
              setRows={setQuickRows}
            />
          )}

          {mode === 'bulk' && (
            <BulkPanel rows={bulkRows} setRows={setBulkRows} />
          )}

          {lastResults.length > 0 && (
            <div className="space-y-0.5 pt-1 border-t border-white/5">
              {lastResults.map(r => (
                <div key={r.final} className={`flex items-center gap-2 text-[10px] font-mono ${r.kept ? 'text-emerald-400/80' : 'text-red-400/80'}`}>
                  <span className="w-3 text-center">{r.kept ? '✓' : '✗'}</span>
                  <span className="font-bold">{r.final}</span>
                  <span className="opacity-50">·</span>
                  <span className="opacity-70">{r.validation.provider || 'no validator'}</span>
                  <span className="opacity-50">·</span>
                  <span className="opacity-60">{r.kept ? (r.validation.verdict === 'unknown' ? 'kept (no live check)' : 'live key accepted') : `removed — ${r.validation.detail}`}</span>
                </div>
              ))}
            </div>
          )}
          <div className="flex items-center justify-between gap-3 pt-1">
            <div className="text-[9px] text-text-dim/60 uppercase tracking-widest">
              Written to <code className="text-nexus-gold/70">.env.local</code> · live <code className="text-nexus-gold/70">process.env</code> updated · invalid keys auto-removed
            </div>
            <div className="flex items-center gap-2">
              {flash && (
                <span className={`text-[10px] font-bold ${flash.kind === 'ok' ? 'text-emerald-400' : 'text-red-400'}`}>
                  {flash.kind === 'ok' ? '✓' : '⚠'} {flash.text}
                </span>
              )}
              <button
                onClick={() => submit(mode === 'quick' ? collectFromQuick() : collectFromBulk())}
                disabled={busy}
                className="px-4 py-1.5 rounded bg-nexus-gold/15 hover:bg-nexus-gold/25 border border-nexus-gold/40 text-nexus-gold font-bold text-[10px] uppercase tracking-widest disabled:opacity-30 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
              >
                {busy ? <Loader2 size={11} className="animate-spin" /> : <Zap size={11} />}
                {mode === 'quick' ? 'Save Keys' : 'Save All'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function QuickPanel({ provider, setProvider, rows, setRows }: {
  provider: ProviderDef;
  setProvider: (p: ProviderDef) => void;
  rows: Row[];
  setRows: React.Dispatch<React.SetStateAction<Row[]>>;
}) {
  const addRow = () => {
    const used = rows.length;
    setRows(rs => [...rs, newRow(provider, used)]);
  };
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 flex-wrap text-[11px]">
        <span className="text-text-dim uppercase tracking-widest text-[9px] font-bold">Provider:</span>
        <select
          value={provider.id}
          onChange={(e) => setProvider(PROVIDERS.find(p => p.id === e.target.value) || PROVIDERS[0])}
          className="bg-black/40 border border-white/10 rounded px-2 py-0.5 text-[11px] focus:outline-none focus:border-nexus-gold/50"
        >
          {PROVIDERS.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        {provider.href && (
          <a href={provider.href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-nexus-cyan hover:underline">
            Get key <ExternalLink size={10} />
          </a>
        )}
        <span className="text-[9px] text-text-dim/60 italic">{provider.hint}</span>
      </div>
      {rows.map((row, idx) => (
        <KeyRow
          key={row.rid}
          row={row}
          onChange={(patch) => setRows(rs => rs.map(r => r.rid === row.rid ? { ...r, ...patch } : r))}
          onRemove={rows.length > 1 ? () => setRows(rs => rs.filter(r => r.rid !== row.rid)) : undefined}
          allowFreeName={provider.id === 'custom' || idx > 0}
        />
      ))}
      <button
        onClick={addRow}
        className="text-[10px] uppercase tracking-widest font-bold text-nexus-cyan hover:text-nexus-cyan/80 inline-flex items-center gap-1"
      >
        <Plus size={11} /> Add another {provider.id === 'custom' ? 'pair' : `${provider.name} key`}
      </button>
    </div>
  );
}

function BulkPanel({ rows, setRows }: {
  rows: Row[];
  setRows: React.Dispatch<React.SetStateAction<Row[]>>;
}) {
  const addRow = (providerId: string) => {
    const p = PROVIDERS.find(x => x.id === providerId) || PROVIDERS[0];
    const sameProviderCount = rows.filter(r => r.providerId === providerId).length;
    setRows(rs => [...rs, newRow(p, sameProviderCount)]);
  };
  const grouped = useMemo(() => {
    const g: Record<string, Row[]> = {};
    for (const r of rows) (g[r.providerId] ||= []).push(r);
    return g;
  }, [rows]);
  return (
    <div className="space-y-2.5">
      {PROVIDERS.filter(p => p.id !== 'custom').map(p => (
        <div key={p.id} className="space-y-1">
          <div className="flex items-center gap-2 text-[10px]">
            <span className="font-bold text-text-main uppercase tracking-widest">{p.name}</span>
            {p.href && (
              <a href={p.href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-nexus-cyan hover:underline text-[9px]">
                get key <ExternalLink size={9} />
              </a>
            )}
            <span className="text-[9px] text-text-dim/60 italic">{p.hint}</span>
            <button
              onClick={() => addRow(p.id)}
              className="ml-auto text-[9px] uppercase tracking-widest font-bold text-nexus-cyan hover:text-nexus-cyan/80 inline-flex items-center gap-0.5"
            >
              <Plus size={10} /> add
            </button>
          </div>
          {(grouped[p.id] || []).map((row, idx) => (
            <KeyRow
              key={row.rid}
              row={row}
              onChange={(patch) => setRows(rs => rs.map(r => r.rid === row.rid ? { ...r, ...patch } : r))}
              onRemove={(grouped[p.id] || []).length > 1 ? () => setRows(rs => rs.filter(r => r.rid !== row.rid)) : undefined}
              allowFreeName={idx > 0}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function KeyRow({ row, onChange, onRemove, allowFreeName }: {
  row: Row;
  onChange: (patch: Partial<Row>) => void;
  onRemove?: () => void;
  allowFreeName: boolean;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <input
        type="text"
        value={row.name}
        onChange={(e) => onChange({ name: e.target.value })}
        placeholder="ENV_NAME"
        readOnly={!allowFreeName}
        className={`w-44 bg-black/40 border border-white/10 rounded px-2 py-1 font-mono text-[10px] focus:outline-none focus:border-nexus-gold/50 ${!allowFreeName ? 'opacity-60 cursor-default' : ''}`}
        title={allowFreeName ? 'Free-form env var name' : 'Canonical name (auto-suffixed on save)'}
      />
      <input
        type={row.reveal ? 'text' : 'password'}
        value={row.value}
        onChange={(e) => onChange({ value: e.target.value })}
        placeholder="paste key…"
        className="flex-1 min-w-[180px] bg-black/40 border border-white/10 rounded px-2 py-1 font-mono text-[10px] focus:outline-none focus:border-nexus-gold/50"
      />
      <button
        type="button"
        onClick={() => onChange({ reveal: !row.reveal })}
        className="p-1 text-text-dim/60 hover:text-text-main"
        title={row.reveal ? 'Hide' : 'Reveal'}
      >
        {row.reveal ? <EyeOff size={12} /> : <Eye size={12} />}
      </button>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="p-1 text-text-dim/40 hover:text-red-400"
          title="Remove row"
        ><Trash2 size={12} /></button>
      )}
    </div>
  );
}
