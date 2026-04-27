import React, { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import {
  ShieldCheck, Zap, Bot, CheckCircle2, XCircle, Clock,
  ChevronDown, ChevronRight, Trash2, RefreshCw, AlertTriangle, RotateCcw,
  Check, Layers,
} from 'lucide-react';
import { useNexus } from '../NexusContext';
import { cn } from '../utils';

// ── ANSI stripper ──────────────────────────────────────────────────────────
const ANSI_RE = /\x1b\[[0-9;]*m/g;
function strip(s: string) { return s.replace(ANSI_RE, ''); }

// ── Event model ────────────────────────────────────────────────────────────
type HealPass   = 'pattern' | 'ai' | 'audit';
type HealStatus = 'success' | 'failed' | 'in_progress' | 'skipped';

interface HealEvent {
  id:        string;
  ts:        number;
  pass:      HealPass;
  status:    HealStatus;
  file?:     string;
  detail:    string;
  sessionId?: string;
  /** raw error hint to re-send on retry */
  errorHint?: string;
}

// ── Parse terminal journal lines ───────────────────────────────────────────
function parseTerminalLines(lines: string[], sessionId: string): HealEvent[] {
  const events: HealEvent[] = [];
  let n = 0;
  const id = () => `tl-${sessionId.slice(-6)}-${n++}`;

  for (const raw of lines) {
    const line = strip(raw);
    if (!line.includes('[AUTOPILOT]') && !line.includes('[VISUAL AUDIT]')) continue;

    if (line.includes('Pre-transform error in') && line.includes('self-healing')) {
      const m = line.match(/Pre-transform error in ([^\s—–:]+)/);
      events.push({ id: id(), ts: Date.now(), pass: 'pattern', status: 'in_progress',
        file: m?.[1], detail: 'Vite pre-transform error detected — self-healing started.', sessionId });
      continue;
    }
    if (line.includes('Pattern-fix applied to')) {
      const m = line.match(/Pattern-fix applied to ([^\s(]+)/);
      events.push({ id: id(), ts: Date.now(), pass: 'pattern', status: 'success',
        file: m?.[1], detail: 'CSS // comments stripped — Vite HMR reloading.', sessionId });
      continue;
    }
    if (line.includes('Pattern-fix insufficient') || (line.includes('invoking AI self-healer') && !line.includes('fixed'))) {
      const m = line.match(/(?:for )([\w./\\-]+\.\w+)/);
      events.push({ id: id(), ts: Date.now(), pass: 'ai', status: 'in_progress',
        file: m?.[1], detail: 'Pattern-fix insufficient — AI self-healer invoked.', sessionId });
      continue;
    }
    if (line.includes('AI self-healer fixed')) {
      const m = line.match(/AI self-healer fixed ([\w./\\-]+\.\w+)/);
      events.push({ id: id(), ts: Date.now(), pass: 'ai', status: 'success',
        file: m?.[1], detail: 'AI self-healer rewrote file — Vite HMR reloading.', sessionId });
      continue;
    }
    if (line.includes('no fix generated')) {
      events.push({ id: id(), ts: Date.now(), pass: 'ai', status: 'failed',
        detail: 'AI returned no fix (AI busy or key exhausted).', sessionId,
        errorHint: 'Vite / TypeScript build error — fix all syntax and import issues.' });
      continue;
    }
    if (line.includes('AI self-healer error for')) {
      const m = line.match(/AI self-healer error for ([\w./\\-]+\.\w+): (.+)/);
      events.push({ id: id(), ts: Date.now(), pass: 'ai', status: 'failed',
        file: m?.[1], detail: m?.[2] || 'AI self-healer threw an error.', sessionId,
        errorHint: m?.[2] || 'Fix all syntax and import issues.' });
      continue;
    }
  }
  return events;
}

// ── Parse SSE statusHistory from chat messages ─────────────────────────────
function parseStatusHistory(statuses: string[], sessionId: string): HealEvent[] {
  const events: HealEvent[] = [];
  let n = 0;
  const id = () => `sh-${sessionId.slice(-6)}-${n++}`;

  for (const s of statuses) {
    if (s.includes('Reviewer detected') && s.includes('issue')) {
      const m = s.match(/Reviewer detected (\d+) issue/);
      events.push({ id: id(), ts: Date.now(), pass: 'audit', status: 'in_progress',
        detail: `Reviewer found ${m?.[1] ?? '?'} issue(s) — running AI self-correction.`, sessionId });
      continue;
    }
    if (s.includes('Self-correction applied')) {
      const m = s.match(/(\d+) file\(s\) patched/);
      events.push({ id: id(), ts: Date.now(), pass: 'audit', status: 'success',
        detail: `AI self-correction applied — ${m?.[1] ?? '?'} file(s) patched before disk write.`, sessionId });
      continue;
    }
    if (s.includes('Self-correction unavailable') || s.includes('Self-correction error')) {
      events.push({ id: id(), ts: Date.now(), pass: 'audit', status: 'skipped',
        detail: s.slice(0, 120), sessionId });
      continue;
    }
    if (s.includes('Dependency Audit Gate')) {
      const isVuln = s.includes('vuln');
      events.push({
        id: id(), ts: Date.now(), pass: 'audit',
        status: isVuln ? 'failed' : s.includes('No high/critical') ? 'success' : 'skipped',
        detail: s.replace('Dependency Audit Gate: ', '').slice(0, 140),
        sessionId,
      });
      continue;
    }
  }
  return events;
}

// ── UI meta ────────────────────────────────────────────────────────────────
const PASS_META: Record<HealPass, { label: string; icon: any; color: string }> = {
  pattern: { label: 'CSS Pattern', icon: Zap,        color: 'text-nexus-cyan  border-nexus-cyan/20  bg-nexus-cyan/5'  },
  ai:      { label: 'AI Healer',   icon: Bot,        color: 'text-nexus-gold  border-nexus-gold/20  bg-nexus-gold/5'  },
  audit:   { label: 'Reviewer',    icon: ShieldCheck, color: 'text-violet-400 border-violet-400/20 bg-violet-400/5'  },
};

const STATUS_META: Record<HealStatus, { icon: any; color: string; label: string }> = {
  success:     { icon: CheckCircle2,  color: 'text-nexus-green', label: 'Fixed'   },
  failed:      { icon: XCircle,       color: 'text-red-400',     label: 'Failed'  },
  in_progress: { icon: RefreshCw,     color: 'text-nexus-gold',  label: 'Running' },
  skipped:     { icon: AlertTriangle, color: 'text-yellow-400',  label: 'Skipped' },
};

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
}

// ── Retry state ────────────────────────────────────────────────────────────
type RetryState = 'idle' | 'running' | 'success' | 'failed';

// ── Retry button (AI failed rows with a known file) ────────────────────────
function RetryButton({
  ev,
  sessionId,
  onResult,
}: {
  ev: HealEvent;
  sessionId: string;
  onResult: (id: string, state: RetryState, detail?: string) => void;
}) {
  const [state, setState] = useState<RetryState>('idle');
  const [flash, setFlash] = useState(false);

  const trigger = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (state === 'running') return;
    setState('running');
    onResult(ev.id, 'running');
    try {
      const res = await fetch('/api/kernel/heal/retry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          filePath: ev.file,
          errorHint: ev.errorHint || ev.detail,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setState('failed');
        onResult(ev.id, 'failed', data.detail || data.error);
      } else {
        setState('success');
        onResult(ev.id, 'success', data.detail);
        setFlash(true);
        setTimeout(() => setFlash(false), 2000);
      }
    } catch (err: any) {
      setState('failed');
      onResult(ev.id, 'failed', err.message);
    }
  }, [state, ev, sessionId, onResult]);

  const label  = state === 'running' ? 'Healing…'
               : state === 'success' ? 'Fixed!'
               : state === 'failed'  ? 'Retry'
               : 'Retry Fix';

  const Icon   = state === 'success' ? Check
               : state === 'running' ? RefreshCw
               : RotateCcw;

  return (
    <button
      onClick={trigger}
      disabled={state === 'running'}
      title={state === 'success' ? 'Fix applied — Vite HMR reloading' : 'Re-run AI self-healer on this file'}
      className={cn(
        'flex items-center gap-1 px-2 py-0.5 rounded text-[8px] font-bold uppercase tracking-widest border transition-all shrink-0',
        state === 'success'
          ? 'bg-nexus-green/15 border-nexus-green/40 text-nexus-green cursor-default'
          : state === 'failed'
            ? 'bg-red-400/10 border-red-400/30 text-red-400 hover:bg-red-400/20'
            : state === 'running'
              ? 'bg-nexus-gold/10 border-nexus-gold/30 text-nexus-gold cursor-wait opacity-70'
              : 'bg-white/5 border-white/10 text-text-dim/70 hover:text-nexus-gold hover:border-nexus-gold/40 hover:bg-nexus-gold/5',
        flash && 'ring-1 ring-nexus-green/40'
      )}
    >
      <Icon size={9} className={state === 'running' ? 'animate-spin' : ''} />
      {label}
    </button>
  );
}

