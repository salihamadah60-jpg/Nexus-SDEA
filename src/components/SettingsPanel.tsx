import React, { useState, useEffect } from 'react';
import { Shield, Database, Cpu, GitBranch, Zap, Activity, RefreshCw, CheckCircle2, XCircle, Palette, KeyRound, Timer, Rocket, BarChart2, Languages, Sparkles, Plus, Eye, EyeOff, Loader2, ExternalLink, DollarSign, AlertTriangle } from 'lucide-react';
import { useNexus } from '../NexusContext';
import { cn } from '../utils';
import { MODELS, MODES, THEMES } from '../constants';

interface ProviderRow {
  id: 'gemini' | 'groq' | 'github' | 'hf' | 'deepseek';
  label: string;
  envVar: string;
  href: string;
  hint: string;
}

const PROVIDER_BANNER: ProviderRow[] = [
  { id: 'gemini',   label: 'Gemini',          envVar: 'GEMINI_API_KEY',     href: 'https://aistudio.google.com/apikey',     hint: 'free tier — auto-suffixed for multi-key pool' },
  { id: 'groq',     label: 'Groq Llama-3.3',  envVar: 'GROQ_API_KEY',       href: 'https://console.groq.com/keys',          hint: 'free 70B reasoning' },
  { id: 'github',   label: 'GPT-4o (GitHub)', envVar: 'GITHUB_TOKEN',       href: 'https://github.com/settings/tokens',     hint: 'PAT with models:read scope' },
  { id: 'hf',       label: 'HuggingFace',     envVar: 'HUGGINGFACE_TOKEN',  href: 'https://huggingface.co/settings/tokens', hint: 'backup pool' },
  { id: 'deepseek', label: 'DeepSeek',        envVar: 'DEEPSEEK_API_KEY',   href: 'https://platform.deepseek.com/api_keys', hint: 'official API tier (or set OPENROUTER_API_KEY for free fallback)' },
];

