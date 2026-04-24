import React, { useEffect, useMemo, useState } from 'react';
import {
  Activity, FileCode, Terminal as TerminalIcon, Eye, EyeOff, Brain,
  GitBranch, Trash2, Copy as CopyIcon, Edit2, AlertCircle, CheckCircle2,
  ListChecks, RefreshCw, Filter, RotateCcw, Check
} from 'lucide-react';
import { useNexus } from '../NexusContext';
import { cn } from '../utils';
import { NexusEvent } from '../types';

const KIND_META: Record<string, { icon: any; color: string; label: string }> = {
  'action.command':       { icon: TerminalIcon,  color: 'text-yellow-400 border-yellow-400/20 bg-yellow-400/5', label: 'CMD' },
  'action.file.write':    { icon: FileCode,      color: 'text-nexus-green border-nexus-green/20 bg-nexus-green/5', label: 'WRITE' },
  'action.file.delete':   { icon: Trash2,        color: 'text-red-400 border-red-400/20 bg-red-400/5', label: 'DELETE' },
  'action.file.rename':   { icon: Edit2,         color: 'text-nexus-cyan border-nexus-cyan/20 bg-nexus-cyan/5', label: 'RENAME' },
  'action.file.copy':     { icon: CopyIcon,      color: 'text-nexus-cyan border-nexus-cyan/20 bg-nexus-cyan/5', label: 'COPY' },
  'action.preview.open':  { icon: Eye,           color: 'text-nexus-gold border-nexus-gold/20 bg-nexus-gold/5', label: 'OPEN PREVIEW' },
  'action.checkpoint':    { icon: GitBranch,     color: 'text-nexus-gold border-nexus-gold/20 bg-nexus-gold/5', label: 'CHECKPOINT' },
  'obs.command.result':   { icon: CheckCircle2,  color: 'text-nexus-green border-nexus-green/20 bg-nexus-green/5', label: 'CMD OK' },
  'obs.file.changed':     { icon: FileCode,      color: 'text-text-dim border-white/10 bg-white/[0.02]', label: 'FS CHANGE' },
  'obs.preview.ready':    { icon: Eye,           color: 'text-nexus-green border-nexus-green/20 bg-nexus-green/5', label: 'PREVIEW UP' },
  'obs.preview.failed':   { icon: EyeOff,        color: 'text-red-400 border-red-400/20 bg-red-400/5', label: 'PREVIEW FAIL' },
  'obs.error':            { icon: AlertCircle,   color: 'text-red-400 border-red-400/20 bg-red-400/5', label: 'ERROR' },
  'agent.thought':        { icon: Brain,         color: 'text-nexus-gold border-nexus-gold/20 bg-nexus-gold/5', label: 'THOUGHT' },
  'agent.plan':           { icon: ListChecks,    color: 'text-nexus-cyan border-nexus-cyan/20 bg-nexus-cyan/5', label: 'PLAN' },
};

const FALLBACK = { icon: Activity, color: 'text-text-dim border-white/10 bg-white/[0.02]', label: 'EVENT' };

const FILTERS: { id: string; label: string; match: (k: string) => boolean }[] = [
  { id: 'all',     label: 'All',     match: () => true },
  { id: 'files',   label: 'Files',   match: (k) => k.startsWith('action.file') || k === 'obs.file.changed' },
  { id: 'cmd',     label: 'Shell',   match: (k) => k === 'action.command' || k === 'obs.command.result' },
  { id: 'preview', label: 'Preview', match: (k) => k.includes('preview') },
  { id: 'agent',   label: 'Agent',   match: (k) => k.startsWith('agent.') },
  { id: 'errors',  label: 'Errors',  match: (k) => k === 'obs.error' || k === 'obs.preview.failed' },
];