// ── Single row ─────────────────────────────────────────────────────────────
function HealRow({
  ev,
  sessionId,
  retryOverride,
  onRetryResult,
}: {
  ev: HealEvent;
  sessionId: string;
  retryOverride?: { state: RetryState; detail?: string };
  onRetryResult: (id: string, state: RetryState, detail?: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const pass = PASS_META[ev.pass];
  const Icon = pass.icon;

  // Merge live status with any retry override
  const effectiveStatus: HealStatus = retryOverride?.state === 'success'
    ? 'success'
    : retryOverride?.state === 'failed'
      ? 'failed'
      : retryOverride?.state === 'running'
        ? 'in_progress'
        : ev.status;

  const status    = STATUS_META[effectiveStatus];
  const StatusIcon = status.icon;
  const detailText = retryOverride?.detail || ev.detail;

  // Show retry button only on AI failed rows with a known file path
  const canRetry = ev.pass === 'ai' && ev.status === 'failed' && !!ev.file && !!sessionId;

  return (
    <div className={cn('rounded-lg border overflow-hidden transition-all', pass.color)}>
      <button
        className="w-full flex items-start gap-2 px-2.5 py-2 text-left"
        onClick={() => setExpanded(v => !v)}
      >
        <Icon size={11} className="shrink-0 mt-0.5 opacity-80" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[8px] font-black tracking-[0.18em] uppercase opacity-90">{pass.label}</span>
            <span className="text-[8px] font-mono text-text-dim/50">{formatTime(ev.ts)}</span>

            {/* Status badge */}
            <div className={cn('flex items-center gap-1 shrink-0', status.color)}>
              <StatusIcon size={10} className={effectiveStatus === 'in_progress' ? 'animate-spin' : ''} />
              <span className="text-[8px] font-bold uppercase tracking-widest">{status.label}</span>
            </div>

            {/* Retry button — pushed to right, stops row expand */}
            {canRetry && (
              <div className="ml-auto shrink-0" onClick={e => e.stopPropagation()}>
                <RetryButton ev={ev} sessionId={sessionId} onResult={onRetryResult} />
              </div>
            )}
          </div>

          {ev.file && (
            <div className="text-[9px] font-mono text-text-dim/60 truncate mt-0.5">{ev.file}</div>
          )}
        </div>

        {/* Expand toggle */}
        <span className="shrink-0 self-center ml-1 text-text-dim/40">
          {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        </span>
      </button>

      {expanded && (
        <div className="px-3 pb-2.5 pt-0">
          <p className="text-[10px] font-mono text-text-main/70 leading-relaxed break-all">{detailText}</p>
        </div>
      )}
    </div>
  );
}

// ── Stats bar ──────────────────────────────────────────────────────────────
function StatsBar({ events }: { events: HealEvent[] }) {
  const successes = events.filter(e => e.status === 'success').length;
  const failures  = events.filter(e => e.status === 'failed').length;
  const patterns  = events.filter(e => e.pass === 'pattern' && e.status === 'success').length;
  const aiHeals   = events.filter(e => e.pass === 'ai'      && e.status === 'success').length;
  const audits    = events.filter(e => e.pass === 'audit'   && e.status === 'success').length;

  const stats = [
    { label: 'Healed',  val: successes,     color: 'text-nexus-green' },
    { label: 'Failed',  val: failures,      color: 'text-red-400'     },
    { label: 'Pattern', val: patterns,      color: 'text-nexus-cyan'  },
    { label: 'AI Fix',  val: aiHeals,       color: 'text-nexus-gold'  },
    { label: 'Audits',  val: audits,        color: 'text-violet-400'  },
    { label: 'Total',   val: events.length, color: 'text-text-dim'    },
  ];

  return (
    <div className="grid grid-cols-3 gap-1.5 px-3 py-2.5 border-b border-white/5 shrink-0">
      {stats.map(s => (
        <div key={s.label} className="bg-white/[0.03] rounded-lg border border-white/5 px-2 py-1.5 flex flex-col items-center">
          <span className={cn('text-lg font-black leading-none tabular-nums', s.color)}>{s.val}</span>
          <span className="text-[8px] uppercase tracking-widest text-text-dim/50 mt-0.5">{s.label}</span>
        </div>
      ))}
    </div>
  );
}

// ── Batch "Heal All Failed" ─────────────────────────────────────────────────
type BatchState = 'idle' | 'running' | 'done';

// ── Main panel ─────────────────────────────────────────────────────────────
export function SelfHealingPanel() {
  const { state } = useNexus();
  const sessionId = state.currentSessionId;

  // Retry overlay: maps event id → { state, detail }
  const [retryMap, setRetryMap] = useState<Record<string, { state: RetryState; detail?: string }>>({});
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Batch heal state
  const [batchState, setBatchState]     = useState<BatchState>('idle');
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number }>({ done: 0, total: 0 });

  const handleRetryResult = useCallback((id: string, rs: RetryState, detail?: string) => {
    setRetryMap(prev => ({ ...prev, [id]: { state: rs, detail } }));
  }, []);

  // ── Batch heal all failed AI events ──────────────────────────────────────
  const healAllFailed = useCallback(async (retryableEvents: HealEvent[]) => {
    if (!sessionId || batchState === 'running' || retryableEvents.length === 0) return;
    setBatchState('running');
    setBatchProgress({ done: 0, total: retryableEvents.length });

    let done = 0;
    for (const ev of retryableEvents) {
      handleRetryResult(ev.id, 'running');
      try {
        const res = await fetch('/api/kernel/heal/retry', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId,
            filePath: ev.file,
            errorHint: ev.errorHint || ev.detail,
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
          handleRetryResult(ev.id, 'failed', data.detail || data.error);
        } else {
          handleRetryResult(ev.id, 'success', data.detail);
        }
      } catch (err: any) {
        handleRetryResult(ev.id, 'failed', err.message);
      }
      done += 1;
      setBatchProgress({ done, total: retryableEvents.length });
    }
    setBatchState('done');
    setTimeout(() => setBatchState('idle'), 3000);
  }, [sessionId, batchState, handleRetryResult]);

  // Parse terminal journal lines for the current session
  const terminalEvents = useMemo(() => {
    if (!sessionId) return [];
    const tab = state.terminalTabs.find(t => t.id === sessionId);
    if (!tab) return [];
    return parseTerminalLines(tab.output, sessionId);
  }, [state.terminalTabs, sessionId]);

  // Parse SSE statusHistory from every assistant chat message
  const auditEvents = useMemo(() => {
    if (!sessionId) return [];
    const statuses: string[] = [];
    for (const msg of state.chatHistory) {
      if (msg.role === 'assistant' && msg.metadata?.statusHistory) {
        statuses.push(...msg.metadata.statusHistory);
      }
    }
    return parseStatusHistory(statuses, sessionId);
  }, [state.chatHistory, sessionId]);

  const allEvents = useMemo(
    () => [...terminalEvents, ...auditEvents].sort((a, b) => a.ts - b.ts).slice(-200),
    [terminalEvents, auditEvents]
  );

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [allEvents.length, autoScroll]);

  const successRate = allEvents.length
    ? Math.round((allEvents.filter(e => e.status === 'success').length / allEvents.length) * 100)
    : 0;

  const retryCount = Object.values(retryMap).filter(r => r.state === 'success').length;

  // Events eligible for batch heal: AI-failed, have a file, not already successfully retried
  const retryableEvents = useMemo(() =>
    allEvents.filter(ev =>
      ev.pass === 'ai' &&
      ev.status === 'failed' &&
      !!ev.file &&
      !!sessionId &&
      retryMap[ev.id]?.state !== 'success'
    ), [allEvents, retryMap, sessionId]);

  const batchLabel = batchState === 'running'
    ? `Healing ${batchProgress.done}/${batchProgress.total}…`
    : batchState === 'done'
      ? 'All Done!'
      : `Heal All (${retryableEvents.length})`;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 pt-4 pb-2 shrink-0">
        <div className="flex items-center gap-2">
          <ShieldCheck size={13} className="text-nexus-green" />
          <h3 className="nexus-label mb-0">Self-Healing</h3>
        </div>
        <div className="flex items-center gap-1.5">
          {/* Batch heal button — only shown when there are retryable failures */}
          {retryableEvents.length > 0 && (
            <button
              onClick={() => healAllFailed(retryableEvents)}
              disabled={batchState === 'running'}
              title="Re-run AI healer on every failed event in sequence"
              className={cn(
                'flex items-center gap-1 px-2 py-0.5 rounded border text-[8px] font-bold uppercase tracking-widest transition-all',
                batchState === 'done'
                  ? 'bg-nexus-green/15 border-nexus-green/40 text-nexus-green cursor-default'
                  : batchState === 'running'
                    ? 'bg-nexus-gold/10 border-nexus-gold/30 text-nexus-gold cursor-wait opacity-80'
                    : 'bg-red-400/10 border-red-400/30 text-red-400 hover:bg-red-400/20 hover:border-red-400/50'
              )}
            >
              {batchState === 'running'
                ? <RefreshCw size={9} className="animate-spin" />
                : batchState === 'done'
                  ? <Check size={9} />
                  : <Layers size={9} />
              }
              {batchLabel}
            </button>
          )}

          {retryCount > 0 && (
            <span className="text-[8px] font-bold tracking-widest px-1.5 py-0.5 rounded border bg-nexus-gold/10 border-nexus-gold/30 text-nexus-gold">
              {retryCount} healed
            </span>
          )}
          {allEvents.length > 0 && (
            <span className={cn(
              'text-[8px] font-bold tracking-widest px-1.5 py-0.5 rounded border',
              successRate >= 80 ? 'text-nexus-green border-nexus-green/30 bg-nexus-green/10'
              : successRate >= 50 ? 'text-nexus-gold  border-nexus-gold/30  bg-nexus-gold/10'
              : 'text-red-400 border-red-400/30 bg-red-400/10'
            )}>
              {successRate}%
            </span>
          )}
          <button
            onClick={() => setAutoScroll(v => !v)}
            title="Toggle auto-scroll"
            className={cn(
              'p-1 px-1.5 rounded border text-[8px] font-bold uppercase tracking-widest transition-all',
              autoScroll
                ? 'bg-nexus-green/10 border-nexus-green/30 text-nexus-green'
                : 'bg-white/[0.03] border-white/5 text-text-dim'
            )}
          >Live</button>
          <button
            onClick={() => setRetryMap({})}
            title="Clear retry state"
            className="p-1 rounded bg-white/[0.03] border border-white/5 text-text-dim hover:text-red-400 hover:border-red-400/30 transition-all"
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>

      {/* Stats */}
      {allEvents.length > 0 && <StatsBar events={allEvents} />}

      {/* Legend */}
      <div className="px-3 py-2 shrink-0 flex flex-wrap gap-1 border-b border-white/5">
        {Object.entries(PASS_META).map(([key, meta]) => {
          const Icon = meta.icon;
          return (
            <span key={key} className={cn('flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[8px] font-bold tracking-widest border', meta.color)}>
              <Icon size={8} /> {meta.label}
            </span>
          );
        })}
        <span className="flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[8px] font-bold tracking-widest border text-nexus-gold border-nexus-gold/20 bg-nexus-gold/5">
          <RotateCcw size={8} /> Retry Fix
        </span>
      </div>

      {/* Event stream */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto custom-scrollbar p-2 space-y-1">
        {allEvents.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-text-dim/30 select-none">
            <ShieldCheck size={28} className="mb-3 opacity-40" />
            <p className="text-[10px] uppercase tracking-widest">No healing events yet</p>
            <p className="text-[9px] mt-1.5 opacity-60 text-center px-6 leading-relaxed">
              Events appear when Nexus auto-repairs Vite errors, CSS issues, or Reviewer audit failures.
              Failed AI events show a <strong className="text-text-dim/50">Retry Fix</strong> button.
            </p>
          </div>
        ) : (
          allEvents.map(ev => (
            <HealRow
              key={ev.id}
              ev={ev}
              sessionId={sessionId || ''}
              retryOverride={retryMap[ev.id]}
              onRetryResult={handleRetryResult}
            />
          ))
        )}
      </div>

      {/* Footer */}
      {allEvents.length > 0 && (
        <div className="px-3 py-2 border-t border-white/5 shrink-0 flex items-center gap-2">
          <Clock size={9} className="text-text-dim/30" />
          <span className="text-[8px] text-text-dim/40 font-mono">
            {allEvents.length} event{allEvents.length !== 1 ? 's' : ''} · session {sessionId?.slice(-8) ?? '—'}
          </span>
        </div>
      )}
    </div>
  );
}