function ProviderStatusBanner() {
  const [statusMap, setStatusMap] = useState<Record<string, 'ACTIVE' | 'MISSING' | 'UNKNOWN'>>({});
  const [openId, setOpenId] = useState<string | null>(null);
  const [draftValue, setDraftValue] = useState('');
  const [draftName, setDraftName] = useState('');
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const probe = async () => {
    try {
      const [s, ds] = await Promise.all([
        fetch('/api/status').then(r => r.json()).catch(() => ({})),
        fetch('/api/deepseek/status').then(r => r.json()).catch(() => ({} as any)),
      ]);
      setStatusMap({
        gemini:   s?.gemini  === 'ACTIVE' ? 'ACTIVE' : 'MISSING',
        groq:     s?.groq    === 'ACTIVE' ? 'ACTIVE' : 'MISSING',
        github:   s?.github  === 'ACTIVE' ? 'ACTIVE' : 'MISSING',
        hf:       s?.hf      === 'ACTIVE' ? 'ACTIVE' : 'MISSING',
        deepseek: ds?.mode === 'official' || ds?.mode === 'openrouter' ? 'ACTIVE' : 'MISSING',
      });
    } catch {}
  };

  useEffect(() => { probe(); const t = setInterval(probe, 15_000); return () => clearInterval(t); }, []);

  const open = (p: ProviderRow) => {
    setOpenId(p.id);
    setDraftName(p.envVar);
    setDraftValue('');
    setReveal(false);
    setFlash(null);
  };

  const save = async () => {
    if (!draftValue.trim()) { setFlash({ kind: 'err', text: 'paste a key first' }); return; }
    setBusy(true); setFlash(null);
    try {
      const r = await fetch('/api/kernel/env-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys: [{ name: draftName.trim(), value: draftValue.trim(), autoSuffix: true }] }),
      });
      const data = await r.json();
      const result = data?.results?.[0];
      if (result?.kept) {
        setFlash({ kind: 'ok', text: `${result.final} accepted (${result.validation?.verdict || 'live'})` });
        setDraftValue('');
        setOpenId(null);
        setTimeout(() => probe(), 400);
      } else {
        const reason = result?.validation?.detail || data?.errors?.[0]?.error || 'rejected';
        setFlash({ kind: 'err', text: `removed — ${reason}` });
      }
    } catch (e: any) {
      setFlash({ kind: 'err', text: e?.message || 'network error' });
    } finally {
      setBusy(false);
    }
  };

  const totalActive = Object.values(statusMap).filter(v => v === 'ACTIVE').length;

  return (
    <section className="rounded-xl border border-white/10 bg-gradient-to-br from-nexus-gold/[0.04] to-nexus-cyan/[0.03] p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <KeyRound size={13} className="text-nexus-gold" />
          <h3 className="nexus-label mb-0">Provider Status</h3>
        </div>
        <div className="flex items-center gap-2">
          <span className={cn(
            'text-[9px] font-black tracking-[0.2em] uppercase px-1.5 py-0.5 rounded border',
            totalActive > 0
              ? 'text-emerald-400 border-emerald-400/30 bg-emerald-400/10'
              : 'text-red-400 border-red-400/30 bg-red-400/10'
          )}>
            {totalActive}/{PROVIDER_BANNER.length} live
          </span>
          <button onClick={probe} className="text-text-dim/50 hover:text-white transition-colors p-0.5" title="Re-probe">
            <RefreshCw size={11} />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-1">
        {PROVIDER_BANNER.map(p => {
          const status = statusMap[p.id] || 'UNKNOWN';
          const ok = status === 'ACTIVE';
          const isOpen = openId === p.id;
          return (
            <div key={p.id} className={cn(
              'rounded-lg border transition-all overflow-hidden',
              ok ? 'border-emerald-400/15 bg-emerald-400/[0.03]' : 'border-white/5 bg-white/[0.02]'
            )}>
              <div className="flex items-center gap-2 px-2.5 py-1.5">
                <span className={cn(
                  'w-1.5 h-1.5 rounded-full shrink-0',
                  ok ? 'bg-emerald-400 animate-pulse shadow-[0_0_6px_rgba(52,211,153,0.6)]' : 'bg-text-dim/30'
                )} />
                <span className={cn('text-[11px] font-bold flex-1 truncate', ok ? 'text-white' : 'text-text-dim/70')}>
                  {p.label}
                </span>
                <span className={cn(
                  'text-[8px] font-black tracking-[0.2em] uppercase shrink-0',
                  ok ? 'text-emerald-400' : 'text-text-dim/40'
                )}>{status}</span>
                {ok ? (
                  <CheckCircle2 size={11} className="text-emerald-400 shrink-0" />
                ) : (
                  <button
                    onClick={() => isOpen ? setOpenId(null) : open(p)}
                    className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-nexus-gold/30 bg-nexus-gold/10 text-nexus-gold text-[9px] font-bold uppercase tracking-widest hover:bg-nexus-gold/20"
                  >
                    <Plus size={9} /> {isOpen ? 'Cancel' : 'Add key'}
                  </button>
                )}
              </div>

              {isOpen && (
                <div className="px-2.5 pb-2 pt-1 border-t border-white/5 space-y-1.5">
                  <div className="flex items-center gap-2 text-[10px] text-text-dim/70">
                    <span className="opacity-60">{p.hint}</span>
                    {p.href && (
                      <a href={p.href} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1 text-nexus-cyan hover:underline">
                        get key <ExternalLink size={9} />
                      </a>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <input
                      type="text"
                      value={draftName}
                      onChange={e => setDraftName(e.target.value)}
                      className="w-40 bg-black/40 border border-white/10 rounded px-2 py-1 font-mono text-[10px] focus:outline-none focus:border-nexus-gold/50"
                      placeholder="ENV_NAME"
                    />
                    <input
                      type={reveal ? 'text' : 'password'}
                      value={draftValue}
                      onChange={e => setDraftValue(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter' && !busy) save(); }}
                      placeholder="paste key…"
                      className="flex-1 min-w-[120px] bg-black/40 border border-white/10 rounded px-2 py-1 font-mono text-[10px] focus:outline-none focus:border-nexus-gold/50"
                      autoFocus
                    />
                    <button
                      type="button"
                      onClick={() => setReveal(v => !v)}
                      className="p-1 text-text-dim/60 hover:text-text-main"
                      title={reveal ? 'Hide' : 'Reveal'}
                    >
                      {reveal ? <EyeOff size={11} /> : <Eye size={11} />}
                    </button>
                    <button
                      onClick={save}
                      disabled={busy}
                      className="px-2.5 py-1 rounded bg-nexus-gold/15 hover:bg-nexus-gold/25 border border-nexus-gold/40 text-nexus-gold font-bold text-[9px] uppercase tracking-widest disabled:opacity-30 inline-flex items-center gap-1"
                    >
                      {busy ? <Loader2 size={10} className="animate-spin" /> : <Zap size={10} />}
                      Save
                    </button>
                  </div>
                  {flash && (
                    <div className={cn('text-[10px] font-bold', flash.kind === 'ok' ? 'text-emerald-400' : 'text-red-400')}>
                      {flash.kind === 'ok' ? '✓' : '⚠'} {flash.text}
                    </div>
                  )}
                  <div className="text-[8px] text-text-dim/40 uppercase tracking-widest">
                    persists to <code className="text-nexus-gold/60">.env.local</code> · live <code className="text-nexus-gold/60">process.env</code> · validated · auto-suffixed if name in use
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

interface KeyQuotaEntry {
  id: string;
  masked: string;
  calls: number;
  failures: number;
  cooldownRemaining: number;
  lastErrorCode?: string;
  disabled: boolean;
  healthy: boolean;
  tokensIn: number;
  tokensOut: number;
}

interface ReadinessCheck { name: string; ok: boolean; detail: string }
interface ReadinessReport { ready: boolean; score: number; checks: ReadinessCheck[]; sandbox: string; ts: string }

function TokenBar({ label, value, color }: { label: string; value: number; color: string }) {
  const cap = 1_000_000;
  const pct = Math.min(100, Math.round((value / cap) * 100));
  const fmt = value >= 1_000_000 ? `${(value / 1_000_000).toFixed(2)}M` : value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
  return (
    <div className="flex items-center gap-2">
      <span className="text-[8px] font-bold text-text-dim/40 uppercase w-7 shrink-0">{label}</span>
      <div className="flex-1 h-1 rounded-full bg-white/5 overflow-hidden">
        <div className={cn('h-full rounded-full transition-all', color)} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[8px] font-mono text-text-dim/50 shrink-0 w-10 text-right">{fmt}</span>
    </div>
  );
}

export function SettingsPanel() {
  const { state, setState, addNotification } = useNexus();
  const [kernelContent, setKernelContent] = useState('');
  const [isLoadingDNA, setIsLoadingDNA] = useState(false);
  const [quota, setQuota] = useState<Record<string, KeyQuotaEntry[]>>({});
  const [isLoadingQuota, setIsLoadingQuota] = useState(false);
  const [readiness, setReadiness] = useState<ReadinessReport | null>(null);
  const [isLoadingReadiness, setIsLoadingReadiness] = useState(false);
  const [deepseek, setDeepseek] = useState<{ mode: string; active: boolean; model: string | null; lastResolvedModel: string | null; source: string | null } | null>(null);
  const [ghModels, setGhModels] = useState<{ active: boolean; keys: number; healthy: number; defaultModel: string; endpoint: string } | null>(null);
  const [ghPing, setGhPing] = useState<{ ok: boolean; model?: string; text?: string; reason?: string; hint?: string } | null>(null);
  const [ghPinging, setGhPinging] = useState(false);

  const fetchGhModels = async () => {
    try { const r = await fetch('/api/github-models/status'); if (r.ok) setGhModels(await r.json()); } catch {}
  };
  const pingGhModels = async () => {
    setGhPinging(true);
    try {
      const r = await fetch('/api/github-models/ping');
      setGhPing(await r.json());
      fetchGhModels();
    } catch (e: any) { setGhPing({ ok: false, reason: e?.message || 'network error' }); }
    finally { setGhPinging(false); }
  };
  const resetKeyPool = async (provider: string) => {
    try {
      await fetch('/api/keypool/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider }) });
      fetchGhModels(); fetchQuota();
    } catch {}
  };

  const fetchDeepseek = async () => {
    try {
      const res = await fetch('/api/deepseek/status');
      if (!res.ok) return;
      setDeepseek(await res.json());
    } catch {}
  };

  const fetchQuota = async () => {
    setIsLoadingQuota(true);
    try {
      const res = await fetch('/api/kernel/quota');
      const data = await res.json();
      setQuota(data.keyPool || {});
    } catch {} finally { setIsLoadingQuota(false); }
  };

  const fetchReadiness = async () => {
    setIsLoadingReadiness(true);
    try {
      const res = await fetch('/api/deploy/readiness');
      const data = await res.json();
      setReadiness(data);
    } catch {} finally { setIsLoadingReadiness(false); }
  };

  useEffect(() => {
    fetchKernelDNA();
    fetchQuota();
    fetchReadiness();
    fetchDeepseek();
    fetchGhModels();
    const t = setInterval(() => { fetchQuota(); fetchDeepseek(); fetchGhModels(); }, 15000);
    return () => clearInterval(t);
  }, []);

  const fetchKernelDNA = async () => {
    setIsLoadingDNA(true);
    try {
      const res = await fetch('/api/kernel/core');
      const data = await res.json();
      setKernelContent(data.content || '');
    } catch {} finally {
      setIsLoadingDNA(false);
    }
  };

  const providers = [
    { label: 'E2B Matrix',    key: 'e2b',      icon: Cpu },
    { label: 'GitHub GPT-4o', key: 'github',   icon: GitBranch },
    { label: 'Gemini Flash',  key: 'gemini',   icon: Zap },
    { label: 'Groq 70B',      key: 'groq',     icon: Activity },
    { label: 'HuggingFace',   key: 'hf',       icon: Cpu },
    { label: 'Neural Memory', key: 'database', icon: Database },
  ];

  const dsModeColors: Record<string, string> = {
    official:   'bg-emerald-400/10 text-emerald-400 border-emerald-400/30',
    openrouter: 'bg-nexus-cyan/10 text-nexus-cyan border-nexus-cyan/30',
    disabled:   'bg-white/5 text-text-dim/40 border-white/10',
  };

  return (
    <div className="flex flex-col gap-5 p-4 h-full overflow-y-auto custom-scrollbar">
      {/* Provider Status Banner (Phase 13.8) — always-visible live detection
         + one-click inline "Add key" that POSTs to /api/kernel/env-keys
         (writes to .env.local and updates live process.env). */}
      <ProviderStatusBanner />

      {/* DeepSeek / OpenRouter Auto-Routing — Phase 11.4 live status badge */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <Sparkles size={14} className="text-nexus-cyan" />
            <h3 className="nexus-label mb-0">DeepSeek Routing</h3>
          </div>
          <button onClick={fetchDeepseek} className="text-text-dim/50 hover:text-white transition-colors">
            <RefreshCw size={11} />
          </button>
        </div>
        <div className="rounded-xl bg-white/[0.02] border border-white/5 p-3 space-y-2">
          {!deepseek ? (
            <div className="text-[10px] text-text-dim/40 italic">Loading…</div>
          ) : (
            <>
              <div className="flex items-center gap-2 flex-wrap">
                <span className={cn('px-2 py-0.5 rounded border text-[9px] font-black tracking-[0.2em] uppercase', dsModeColors[deepseek.mode] || dsModeColors.disabled)}>
                  {deepseek.mode === 'official' ? 'Official' : deepseek.mode === 'openrouter' ? 'OpenRouter · Auto' : 'Fallback'}
                </span>
                {deepseek.active ? (
                  <span className="inline-flex items-center gap-1 text-[9px] text-emerald-400/80 font-bold uppercase tracking-widest">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" /> Active
                  </span>
                ) : (
                  <span className="text-[9px] text-text-dim/40 uppercase tracking-widest">Using Gemini/Groq fallback</span>
                )}
              </div>
              <div className="grid grid-cols-2 gap-2 text-[10px] font-mono">
                <div>
                  <div className="text-[8px] uppercase tracking-widest text-text-dim/40 mb-0.5">Requested</div>
                  <div className="text-text-main/80 truncate" title={deepseek.model || '—'}>{deepseek.model || '—'}</div>
                </div>
                <div>
                  <div className="text-[8px] uppercase tracking-widest text-text-dim/40 mb-0.5">Resolved (last call)</div>
                  <div className="text-nexus-gold/90 truncate" title={deepseek.lastResolvedModel || 'no calls yet'}>
                    {deepseek.lastResolvedModel || <span className="text-text-dim/40">no calls yet</span>}
                  </div>
                </div>
              </div>
              {deepseek.mode === 'disabled' && (
                <div className="text-[10px] text-text-dim/50 leading-relaxed">
                  Set <code className="text-nexus-cyan">DEEPSEEK_API_KEY</code> for the official tier or <code className="text-nexus-cyan">OPENROUTER_API_KEY</code> to enable auto-routing.
                </div>
              )}
            </>
          )}
        </div>
      </section>

      {/* GPT-4o via GitHub Models — Phase 11.4 live status + ping */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <GitBranch size={14} className="text-emerald-400" />
            <h3 className="nexus-label mb-0">GPT-4o · GitHub Models</h3>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={pingGhModels}
              disabled={ghPinging}
              className="text-[9px] font-bold uppercase tracking-widest px-2 py-1 rounded border border-white/10 hover:border-emerald-400/50 hover:text-emerald-400 text-text-dim transition-all disabled:opacity-40"
            >{ghPinging ? 'Pinging…' : 'Live Ping'}</button>
            <button onClick={fetchGhModels} className="text-text-dim/50 hover:text-white transition-colors p-1">
              <RefreshCw size={11} />
            </button>
          </div>
        </div>
        <div className="rounded-xl bg-white/[0.02] border border-white/5 p-3 space-y-2">
          {!ghModels ? (
            <div className="text-[10px] text-text-dim/40 italic">Loading…</div>
          ) : (
            <>
              <div className="flex items-center gap-2 flex-wrap">
                <span className={cn('px-2 py-0.5 rounded border text-[9px] font-black tracking-[0.2em] uppercase',
                  ghModels.healthy > 0
                    ? 'bg-emerald-400/10 text-emerald-400 border-emerald-400/30'
                    : ghModels.keys > 0
                      ? 'bg-red-400/10 text-red-400 border-red-400/30'
                      : 'bg-white/5 text-text-dim/40 border-white/10'
                )}>
                  {ghModels.healthy > 0 ? 'Live' : ghModels.keys > 0 ? 'Keys Rejected' : 'No Keys'}
                </span>
                <span className="text-[9px] font-mono text-text-dim/70">
                  {ghModels.healthy}/{ghModels.keys} keys healthy
                </span>
                <span className="text-[9px] font-mono text-text-dim/50 truncate" title={ghModels.endpoint}>{ghModels.defaultModel}</span>
              </div>
              {ghPing && (
                <div className={cn('text-[10px] leading-relaxed rounded-lg p-2 border',
                  ghPing.ok
                    ? 'bg-emerald-400/5 border-emerald-400/20 text-emerald-300'
                    : 'bg-red-400/5 border-red-400/20 text-red-300'
                )}>
                  {ghPing.ok ? (
                    <>✓ {ghPing.model} replied: <span className="font-mono">{ghPing.text}</span></>
                  ) : (
                    <>
                      <div className="font-bold mb-1">✗ {ghPing.reason}</div>
                      {ghPing.hint && <div className="text-text-dim/80 text-[9px] leading-relaxed">{ghPing.hint}</div>}
                      <button
                        onClick={() => resetKeyPool('github')}
                        className="mt-2 text-[9px] font-bold uppercase tracking-widest px-2 py-1 rounded border border-emerald-400/30 hover:bg-emerald-400/10 text-emerald-400"
                      >Revive Keys After Fix</button>
                    </>
                  )}
                </div>
              )}
              {!ghPing && ghModels.keys === 0 && (
                <div className="text-[10px] text-text-dim/50 leading-relaxed">
                  Add a GitHub PAT (with the <code className="text-emerald-400">models:read</code> permission) to <code className="text-emerald-400">GITHUB_TOKEN</code> — multi-key rotation is supported via <code className="text-emerald-400">GITHUB_GPT</code>, <code className="text-emerald-400">ALT_GITHUB_GPT</code>, etc.
                </div>
              )}
            </>
          )}
        </div>
      </section>

      {/* Language / RTL toggle — Phase 11.5 */}
      <section>
        <div className="flex items-center gap-2 mb-2">
          <Languages size={14} className="text-nexus-gold" />
          <h3 className="nexus-label mb-0">Interface Language</h3>
        </div>
        <div className="flex gap-2">
          {([['en', 'English', 'LTR'], ['ar', 'العربية', 'RTL']] as const).map(([code, label, dir]) => (
            <button
              key={code}
              onClick={() => setState(prev => ({ ...prev, language: code }))}
              className={cn(
                'flex-1 flex flex-col items-center gap-0.5 px-3 py-2 rounded-lg border transition-all',
                state.language === code
                  ? 'bg-nexus-gold/10 border-nexus-gold/40 text-nexus-gold'
                  : 'bg-white/[0.02] border-white/5 text-text-dim/60 hover:bg-white/[0.04]'
              )}
            >
              <span className="text-[12px] font-bold">{label}</span>
              <span className="text-[8px] tracking-widest opacity-60">{dir}</span>
            </button>
          ))}
        </div>
      </section>

      {/* AI Providers */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h3 className="nexus-label mb-0">Neural Core Pulse</h3>
          <div className="text-[8px] font-bold tracking-[0.2em] text-white/20 uppercase">Real-time</div>
        </div>
        <div className="space-y-1.5">
          {providers.map(({ label, key, icon: Icon }) => {
            const status = (state.systemStatus as any)[key] || 'UNKNOWN';
            const ok = status === 'ACTIVE' || status === 'CONNECTED';
            const isCustom = state.customKeys[key.toUpperCase() + '_API_KEY'] || state.customKeys[key.toUpperCase() + '_TOKEN'];
            
            return (
              <div 
                key={key} 
                className={cn(
                  "group flex flex-col rounded-xl px-4 py-2.5 transition-all duration-300",
                  "bg-white/[0.02] border border-white/5 hover:bg-white/[0.05] hover:border-white/10",
                  ok && "bg-emerald-400/[0.02] border-emerald-400/10"
                )}
              >
                <div className="flex items-center justify-between w-full">
                  <div className="flex items-center gap-3">
                    <div className={cn(
                      "flex h-7 w-7 items-center justify-center rounded-lg transition-colors",
                      ok ? "bg-emerald-400/10 text-emerald-400" : "bg-white/5 text-text-dim/40"
                    )}>
                      <Icon className="w-3.5 h-3.5" />
                    </div>
                    <span className={cn(
                      "text-[11px] font-bold tracking-tight transition-colors",
                      ok ? "text-white" : "text-text-dim/60 group-hover:text-text-dim"
                    )}>{label}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={cn(
                      "text-[8px] font-black tracking-[0.2em] uppercase transition-all",
                      ok ? "text-emerald-400" : "text-text-dim/30"
                    )}>{status}</span>
                    {ok ? (
                      <CheckCircle2 size={12} className="text-emerald-400 drop-shadow-[0_0_4px_rgba(52,211,153,0.5)]" />
                    ) : (
                      <XCircle size={12} className="text-red-400/40" />
                    )}
                  </div>
                </div>

                <div className="mt-2.5 pt-2 border-t border-white/5">
                  <div className="flex items-center gap-2">
                    <input 
                      type="password"
                      placeholder={`Enter custom ${key} key...`}
                      className="flex-1 bg-black/40 border border-white/5 rounded px-2 py-1 text-[9px] font-mono text-white/50 focus:border-nexus-gold/30 outline-none transition-all"
                      value={state.customKeys[key === 'github' ? 'GITHUB_TOKEN' : (key.toUpperCase() + '_API_KEY')] || ''}
                      onChange={(e) => {
                        const envKey = key === 'github' ? 'GITHUB_TOKEN' : (key.toUpperCase() + '_API_KEY');
                        setState(prev => ({
                          ...prev,
                          customKeys: { ...prev.customKeys, [envKey]: e.target.value }
                        }));
                      }}
                    />
                    {isCustom && (
                      <button 
                        onClick={() => {
                          const envKey = key === 'github' ? 'GITHUB_TOKEN' : (key.toUpperCase() + '_API_KEY');
                          const newKeys = { ...state.customKeys };
                          delete newKeys[envKey];
                          setState(prev => ({ ...prev, customKeys: newKeys }));
                        }}
                        className="text-[8px] text-red-400/60 hover:text-red-400 uppercase font-black"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Key Pool — live quota dashboard */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <KeyRound size={14} className="text-nexus-cyan" />
            <h3 className="nexus-label mb-0">Key Pool Quota</h3>
          </div>
          <button onClick={fetchQuota} className="text-text-dim/50 hover:text-white transition-colors">
            <RefreshCw size={12} className={isLoadingQuota ? 'animate-spin' : ''} />
          </button>
        </div>
        <div className="space-y-3">
          {Object.entries(quota).map(([provider, keys]) => (
            <div key={provider} className="rounded-lg bg-white/[0.02] border border-white/5 p-2.5">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-text-main">{provider}</span>
                <span className="text-[8px] text-text-dim/50">{keys.filter(k => k.healthy).length}/{keys.length} healthy</span>
              </div>
              <div className="space-y-1">
                {keys.length === 0 && (
                  <div className="text-[10px] text-text-dim/40 italic px-1">No keys configured for {provider}.</div>
                )}
                {keys.map(k => (
                  <div key={k.id} className={cn(
                    "flex flex-col gap-1.5 px-2 py-2 rounded text-[10px] font-mono",
                    k.disabled ? "bg-red-400/5 border border-red-400/15"
                      : k.healthy ? "bg-emerald-400/[0.04] border border-emerald-400/10"
                      : "bg-yellow-400/[0.04] border border-yellow-400/15"
                  )}>
                    <div className="flex items-center gap-2">
                      <span className={cn(
                        "w-1.5 h-1.5 rounded-full shrink-0",
                        k.disabled ? "bg-red-400" : k.healthy ? "bg-emerald-400" : "bg-yellow-400"
                      )} />
                      <span className="truncate flex-1 text-text-main/80" title={k.id}>{k.id}</span>
                      <span className="text-text-dim/40 shrink-0">{k.masked}</span>
                      <span className="text-nexus-cyan/70 shrink-0" title="Successful calls">{k.calls}✓</span>
                      {k.failures > 0 && (
                        <span className="text-red-400/70 shrink-0" title={`Last error: ${k.lastErrorCode || '?'}`}>{k.failures}✗</span>
                      )}
                      {k.cooldownRemaining > 0 && (
                        <span className="flex items-center gap-0.5 text-yellow-400/70 shrink-0" title={`Cooldown: ${k.lastErrorCode}`}>
                          <Timer size={9} />{Math.ceil(k.cooldownRemaining / 1000)}s
                        </span>
                      )}
                      {k.disabled && <span className="text-red-400/70 shrink-0">DISABLED</span>}
                    </div>
                    {(k.tokensIn > 0 || k.tokensOut > 0) && (
                      <div className="space-y-0.5 pt-0.5 border-t border-white/5">
                        <TokenBar label="in" value={k.tokensIn} color="bg-nexus-cyan/50" />
                        <TokenBar label="out" value={k.tokensOut} color="bg-nexus-gold/50" />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
          {Object.keys(quota).length === 0 && (
            <div className="text-[10px] text-text-dim/40 italic">Loading key pool…</div>
          )}
        </div>
      </section>

      {/* Deployment Readiness */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Rocket size={14} className="text-nexus-gold" />
            <h3 className="nexus-label mb-0">Deploy Readiness</h3>
          </div>
          <button onClick={fetchReadiness} className="text-text-dim/50 hover:text-white transition-colors">
            <RefreshCw size={12} className={isLoadingReadiness ? 'animate-spin' : ''} />
          </button>
        </div>
        {readiness ? (
          <div className="rounded-xl border border-white/5 bg-white/[0.02] overflow-hidden">
            <div className={cn(
              "flex items-center justify-between px-3 py-2 border-b border-white/5",
              readiness.ready ? "bg-emerald-400/5" : "bg-yellow-400/5"
            )}>
              <div className="flex items-center gap-2">
                {readiness.ready
                  ? <CheckCircle2 size={13} className="text-emerald-400" />
                  : <XCircle size={13} className="text-yellow-400" />
                }
                <span className={cn(
                  "text-[10px] font-black uppercase tracking-[0.2em]",
                  readiness.ready ? "text-emerald-400" : "text-yellow-400"
                )}>
                  {readiness.ready ? "Ready to Deploy" : "Not Ready"}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <BarChart2 size={11} className="text-text-dim/40" />
                <span className="text-[9px] font-bold text-text-dim/60">{readiness.score}%</span>
              </div>
            </div>
            <div className="p-2 space-y-1">
              {readiness.checks.map(c => (
                <div key={c.name} className="flex items-start gap-2 px-1 py-0.5">
                  {c.ok
                    ? <CheckCircle2 size={10} className="text-emerald-400 shrink-0 mt-0.5" />
                    : <XCircle size={10} className="text-red-400 shrink-0 mt-0.5" />
                  }
                  <div className="min-w-0">
                    <div className="text-[9px] font-bold uppercase tracking-wider text-text-dim/60">{c.name.replace(/_/g, ' ')}</div>
                    <div className="text-[9px] text-text-dim/40 leading-tight">{c.detail}</div>
                  </div>
                </div>
              ))}
            </div>
            <div className="px-3 py-1.5 border-t border-white/5 text-[8px] text-text-dim/30 font-mono">
              {new Date(readiness.ts).toLocaleTimeString()} · sandbox: {readiness.sandbox}
            </div>
          </div>
        ) : (
          <div className="text-[10px] text-text-dim/40 italic">Loading readiness…</div>
        )}
      </section>

      {/* Theme Selection — 8 hand-tuned palettes */}
      <section>
        <div className="flex items-center gap-2 mb-3">
          <Palette size={14} className="text-nexus-gold" />
          <h3 className="nexus-label mb-0">Interface Theme</h3>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {THEMES.map(t => {
            const active = state.theme === t.id;
            const modeChip =
              t.mode === 'dark'  ? 'bg-white/5 text-text-dim' :
              t.mode === 'light' ? 'bg-amber-300/10 text-amber-300' :
                                   'bg-nexus-cyan/10 text-nexus-cyan';
            return (
              <button
                key={t.id}
                onClick={() => setState(prev => ({ ...prev, theme: t.id }))}
                className={cn(
                  'group relative flex flex-col items-start p-2.5 rounded-xl border transition-all text-left overflow-hidden',
                  active
                    ? 'bg-nexus-gold/10 border-nexus-gold/30 ring-1 ring-nexus-gold/20'
                    : 'bg-white/[0.02] border-white/5 hover:bg-white/[0.05] hover:border-white/10'
                )}
              >
                <div className="flex items-center justify-between w-full mb-1.5">
                  <span className={cn(
                    'text-[11px] font-bold',
                    active ? 'text-nexus-gold' : 'text-text-main'
                  )}>{t.name}</span>
                  <span className={cn('text-[7px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded', modeChip)}>
                    {t.mode}
                  </span>
                </div>
                <div className="flex items-center gap-1 mb-1">
                  {t.swatch.map((c, i) => (
                    <div
                      key={i}
                      className="w-4 h-4 rounded-md ring-1 ring-white/10"
                      style={{ background: c }}
                    />
                  ))}
                </div>
                <span className="text-[8px] text-text-dim/60 leading-tight uppercase tracking-tighter line-clamp-2">{t.desc}</span>
              </button>
            );
          })}
        </div>
      </section>

      {/* Phase 13.9 — Budget Guardrails */}
      <section>
        <div className="flex items-center gap-2 mb-1">
          <AlertTriangle size={14} className="text-amber-400" />
          <h3 className="nexus-label mb-0">Budget Guardrails</h3>
        </div>
        <p className="text-[9px] text-text-dim/60 mb-3 leading-snug">
          When a session crosses either threshold, a warning banner appears
          above the composer with a one-click pause. Set to 0 to disable.
        </p>
        <div className="grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-1 rounded-xl border border-white/5 bg-white/[0.02] px-3 py-2.5">
            <span className="text-[8px] font-black uppercase tracking-[0.18em] text-text-dim flex items-center gap-1.5">
              <DollarSign size={9} className="text-amber-400" /> USD threshold
            </span>
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-text-dim font-mono">$</span>
              <input
                type="number"
                step="0.01"
                min="0"
                value={state.budgetUsd || 0}
                onChange={e => setState(prev => ({ ...prev, budgetUsd: Math.max(0, Number(e.target.value) || 0) }))}
                className="flex-1 min-w-0 bg-transparent text-[12px] font-bold text-text-main focus:outline-none"
                placeholder="0.00"
              />
            </div>
          </label>
          <label className="flex flex-col gap-1 rounded-xl border border-white/5 bg-white/[0.02] px-3 py-2.5">
            <span className="text-[8px] font-black uppercase tracking-[0.18em] text-text-dim flex items-center gap-1.5">
              <Zap size={9} className="text-nexus-cyan" /> Token threshold
            </span>
            <input
              type="number"
              step="1000"
              min="0"
              value={state.budgetTokens || 0}
              onChange={e => setState(prev => ({ ...prev, budgetTokens: Math.max(0, Math.floor(Number(e.target.value) || 0)) }))}
              className="bg-transparent text-[12px] font-bold text-text-main focus:outline-none"
              placeholder="100000"
            />
          </label>
        </div>
        {(state.budgetUsd > 0 || state.budgetTokens > 0) && (
          <p className="text-[9px] text-text-dim/50 mt-2 font-mono">
            Active limits:{' '}
            {state.budgetUsd > 0    && <span className="text-amber-400">${state.budgetUsd.toFixed(2)}</span>}
            {state.budgetUsd > 0 && state.budgetTokens > 0 && <span className="text-text-dim/40"> · </span>}
            {state.budgetTokens > 0 && <span className="text-nexus-cyan">{state.budgetTokens.toLocaleString()} tok</span>}
          </p>
        )}
        {Object.keys(state.pausedSessions || {}).length > 0 && (
          <div className="mt-2 p-2 rounded-lg bg-red-500/5 border border-red-500/20">
            <p className="text-[9px] font-bold uppercase tracking-widest text-red-300/80 mb-1.5">
              Paused sessions ({Object.keys(state.pausedSessions).length})
            </p>
            <div className="flex flex-wrap gap-1.5">
              {Object.keys(state.pausedSessions).map(sid => (
                <button
                  key={sid}
                  onClick={() => setState(prev => {
                    const map = { ...prev.pausedSessions };
                    delete map[sid];
                    return { ...prev, pausedSessions: map };
                  })}
                  className="text-[8px] font-mono px-1.5 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/20 transition-colors"
                  title="Click to resume"
                >
                  {sid.slice(0, 14)}…  ▶ resume
                </button>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* Model Selection */}
      <section>
        <h3 className="nexus-label mb-3">Default Model</h3>
        <div className="space-y-1">
          {MODELS.map(m => (
            <button
              key={m.id}
              onClick={() => setState(prev => ({ ...prev, selectedModel: m.id }))}
              className={cn(
                'w-full text-left rounded-lg border px-3 py-2 transition-all',
                state.selectedModel === m.id
                  ? 'bg-nexus-gold/8 border-nexus-gold/20 text-nexus-gold'
                  : 'bg-white/[0.02] border-white/5 text-text-dim hover:bg-white/5'
              )}
            >
              <div className="text-[11px] font-bold">{m.name}</div>
              <div className="text-[9px] opacity-60 mt-0.5">{m.desc}</div>
            </button>
          ))}
        </div>
      </section>

      {/* Mode Selection */}
      <section>
        <h3 className="nexus-label mb-3">Default Mode</h3>
        <div className="space-y-1">
          {MODES.map(m => (
            <button
              key={m.id}
              onClick={() => setState(prev => ({ ...prev, selectedMode: m.id }))}
              className={cn(
                'w-full text-left rounded-lg border px-3 py-2 transition-all',
                state.selectedMode === m.id
                  ? 'bg-nexus-cyan/5 border-nexus-cyan/20 text-nexus-cyan'
                  : 'bg-white/[0.02] border-white/5 text-text-dim hover:bg-white/5'
              )}
            >
              <div className="text-[11px] font-bold capitalize">{m.name}</div>
              <div className="text-[9px] opacity-60 mt-0.5">{m.desc}</div>
            </button>
          ))}
        </div>
      </section>

      {/* Sovereign DNA */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h3 className="nexus-label">Sovereign DNA</h3>
          <button onClick={fetchKernelDNA} className="text-text-dim/50 hover:text-white transition-colors">
            <RefreshCw size={12} className={isLoadingDNA ? 'animate-spin' : ''} />
          </button>
        </div>
        <div className="rounded-lg bg-nexus-gold/3 border border-nexus-gold/10 p-3 max-h-40 overflow-y-auto custom-scrollbar">
          <pre className="text-[9px] font-mono text-nexus-gold/50 whitespace-pre-wrap leading-relaxed">{kernelContent || 'Loading DNA...'}</pre>
        </div>
      </section>

      {/* Version */}
      <div className="text-center pt-2 border-t border-border">
        <div className="flex items-center justify-center gap-2">
          <Shield className="w-4 h-4 text-nexus-gold/30" />
          <span className="text-[9px] font-bold uppercase tracking-widest text-text-dim/30">Nexus AI Digital Engineer v8.0</span>
        </div>
      </div>
    </div>
  );
}