function describe(ev: NexusEvent): string {
  const p = ev.payload || {};
  switch (ev.kind) {
    case 'action.command':      return `$ ${p.cmd || ''}`;
    case 'action.file.write':   return `${p.path}${p.bytes != null ? ` (${(p.bytes / 1024).toFixed(1)} kb)` : ''}`;
    case 'action.file.delete':  return p.path || '';
    case 'action.file.rename':  return `${p.from || p.oldPath} → ${p.to || p.newPath}`;
    case 'action.file.copy':    return `${p.from || p.srcPath} → ${p.to || p.destPath}${p.move ? ' (move)' : ''}`;
    case 'action.preview.open': return p.url || '';
    case 'action.checkpoint':   return p.checkpointId ? `id=${p.checkpointId}` : '';
    case 'obs.command.result':  return `exit=${p.exitCode ?? '?'} ${p.cmd ? '· ' + p.cmd : ''}`;
    case 'obs.file.changed':    return p.path || '';
    case 'obs.preview.ready':   return `HTTP ${p.status || 'ok'} · ${p.url || ''}`;
    case 'obs.preview.failed':  return `${p.reason || 'failed'} · ${p.url || ''}`;
    case 'obs.error':           return p.message || JSON.stringify(p).slice(0, 120);
    case 'agent.thought':       return (p.text || '').slice(0, 140);
    case 'agent.plan':          return (p.summary || '').slice(0, 140);
    default:                    return JSON.stringify(p).slice(0, 120);
  }
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

/**
 * Per-event "Replay" affordance. Only emitted for events that have a
 * well-defined, reversible (or read-only) follow-up action; destructive
 * operations always confirm first. Returns null when nothing safe maps.
 */
function ReplayButton({ ev, sessionId, addNotification }: {
  ev: NexusEvent;
  sessionId: string | null;
  addNotification: (type: 'info' | 'success' | 'error', m: string, d?: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const flash = (ok: boolean) => {
    setDone(true);
    setTimeout(() => setDone(false), 1500);
    setBusy(false);
    return ok;
  };

  // Map kind → safe action.
  type Action = { label: string; run: () => Promise<void> } | null;

  const action: Action = (() => {
    const sid = ev.sessionId || sessionId;

    // 1. Preview events — re-probe the dev server via autopilot boot.
    if (ev.kind === 'obs.preview.ready' || ev.kind === 'obs.preview.failed' || ev.kind === 'action.preview.open') {
      if (!sid) return null;
      return {
        label: 'Re-probe',
        run: async () => {
          const res = await fetch(`/api/autopilot/boot/${encodeURIComponent(sid)}`, { method: 'POST' });
          if (!res.ok) throw new Error(`boot ${res.status}`);
          addNotification('info', 'Preview re-probe issued', 'Autopilot is verifying the dev server.');
        },
      };
    }

    // 2. Checkpoint events — restore (destructive, confirm required).
    if (ev.kind === 'action.checkpoint') {
      const checkpointId = ev.payload?.checkpointId;
      if (!sid || !checkpointId) return null;
      return {
        label: 'Restore',
        run: async () => {
          if (!window.confirm(`Restore checkpoint ${checkpointId}? This rewrites files in this session.`)) {
            throw new Error('cancelled');
          }
          const res = await fetch('/api/kernel/rollback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: sid, checkpointId }),
          });
          if (!res.ok) throw new Error((await res.json()).error || 'rollback failed');
          addNotification('success', 'Checkpoint restored', checkpointId);
        },
      };
    }

    // 3. Shell commands — copy to clipboard (safe; user re-runs in terminal).
    if (ev.kind === 'action.command' || ev.kind === 'obs.command.result') {
      const cmd = ev.payload?.cmd;
      if (!cmd) return null;
      return {
        label: 'Copy cmd',
        run: async () => {
          await navigator.clipboard.writeText(cmd);
          addNotification('info', 'Command copied', cmd.slice(0, 80));
        },
      };
    }

    // Everything else (file ops, agent thoughts, observations) — no replay.
    return null;
  })();

  if (!action) return null;

  return (
    <button
      onClick={async (e) => {
        e.stopPropagation();
        if (busy) return;
        setBusy(true);
        try { await action.run(); flash(true); }
        catch (err: any) {
          if (err?.message !== 'cancelled') addNotification('error', 'Replay failed', err.message);
          flash(false);
        }
      }}
      disabled={busy}
      className={cn(
        'flex items-center gap-1 px-1.5 py-0.5 rounded text-[8px] font-bold uppercase tracking-widest border transition-all shrink-0',
        done
          ? 'bg-nexus-green/15 border-nexus-green/40 text-nexus-green'
          : 'bg-white/5 border-white/10 text-text-dim/70 hover:text-nexus-cyan hover:border-nexus-cyan/30 hover:bg-nexus-cyan/5',
        busy && 'opacity-50 cursor-wait'
      )}
      title={`Replay this ${ev.kind} event`}
    >
      {done ? <Check size={9} /> : <RotateCcw size={9} className={busy ? 'animate-spin' : ''} />}
      {action.label}
    </button>
  );
}

export function ActivityFeed() {
  const { state, setState, addNotification } = useNexus();
  const [filter, setFilter] = useState('all');
  const [autoScroll, setAutoScroll] = useState(true);
  const sessionId = state.currentSessionId;

  // Bootstrap historical events from the ring buffer the first time the panel opens
  // for a session — afterwards, the live WS bridge keeps it fresh.
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/kernel/events?sessionId=${encodeURIComponent(sessionId)}&limit=200`);
        const data = await res.json();
        if (cancelled || !Array.isArray(data.events)) return;
        setState(prev => {
          const seen = new Set(prev.recentEvents.map(e => e.id));
          const merged = [...prev.recentEvents, ...data.events.filter((e: NexusEvent) => !seen.has(e.id))]
            .sort((a, b) => a.ts - b.ts)
            .slice(-300);
          return { ...prev, recentEvents: merged };
        });
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [sessionId]);

  const events = useMemo(() => {
    const f = FILTERS.find(x => x.id === filter)!;
    return state.recentEvents
      .filter(e => !sessionId || !e.sessionId || e.sessionId === sessionId)
      .filter(e => f.match(e.kind))
      .slice()
      .reverse();
  }, [state.recentEvents, filter, sessionId]);

  const scrollRef = React.useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (autoScroll && scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [events.length, autoScroll]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const e of state.recentEvents) {
      if (sessionId && e.sessionId && e.sessionId !== sessionId) continue;
      for (const f of FILTERS) if (f.match(e.kind)) c[f.id] = (c[f.id] || 0) + 1;
    }
    return c;
  }, [state.recentEvents, sessionId]);

  const clear = () => setState(prev => ({ ...prev, recentEvents: [] }));

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 pt-4 pb-2 shrink-0">
        <div className="flex items-center gap-2">
          <Activity size={13} className="text-nexus-cyan" />
          <h3 className="nexus-label mb-0">Activity Feed</h3>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setAutoScroll(v => !v)}
            className={cn(
              "p-1 px-1.5 rounded border text-[8px] font-bold uppercase tracking-widest transition-all",
              autoScroll
                ? "bg-nexus-green/10 border-nexus-green/30 text-nexus-green"
                : "bg-white/[0.03] border-white/5 text-text-dim"
            )}
            title="Auto-scroll to newest"
          >
            Live
          </button>
          <button
            onClick={clear}
            className="p-1 px-1.5 rounded bg-white/[0.03] border border-white/5 text-text-dim hover:text-red-400 hover:border-red-400/30 transition-all"
            title="Clear feed"
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>

      {/* Filter chips */}
      <div className="px-3 py-2 shrink-0 flex flex-wrap gap-1 border-b border-white/5">
        <Filter size={10} className="text-text-dim/40 self-center mr-1" />
        {FILTERS.map(f => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            className={cn(
              "px-2 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-widest transition-all border",
              filter === f.id
                ? "bg-nexus-cyan/10 border-nexus-cyan/30 text-nexus-cyan"
                : "bg-white/[0.02] border-white/5 text-text-dim hover:text-text-main"
            )}
          >
            {f.label}
            {counts[f.id] ? <span className="ml-1 opacity-60">{counts[f.id]}</span> : null}
          </button>
        ))}
      </div>

      {/* Stream */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto custom-scrollbar p-2 space-y-1">
        {events.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-text-dim/30">
            <Activity size={24} className="mb-2" />
            <p className="text-[10px] uppercase tracking-widest">No events yet</p>
            <p className="text-[9px] mt-1 opacity-60">Send a message to Nexus to start streaming.</p>
          </div>
        )}
        {events.map(ev => {
          const meta = KIND_META[ev.kind] || FALLBACK;
          const Icon = meta.icon;
          return (
            <div
              key={ev.id}
              className={cn("flex items-start gap-2 px-2 py-1.5 rounded-lg border", meta.color)}
            >
              <Icon size={11} className="shrink-0 mt-0.5 opacity-80" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[8px] font-black tracking-[0.2em] uppercase opacity-90">{meta.label}</span>
                  <span className="text-[8px] text-text-dim/50 font-mono">{formatTime(ev.ts)}</span>
                  <div className="ml-auto">
                    <ReplayButton ev={ev} sessionId={sessionId} addNotification={addNotification} />
                  </div>
                </div>
                <div className="text-[10px] font-mono text-text-main/80 break-all leading-relaxed mt-0.5">
                  {describe(ev)}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
