import React, { useState, useEffect, useCallback } from 'react';
import { Globe, RotateCw, ExternalLink, X, Monitor, Tablet, Smartphone, Play, Loader2, Square, RefreshCw, AlertCircle, Box, Cpu } from 'lucide-react';
import { useNexus } from '../NexusContext';
import { cn } from '../utils';

interface Props { isOpen: boolean; setIsOpen: (o: boolean) => void; }

type AutopilotStatus = 'IDLE' | 'INSTALLING' | 'STARTING' | 'READY' | 'ERROR';
type SandboxMode = 'local' | 'e2b' | null;

export function PreviewPanel({ isOpen, setIsOpen }: Props) {
  const { state } = useNexus();
  const [refreshKey, setRefreshKey] = useState(0);
  const [device, setDevice] = useState<'desktop' | 'tablet' | 'mobile'>('desktop');
  const [autopilotStatus, setAutopilotStatus] = useState<AutopilotStatus>('IDLE');
  const [autopilotPort, setAutopilotPort] = useState(3001);
  const [booting, setBooting] = useState(false);
  const [hasStatic, setHasStatic] = useState(false);
  const [previewMode, setPreviewMode] = useState<'auto' | 'static' | 'autopilot'>('auto');
  const [sandboxMode, setSandboxMode] = useState<SandboxMode>(null);

  useEffect(() => { setRefreshKey(k => k + 1); }, [state.previewVersion]);

  const probeStatic = useCallback(async () => {
    if (!state.currentSessionId) { setHasStatic(false); return; }
    try {
      const r = await fetch(`/sandbox-preview/${state.currentSessionId}/index.html`, { method: 'HEAD' });
      setHasStatic(r.ok);
    } catch { setHasStatic(false); }
  }, [state.currentSessionId]);

  const pollStatus = useCallback(async () => {
    if (!state.currentSessionId) return;
    try {
      const res = await fetch(`/api/autopilot/status/${state.currentSessionId}`);
      if (res.ok) {
        const data = await res.json();
        setAutopilotStatus(data.status || 'IDLE');
        setAutopilotPort(data.port || 3001);
        if (data.status === 'READY') {
          setRefreshKey(k => k + 1);
        }
      }
    } catch {}
  }, [state.currentSessionId]);

  // Fetch sandbox mode once from /api/status (updated every 5 min server-side).
  const fetchSandboxMode = useCallback(async () => {
    try {
      const res = await fetch('/api/status');
      if (res.ok) {
        const data = await res.json();
        setSandboxMode(data.sandbox ?? 'local');
      }
    } catch {}
  }, []);

  useEffect(() => {
    if (!isOpen || !state.currentSessionId) return;
    pollStatus();
    probeStatic();
    fetchSandboxMode();
    const interval = setInterval(() => { pollStatus(); probeStatic(); }, 3000);
    const modeInterval = setInterval(fetchSandboxMode, 5 * 60 * 1000);
    return () => { clearInterval(interval); clearInterval(modeInterval); };
  }, [isOpen, state.currentSessionId, pollStatus, probeStatic, fetchSandboxMode]);

  const handleBoot = async () => {
    if (!state.currentSessionId || booting) return;
    setBooting(true);
    setAutopilotStatus('INSTALLING');
    try {
      await fetch(`/api/autopilot/boot/${state.currentSessionId}`, { method: 'POST' });
    } catch {}
    setBooting(false);
  };

  const handleKill = async () => {
    if (!state.currentSessionId) return;
    try {
      await fetch(`/api/autopilot/kill/${state.currentSessionId}`, { method: 'POST' });
      setAutopilotStatus('IDLE');
    } catch {}
  };

  if (!isOpen || !state.currentSessionId) return null;

  const useStatic =
    previewMode === 'static' ||
    (previewMode === 'auto' && hasStatic && autopilotStatus !== 'READY');
  const previewUrl = useStatic
    ? `/sandbox-preview/${state.currentSessionId}/`
    : `/api/preview/${state.currentSessionId}/`;

  const statusConfig = {
    IDLE:       { color: 'text-text-dim/40',   dot: 'bg-text-dim/20',  label: 'Idle' },
    INSTALLING: { color: 'text-yellow-400',    dot: 'bg-yellow-400',   label: 'Installing deps...' },
    STARTING:   { color: 'text-nexus-cyan',    dot: 'bg-nexus-cyan',   label: 'Starting server...' },
    READY:      { color: 'text-green-400',     dot: 'bg-green-400',    label: `Ready :${autopilotPort}` },
    ERROR:      { color: 'text-red-400',       dot: 'bg-red-400',      label: 'Error' },
  };

  const cfg = statusConfig[autopilotStatus];
  const isLoading = autopilotStatus === 'INSTALLING' || autopilotStatus === 'STARTING';
  const isError = autopilotStatus === 'ERROR';

  return (
    <div className="flex w-[420px] shrink-0 h-full flex-col bg-[#030306] border-l border-border animate-in slide-in-from-right duration-200">
      {/* Header */}
      <div className="flex h-10 items-center justify-between border-b border-border bg-bg-surface px-4 shrink-0">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 text-nexus-cyan text-[11px] font-bold uppercase tracking-widest">
            <Globe size={13} />
            <span>Live Preview</span>
          </div>
          <div className="flex items-center gap-0.5 bg-white/5 rounded-md p-0.5">
            {([['desktop', Monitor], ['tablet', Tablet], ['mobile', Smartphone]] as const).map(([id, Icon]) => (
              <button
                key={id}
                onClick={() => setDevice(id)}
                className={cn('p-1 rounded transition-colors', device === id ? 'bg-nexus-cyan/20 text-nexus-cyan' : 'text-text-dim/50 hover:text-text-dim')}
              >
                <Icon size={11} />
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2.5">
          <button onClick={() => setRefreshKey(k => k + 1)} className="text-text-dim/50 hover:text-white transition-colors" title="Reload preview">
            <RotateCw size={13} />
          </button>
          <a href={previewUrl} target="_blank" rel="noreferrer" className="text-text-dim/50 hover:text-white transition-colors" title="Open in new tab">
            <ExternalLink size={13} />
          </a>
          <button onClick={() => setIsOpen(false)} className="text-text-dim/50 hover:text-white transition-colors">
            <X size={15} />
          </button>
        </div>
      </div>

      {/* Status Bar */}
      <div className="flex items-center justify-between px-4 py-1.5 bg-bg-surface/30 border-b border-border/50">
        <div className="flex items-center gap-2">
          {isLoading
            ? <Loader2 size={8} className={cn('animate-spin shrink-0', cfg.color)} />
            : <div className={cn('w-1.5 h-1.5 rounded-full shrink-0', cfg.dot, isLoading && 'animate-pulse')} />
          }
          <span className={cn('text-[9px] font-bold uppercase tracking-widest', cfg.color)}>
            {cfg.label}
          </span>
          {/* Sandbox mode badge */}
          {sandboxMode && (
            <span
              title={sandboxMode === 'e2b' ? 'Running in E2B remote sandbox' : 'Running in local sandbox mode'}
              className={cn(
                'ml-1 flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[7px] font-bold uppercase tracking-widest border',
                sandboxMode === 'e2b'
                  ? 'text-violet-400 border-violet-400/30 bg-violet-400/5'
                  : 'text-emerald-400 border-emerald-400/30 bg-emerald-400/5'
              )}
            >
              {sandboxMode === 'e2b' ? <Cpu size={7} /> : <Box size={7} />}
              {sandboxMode === 'e2b' ? 'E2B' : 'Local'}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {autopilotStatus === 'READY' && (
            <button
              onClick={handleKill}
              className="flex items-center gap-1 text-[9px] font-bold text-red-400/70 hover:text-red-400 transition-colors px-2 py-0.5 rounded border border-red-400/20 hover:border-red-400/30"
              title="Stop server"
            >
              <Square size={8} /> Stop
            </button>
          )}
          {isError && (
            <button
              onClick={handleBoot}
              disabled={booting}
              className="flex items-center gap-1 text-[9px] font-bold text-red-400 hover:text-white transition-colors px-2 py-0.5 rounded border border-red-400/40 hover:border-red-400/70 hover:bg-red-400/10 disabled:opacity-50"
              title="Retry dev server"
            >
              <RefreshCw size={8} /> Retry
            </button>
          )}
          {autopilotStatus === 'IDLE' && (
            <button
              onClick={handleBoot}
              disabled={booting}
              className="flex items-center gap-1 text-[9px] font-bold text-nexus-gold hover:text-white transition-colors px-2 py-0.5 rounded border border-nexus-gold/30 hover:border-nexus-gold/50 hover:bg-nexus-gold/5 disabled:opacity-50"
              title="Boot preview server"
            >
              <Play size={8} /> Boot
            </button>
          )}
          {isLoading && (
            <span className="text-[8px] text-text-dim/40 uppercase tracking-widest animate-pulse">
              Please wait...
            </span>
          )}
        </div>
      </div>

      {/* Source toggle */}
      <div className="flex items-center justify-between px-4 py-1 bg-bg-surface/20 border-b border-border/30">
        <span className="text-[8px] uppercase tracking-widest text-text-dim/50">
          Source: <span className={cn('font-bold', useStatic ? 'text-emerald-400' : 'text-nexus-cyan')}>
            {useStatic ? 'Sandbox (static)' : 'Autopilot (dev server)'}
          </span>
          {hasStatic && previewMode === 'auto' && (
            <span className="ml-2 text-text-dim/30">· static detected</span>
          )}
        </span>
        <div className="flex items-center gap-0.5 bg-white/5 rounded p-0.5">
          {(['auto', 'static', 'autopilot'] as const).map(m => (
            <button
              key={m}
              onClick={() => setPreviewMode(m)}
              className={cn(
                'px-1.5 py-0.5 rounded text-[8px] font-bold uppercase tracking-widest transition-colors',
                previewMode === m ? 'bg-nexus-gold/20 text-nexus-gold' : 'text-text-dim/40 hover:text-text-dim'
              )}
            >
              {m}
            </button>
          ))}
        </div>
      </div>

      {/* Preview Area */}
      <div className="flex-1 overflow-hidden flex items-center justify-center bg-[#030306] p-3">
        {(autopilotStatus === 'READY' || useStatic) ? (
          <div className={cn(
            'bg-white overflow-hidden transition-all duration-300 shadow-[0_20px_60px_rgba(0,0,0,0.6)]',
            device === 'desktop' && 'w-full h-full rounded-none',
            device === 'tablet'  && 'w-[500px] max-w-full max-h-full rounded-2xl border-[6px] border-zinc-800',
            device === 'mobile'  && 'w-[320px] h-[580px] max-h-full rounded-[2.5rem] border-[10px] border-zinc-800',
          )}>
            <iframe
              key={refreshKey}
              src={previewUrl}
              className="w-full h-full border-none"
              title="Nexus Sandbox Preview"
              referrerPolicy="no-referrer"
            />
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center gap-6 text-center max-w-xs">
            {isError ? (
              <div className="w-16 h-16 rounded-2xl border border-red-400/20 flex items-center justify-center bg-red-400/5">
                <AlertCircle size={28} className="text-red-400/80" />
              </div>
            ) : isLoading ? (
              <div className="relative">
                <div className="w-12 h-12 rounded-2xl border border-nexus-gold/20 flex items-center justify-center bg-nexus-gold/5">
                  <Loader2 size={20} className="animate-spin text-nexus-gold" />
                </div>
              </div>
            ) : (
              <Globe size={32} className="text-text-dim/20" />
            )}
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-text-main mb-1.5">
                {isError ? 'Dev Server Error' :
                 autopilotStatus === 'INSTALLING' ? 'Installing Dependencies' :
                 autopilotStatus === 'STARTING' ? 'Starting Dev Server' :
                 'Preview Not Running'}
              </p>
              <p className="text-[10px] text-text-dim/40 leading-relaxed">
                {isError
                  ? 'The dev server failed to start. Check the terminal for details.'
                  : isLoading
                  ? 'Nexus Autopilot is preparing your project...'
                  : 'Build a project in the chat panel. Nexus will auto-start the preview, or click Boot manually.'}
              </p>
            </div>
            {isError && (
              <div className="flex flex-col items-center gap-2 w-full">
                <button
                  onClick={handleBoot}
                  disabled={booting}
                  className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-red-500/10 border border-red-400/40 text-red-400 hover:bg-red-500/20 hover:border-red-400/70 hover:text-red-300 text-[11px] font-bold uppercase tracking-widest active:scale-95 transition-all disabled:opacity-50"
                >
                  <RefreshCw size={12} className={booting ? 'animate-spin' : ''} />
                  {booting ? 'Retrying...' : 'Retry Dev Server'}
                </button>
                <p className="text-[9px] text-text-dim/30 uppercase tracking-widest">
                  Check the terminal tab for error details
                </p>
              </div>
            )}
            {autopilotStatus === 'IDLE' && (
              <button
                onClick={handleBoot}
                disabled={booting}
                className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-nexus-gold text-bg-deep text-[11px] font-bold uppercase tracking-widest hover:scale-105 active:scale-95 transition-all disabled:opacity-50 shadow-[0_0_20px_rgba(212,175,55,0.2)]"
              >
                <Play size={12} />
                Boot Preview Server
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
