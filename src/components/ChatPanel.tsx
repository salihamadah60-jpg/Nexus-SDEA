import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useNexus } from '../NexusContext';
import { motion, AnimatePresence } from 'motion/react';
import {
  Send, Zap, User, Bot, Sparkles, Copy, Check, RefreshCw, Clock,
  Trash2, Edit3, RotateCcw, ChevronDown, ChevronRight, Brain,
  Terminal, ListChecks, FolderOpen, FileCode, Camera, CheckCircle2,
  XCircle, Loader2, AlertCircle, ExternalLink, Play, KeyRound, MessageSquare,
  GitBranch, Shield, CornerDownRight
} from 'lucide-react';

const INTENT_BADGES: Record<string, { label: string; color: string }> = {
  smalltalk: { label: 'CHAT',     color: 'bg-white/5 text-text-dim border-white/10' },
  question:  { label: 'QUESTION', color: 'bg-nexus-cyan/10 text-nexus-cyan border-nexus-cyan/30' },
  command:   { label: 'COMMAND',  color: 'bg-yellow-400/10 text-yellow-400 border-yellow-400/30' },
  build:     { label: 'BUILD',    color: 'bg-nexus-gold/10 text-nexus-gold border-nexus-gold/30' },
};
import { cn } from '../utils';
import Markdown from 'react-markdown';
import { ChatMessage, ChatMessageMetadata } from '../types';

/**
 * Hydrated chat messages from MongoDB still contain the raw `[NEXUS:THOUGHT]…[/NEXUS:THOUGHT]`,
 * `[NEXUS:CHAIN]`, `[NEXUS:FILE:…]`, `[NEXUS:TERMINAL]`, `[NEXUS:SCREENSHOT]`
 * envelopes that the live parser strips into the metadata object. After a
 * browser refresh those metadata objects aren't reconstructed, so the markers
 * leak into the rendered Markdown. Strip them here so the bubble shows only
 * the human-facing prose, while the accordions below render whatever
 * metadata IS present (live messages keep both, hydrated ones just show prose).
 */
function sanitizeNexusContent(raw: string): string {
  if (!raw) return raw;
  let s = raw;
  // Multi-line blocks: [NEXUS:TAG]…[/NEXUS:TAG]
  s = s.replace(/\[NEXUS:[A-Z_]+(?::[^\]]*)?\][\s\S]*?\[\/NEXUS:[A-Z_]+\]/g, "");
  // Inline self-closing markers like [NEXUS:SCREENSHOT]ok[/NEXUS:SCREENSHOT]
  // (covered above) and stray opening tags from interrupted streams:
  s = s.replace(/\[\/?NEXUS:[A-Z_]+(?::[^\]]*)?\]/g, "");
  // Collapse 3+ blank lines that the strip can leave behind
  s = s.replace(/\n{3,}/g, "\n\n").trim();
  return s;
}

// --- Live Blackboard Panel (Phase 8.1) -----------------------------------

interface PlanStep { id: string; description: string; acceptance: string; status: string }
interface AuditEntry { step: number; passed: boolean; severity: string; issues: string[]; reviewerModel: string }
interface BlackboardTask { id: string; goal: string; plan: PlanStep[]; currentStep: number; status: string; retries: number; audits: AuditEntry[]; createdAt: number }

const STEP_STATUS_COLORS: Record<string, string> = {
  done: 'text-emerald-400',
  in_progress: 'text-nexus-gold animate-pulse',
  failed: 'text-red-400',
  todo: 'text-text-dim/30',
};

const TASK_STATUS_COLORS: Record<string, string> = {
  done: 'border-emerald-400/20 bg-emerald-400/[0.02]',
  stasis: 'border-red-400/20 bg-red-400/[0.02]',
  planning: 'border-nexus-gold/20 bg-nexus-gold/[0.02]',
  writing: 'border-nexus-cyan/20 bg-nexus-cyan/[0.02]',
  reviewing: 'border-purple-400/20 bg-purple-400/[0.02]',
  pending: 'border-white/5 bg-white/[0.01]',
  failed: 'border-red-400/20 bg-red-400/[0.02]',
};

// Phase 10.3 — running cost badge for the current session.
function CostBadge({ sessionId }: { sessionId: string }) {
  const [data, setData] = useState<{ calls: number; tokensIn: number; tokensOut: number; usd: number } | null>(null);
  useEffect(() => {
    let cancel = false;
    const poll = async () => {
      try {
        const r = await fetch(`/api/cost/session/${encodeURIComponent(sessionId)}`);
        if (!r.ok) return;
        const d = await r.json();
        if (!cancel) setData(d);
      } catch {}
    };
    poll(); const t = setInterval(poll, 8000);
    return () => { cancel = true; clearInterval(t); };
  }, [sessionId]);
  if (!data || data.calls === 0) return null;
  const tk = data.tokensIn + data.tokensOut;
  const usd = data.usd || 0;
  const compact = tk < 5000 && usd < 0.01;
  if (compact) {
    return (
      <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-nexus-cyan/10 border border-nexus-cyan/20 text-nexus-cyan" title={`${data.calls} calls · ${tk.toLocaleString()} tokens · $${usd.toFixed(5)}`}>
        <Zap size={9} />
        <span className="text-[9px] font-bold tracking-wider">{tk.toLocaleString()}</span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-3 px-2.5 py-1 rounded-md bg-nexus-cyan/[0.06] border border-nexus-cyan/20 text-nexus-cyan/80 font-mono">
      <span className="text-[9px]"><b className="text-nexus-cyan">{data.calls}</b> calls</span>
      <span className="text-[9px]"><b className="text-nexus-cyan">{(tk / 1000).toFixed(1)}k</b> tok</span>
      <span className="text-[9px]"><b className="text-nexus-cyan">${usd.toFixed(4)}</b></span>
    </div>
  );
}

function LiveBlackboardBar({ sessionId }: { sessionId: string }) {
  const [tasks, setTasks] = useState<BlackboardTask[]>([]);
  const [open, setOpen] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    const poll = async () => {
      try {
        const res = await fetch(`/api/blackboard/tasks?sessionId=${encodeURIComponent(sessionId)}`);
        if (!res.ok) return;
        const data = await res.json();
        if (!cancel) setTasks(data.tasks || []);
      } catch {}
    };
    poll();
    const t = setInterval(poll, 3000);
    return () => { cancel = true; clearInterval(t); };
  }, [sessionId]);

  const activeTasks = tasks.filter(t => !['done'].includes(t.status));
  const recentDone = tasks.filter(t => t.status === 'done').slice(-2);
  const visible = [...activeTasks, ...recentDone].slice(0, 5);

  if (visible.length === 0) return null;

  return (
    <div className="border-b border-white/5 bg-black/20 shrink-0">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center gap-2 px-4 py-2 hover:bg-white/[0.02] transition-colors"
      >
        <GitBranch size={11} className="text-nexus-gold/70 shrink-0" />
        <span className="text-[9px] font-black uppercase tracking-[0.2em] text-nexus-gold/70 flex-1 text-left">
          Blackboard Graph
        </span>
        <span className="text-[8px] font-mono text-text-dim/30">{visible.length} task{visible.length !== 1 ? 's' : ''}</span>
        {open ? <ChevronDown size={10} className="text-text-dim/30" /> : <ChevronRight size={10} className="text-text-dim/30" />}
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="px-3 pb-2 space-y-1.5 max-h-64 overflow-y-auto custom-scrollbar">
              {visible.map(task => (
                <div key={task.id} className={cn('rounded-lg border overflow-hidden', TASK_STATUS_COLORS[task.status] || 'border-white/5')}>
                  <button
                    className="w-full flex items-center gap-2 px-2.5 py-2 text-left hover:bg-white/[0.03] transition-colors"
                    onClick={() => setExpanded(expanded === task.id ? null : task.id)}
                  >
                    <div className={cn(
                      'text-[8px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded shrink-0',
                      task.status === 'done' ? 'bg-emerald-400/10 text-emerald-400' :
                      task.status === 'stasis' ? 'bg-red-400/10 text-red-400' :
                      task.status === 'writing' ? 'bg-nexus-cyan/10 text-nexus-cyan' :
                      task.status === 'reviewing' ? 'bg-purple-400/10 text-purple-400' :
                      'bg-nexus-gold/10 text-nexus-gold'
                    )}>{task.status}</div>
                    <span className="text-[10px] text-text-main/80 flex-1 truncate">{task.goal}</span>
                    {task.retries > 0 && (
                      <span className="text-[8px] text-yellow-400/70 shrink-0">{task.retries}↺</span>
                    )}
                    {task.plan.length > 0 && (
                      <span className="text-[8px] text-text-dim/40 shrink-0">
                        {task.plan.filter(s => s.status === 'done').length}/{task.plan.length}
                      </span>
                    )}
                    {expanded === task.id ? <ChevronDown size={9} className="text-text-dim/30 shrink-0" /> : <ChevronRight size={9} className="text-text-dim/30 shrink-0" />}
                  </button>

                  <AnimatePresence initial={false}>
                    {expanded === task.id && task.plan.length > 0 && (
                      <motion.div
                        initial={{ height: 0 }}
                        animate={{ height: 'auto' }}
                        exit={{ height: 0 }}
                        className="overflow-hidden border-t border-white/5"
                      >
                        <div className="px-2.5 py-2 space-y-1.5">
                          {task.plan.map((step, si) => {
                            const audit = task.audits.find(a => a.step === si);
                            return (
                              <div key={step.id} className="flex items-start gap-2">
                                <CornerDownRight size={9} className="text-text-dim/20 shrink-0 mt-1" />
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-1.5 mb-0.5">
                                    <span className="text-[8px] font-black text-text-dim/40">{step.id}</span>
                                    <span className={cn('text-[8px] font-bold uppercase', STEP_STATUS_COLORS[step.status] || 'text-text-dim/30')}>
                                      {step.status.replace('_', ' ')}
                                    </span>
                                    {audit && (
                                      <span className={cn(
                                        'text-[7px] font-black px-1 py-0.5 rounded',
                                        audit.passed ? 'bg-emerald-400/10 text-emerald-400' : 'bg-red-400/10 text-red-400'
                                      )}>
                                        {audit.passed ? '✓ PASS' : '✗ FAIL'}
                                      </span>
                                    )}
                                  </div>
                                  <p className="text-[9px] text-text-dim/60 leading-snug">{step.description}</p>
                                  {audit && !audit.passed && audit.issues.length > 0 && (
                                    <div className="mt-1 pl-2 border-l border-red-400/20 space-y-0.5">
                                      {audit.issues.slice(0, 2).map((issue, ii) => (
                                        <p key={ii} className="text-[8px] text-red-400/60 leading-tight">{issue}</p>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// -------------------------------------------------------------------------

function useAccordion(defaultOpen = false) {
  const [open, setOpen] = useState(defaultOpen);
  return { open, toggle: () => setOpen(v => !v) };
}

function Accordion({
  title, icon, children, defaultOpen = false, badge, accent = 'default'
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
  badge?: string | number;
  accent?: 'default' | 'gold' | 'cyan' | 'green' | 'red';
}) {
  const { open, toggle } = useAccordion(defaultOpen);
  const accentMap = {
    default: 'text-text-dim border-white/5 hover:border-white/10',
    gold: 'text-nexus-gold border-nexus-gold/20 hover:border-nexus-gold/30',
    cyan: 'text-nexus-cyan border-nexus-cyan/20 hover:border-nexus-cyan/30',
    green: 'text-green-400 border-green-400/20 hover:border-green-400/30',
    red: 'text-red-400 border-red-400/20 hover:border-red-400/30',
  };
  return (
    <div className={cn('rounded-xl border overflow-hidden', accentMap[accent])}>
      <button
        onClick={toggle}
        className={cn(
          'w-full flex items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-white/[0.03]',
          open && 'bg-white/[0.02]'
        )}
      >
        <span className="w-4 h-4 flex items-center justify-center opacity-80 shrink-0">
          {icon}
        </span>
        <span className="text-[10px] font-bold uppercase tracking-[0.15em] flex-1">{title}</span>
        {badge !== undefined && (
          <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-white/10 opacity-70">{badge}</span>
        )}
        <span className="w-4 h-4 flex items-center justify-center opacity-50">
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeInOut' }}
            className="overflow-hidden"
          >
            <div className="px-3 pb-3 pt-1 border-t border-white/5">
              {children}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function GhostTerminalEntry({ entry, index }: { entry: any; index: number }) {
  const [copied, setCopied] = useState(false);
  const [outputOpen, setOutputOpen] = useState(!entry.success);

  const copy = () => {
    navigator.clipboard.writeText(entry.cmd);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className={cn(
      'rounded-lg border overflow-hidden mb-2 last:mb-0',
      entry.success ? 'border-green-400/15' : 'border-red-400/20'
    )}>
      <div className="flex items-center gap-2 px-3 py-2 bg-black/30">
        {entry.success
          ? <CheckCircle2 size={11} className="text-green-400 shrink-0" />
          : <XCircle size={11} className="text-red-400 shrink-0" />
        }
        <code className={cn(
          'text-[11px] font-mono flex-1 truncate',
          entry.success ? 'text-green-400' : 'text-red-400'
        )}>
          $ {entry.retried ? entry.fixedCmd || entry.cmd : entry.cmd}
        </code>
        {entry.retried && (
          <span className="text-[9px] text-yellow-400 font-bold px-1.5 py-0.5 rounded bg-yellow-400/10 shrink-0">
            AUTO-FIXED
          </span>
        )}
        <button
          onClick={copy}
          className="p-1 rounded hover:bg-white/10 text-text-dim hover:text-white transition-colors shrink-0"
          title="Copy command"
        >
          {copied ? <Check size={11} /> : <Copy size={11} />}
        </button>
        {entry.output && (
          <button
            onClick={() => setOutputOpen(v => !v)}
            className="p-1 rounded hover:bg-white/10 text-text-dim transition-colors shrink-0"
          >
            {outputOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          </button>
        )}
      </div>
      <AnimatePresence initial={false}>
        {outputOpen && entry.output && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
          >
            <pre className="px-3 py-2 text-[10px] font-mono text-text-dim/70 whitespace-pre-wrap break-words bg-black/20 border-t border-white/5 max-h-40 overflow-y-auto custom-scrollbar">
              {entry.output.slice(0, 2000) || '(no output)'}
            </pre>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function StreamingIndicator({ metadata }: { metadata?: ChatMessageMetadata }) {
  const latestStatus = metadata?.statusHistory?.slice(-1)[0] || 'Neural synthesis in progress...';
  return (
    <div className="space-y-3 py-2">
      <div className="flex items-center gap-3">
        <div className="flex gap-1">
          {[0, 0.2, 0.4].map((delay, i) => (
            <div
              key={i}
              className="w-1.5 h-1.5 rounded-full bg-nexus-gold animate-bounce"
              style={{ animationDelay: `${delay}s` }}
            />
          ))}
        </div>
        <span className="text-[11px] font-bold text-nexus-gold/80 uppercase tracking-[0.15em] animate-pulse">
          {latestStatus}
        </span>
        {metadata?.screenshot && (
          <motion.div 
            initial={{ scale: 0 }} 
            animate={{ scale: 1 }} 
            className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-nexus-cyan/10 border border-nexus-cyan/30 text-nexus-cyan animate-pulse"
          >
            <Camera size={10} />
            <span className="text-[8px] font-bold">LIVE SNAPSHOT</span>
          </motion.div>
        )}
      </div>

      {metadata?.actionChain && metadata.actionChain.length > 0 && (
        <div className="space-y-1">
          {metadata.actionChain.map((step, i) => (
            <div key={i} className="flex items-center gap-2 text-[10px] text-text-dim/60">
              <div className="w-4 h-4 rounded-full border border-nexus-gold/30 flex items-center justify-center shrink-0">
                <span className="text-[8px] font-bold text-nexus-gold/60">{i + 1}</span>
              </div>
              <span>{step}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function NexusMessageBubble({ msg, index }: { msg: ChatMessage; index: number }) {
  const { openFileInEditor, state } = useNexus();
  const meta = msg.metadata;
  const isStreaming = meta?.streaming;

  const hasThought = !!meta?.thought;
  const hasChain = (meta?.actionChain?.length || 0) > 0;
  const hasFilesRead = (meta?.filesRead?.length || 0) > 0;
  const hasFilesModified = (meta?.filesModified?.length || 0) > 0;
  const hasTerminals = (meta?.terminals?.length || 0) > 0;
  const hasScreenshot = !!meta?.screenshot;
  const hasAnyMeta = hasThought || hasChain || hasFilesRead || hasFilesModified || hasTerminals || hasScreenshot;

  const intentBadge = meta?.intent ? INTENT_BADGES[meta.intent] : null;

  return (
    <div className="space-y-2">
      {/* Provenance row: intent + key used */}
      {(intentBadge || meta?.usedKey) && !isStreaming && (
        <div className="flex items-center gap-1.5 text-[8px] font-bold uppercase tracking-[0.15em]">
          {intentBadge && (
            <span className={cn('inline-flex items-center gap-1 px-1.5 py-0.5 rounded border', intentBadge.color)}>
              <MessageSquare size={9} /> {intentBadge.label}
            </span>
          )}
          {meta?.usedKey && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border bg-white/5 text-text-dim/70 border-white/10" title="Key used by the rotator for this response">
              <KeyRound size={9} /> {meta.usedKey}
            </span>
          )}
        </div>
      )}

      {/* Main message bubble */}
      <div className="bg-white/[0.03] border border-white/5 text-text-main rounded-2xl rounded-tl-none p-4 shadow-xl backdrop-blur-md">
        {isStreaming ? (
          <StreamingIndicator metadata={meta} />
        ) : (
          <div className="markdown-body prose-nexus text-[13px] leading-relaxed">
            <Markdown>{sanitizeNexusContent(msg.content) || '...'}</Markdown>
          </div>
        )}
      </div>

      {/* Metadata sections - only shown for assistant messages with content */}
      {!isStreaming && hasAnyMeta && (
        <div className="space-y-1.5 pl-2">
          {/* Neural Logic (Thought) */}
          {hasThought && (
            <Accordion title="Neural Logic" icon={<Brain size={11} />} accent="gold">
              <p className="text-[11px] text-text-dim/70 font-mono leading-relaxed whitespace-pre-wrap">
                {meta!.thought}
              </p>
            </Accordion>
          )}

          {/* Action Chain */}
          {hasChain && (
            <Accordion title="Action Chain" icon={<ListChecks size={11} />} badge={meta!.actionChain!.length} accent="cyan" defaultOpen>
              <div className="space-y-1.5">
                {meta!.actionChain!.map((step, i) => (
                  <div key={i} className="flex items-start gap-2">
                    <div className="w-4 h-4 rounded-full bg-nexus-cyan/10 border border-nexus-cyan/30 flex items-center justify-center shrink-0 mt-0.5">
                      <CheckCircle2 size={10} className="text-nexus-cyan" />
                    </div>
                    <span className="text-[11px] text-text-dim/80 leading-relaxed">{step}</span>
                  </div>
                ))}
              </div>
            </Accordion>
          )}

          {/* File Context */}
          {(hasFilesRead || hasFilesModified) && (
            <Accordion
              title="File Context"
              icon={<FolderOpen size={11} />}
              badge={(meta!.filesRead?.length || 0) + (meta!.filesModified?.length || 0)}
              accent="default"
            >
              <div className="space-y-3">
                {hasFilesRead && (
                  <div>
                    <p className="text-[9px] uppercase font-bold tracking-widest text-text-dim/40 mb-1.5">Files Analyzed</p>
                    <div className="space-y-1">
                      {meta!.filesRead!.map((f, i) => (
                        <div key={i} className="flex items-center gap-2 text-[11px] text-text-dim/60 font-mono">
                          <FileCode size={10} className="shrink-0 opacity-50" />
                          <span className="truncate">{f}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {hasFilesModified && (
                  <div>
                    <p className="text-[9px] uppercase font-bold tracking-widest text-text-dim/40 mb-1.5">Files Written</p>
                    <div className="space-y-1.5">
                      {meta!.filesModified!.map((f, i) => (
                        <div key={i} className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <CheckCircle2 size={10} className="text-green-400 shrink-0" />
                            <code className="text-[11px] text-green-400 font-mono truncate">{f.path}</code>
                            <span className="text-[9px] text-text-dim/30 shrink-0">
                              {(f.size / 1024).toFixed(1)}kb
                            </span>
                          </div>
                          <button
                            onClick={() => openFileInEditor(f.path)}
                            className="flex items-center gap-1 text-[9px] font-bold uppercase tracking-widest text-nexus-cyan hover:text-white transition-colors shrink-0 px-2 py-1 rounded border border-nexus-cyan/20 hover:border-nexus-cyan/40 hover:bg-nexus-cyan/5"
                            title="Open in editor"
                          >
                            <ExternalLink size={9} />
                            View
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </Accordion>
          )}

          {/* Ghost Terminal */}
          {hasTerminals && (
            <Accordion
              title="Terminal"
              icon={<Terminal size={11} />}
              badge={meta!.terminals!.length}
              accent={meta!.terminals!.every(t => t.success) ? 'green' : 'red'}
            >
              <div className="space-y-1">
                {meta!.terminals!.map((entry, i) => (
                  <GhostTerminalEntry key={i} entry={entry} index={i} />
                ))}
              </div>
            </Accordion>
          )}

          {/* Screenshot */}
          {hasScreenshot && (
            <Accordion title="Visual Verification" icon={<Camera size={11} />} accent="cyan" defaultOpen>
              <div className="rounded-lg overflow-hidden border border-nexus-cyan/20">
                <img
                  src={`/api/visual-debug/${state.currentSessionId}/${meta!.screenshot}`}
                  alt="Preview snapshot"
                  className="w-full object-cover"
                  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                />
              </div>
            </Accordion>
          )}
        </div>
      )}
    </div>
  );
}

export function ChatPanel() {
  const { state, setState, sendMessage, retryMessage, createSession, deleteMessage, editMessage } = useNexus();
  const currentSession = state.sessions.find(s => s.sessionId === state.currentSessionId);
  const [input, setInput] = useState('');
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editVal, setEditVal] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  }, [input]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [state.chatHistory, state.isAILoading]);

  const handleSend = () => {
    if (!input.trim() || state.isAILoading) return;
    if (!state.currentSessionId) createSession();
    sendMessage(input);
    setInput('');
  };

  const copyToClipboard = (text: string, index: number) => {
    navigator.clipboard.writeText(text);
    setCopiedId(index);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleDelete = (index: number) => {
    if (!window.confirm('Delete this message?')) return;
    deleteMessage(index);
  };

  const startEdit = (index: number, content: string) => {
    setEditingId(index);
    setEditVal(content);
  };

  const saveEdit = (index: number) => {
    editMessage(index, editVal);
    setEditingId(null);
  };

  return (
    <div className="flex flex-col h-full bg-bg-deep overflow-hidden relative">
      {/* Session Header */}
      <div className="px-6 py-3 border-b border-border flex items-center justify-between bg-bg-surface/50 backdrop-blur-md shrink-0">
        <div className="flex items-center gap-3">
          <div className="h-7 w-7 rounded-lg bg-nexus-gold/10 border border-nexus-gold/20 flex items-center justify-center">
            <Zap className="text-nexus-gold w-3.5 h-3.5" />
          </div>
          <div>
            <h2 className="text-[11px] font-bold text-white tracking-wide uppercase">
              {currentSession?.title || 'Neural Stream'}
            </h2>
            <p className="text-[8px] text-text-dim uppercase tracking-widest font-bold opacity-40">
              {state.selectedModel} • {state.selectedMode} • Silent Operator v7.0
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {state.currentSessionId && <CostBadge sessionId={state.currentSessionId} />}
          {state.isAILoading && (
            <div className="flex items-center gap-1.5 text-nexus-gold/70">
              <Loader2 size={12} className="animate-spin" />
              <span className="text-[9px] font-bold uppercase tracking-widest">Processing</span>
            </div>
          )}
        </div>
      </div>

      {/* Live Blackboard Graph (Phase 8.1) */}
      {state.currentSessionId && <LiveBlackboardBar sessionId={state.currentSessionId} />}

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto min-h-0 custom-scrollbar px-4 py-6 space-y-8">
        {state.chatHistory.length === 0 && !state.isAILoading && (
          <div className="flex flex-col items-center justify-center h-full text-text-dim/20">
            <Sparkles size={36} className="mb-4 opacity-40" />
            <p className="text-[11px] font-bold uppercase tracking-[0.3em]">Silent Operator Ready</p>
            <p className="text-[9px] mt-2 opacity-60 tracking-wider">Nexus builds projects from A to Z</p>
          </div>
        )}

        {state.chatHistory.map((msg, i) => (
          <div
            key={i}
            className={cn(
              'flex flex-col max-w-[92%] lg:max-w-[85%]',
              msg.role === 'user' ? 'ml-auto items-end' : 'items-start'
            )}
          >
            {/* Author row */}
            <div className={cn(
              'flex items-center gap-2 mb-2 px-1',
              msg.role === 'user' ? 'flex-row-reverse' : 'flex-row'
            )}>
              <div className={cn(
                'w-5 h-5 rounded flex items-center justify-center shadow-lg',
                msg.role === 'user'
                  ? 'bg-nexus-gold/20 text-nexus-gold border border-nexus-gold/30'
                  : 'bg-nexus-cyan/20 text-nexus-cyan border border-nexus-cyan/30'
              )}>
                {msg.role === 'user' ? <User size={10} /> : <Bot size={10} />}
              </div>
              <div className={cn('flex flex-col', msg.role === 'user' ? 'items-end' : 'items-start')}>
                <span className="text-[9px] font-bold uppercase tracking-widest text-text-main">
                  {msg.role === 'user' ? 'Operator' : 'Nexus AI'}
                </span>
                <span className="text-[8px] text-text-dim flex items-center gap-1 mt-0.5 opacity-50">
                  <Clock size={7} /> {new Date(msg.timestamp || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
            </div>

            {/* Message content */}
            {msg.role === 'user' ? (
              <div className="relative group rounded-2xl rounded-tr-none p-4 text-[13px] leading-relaxed shadow-xl mb-1 backdrop-blur-md bg-nexus-gold/10 border border-nexus-gold/20 text-white shadow-[0_10px_30px_rgba(212,175,55,0.05)]">
                {editingId === i ? (
                  <div className="flex flex-col gap-2 min-w-[200px]">
                    <textarea
                      autoFocus
                      className="w-full bg-black/40 border border-white/20 rounded p-2 text-xs text-white focus:outline-none"
                      value={editVal}
                      onChange={e => setEditVal(e.target.value)}
                      rows={3}
                    />
                    <div className="flex justify-end gap-2">
                      <button onClick={() => setEditingId(null)} className="text-[9px] uppercase font-bold text-text-dim">Cancel</button>
                      <button onClick={() => saveEdit(i)} className="text-[9px] uppercase font-bold text-nexus-gold">Save</button>
                    </div>
                  </div>
                ) : (
                  <p className="text-[13px] text-white">{msg.content}</p>
                )}
              </div>
            ) : (
              <NexusMessageBubble msg={msg} index={i} />
            )}

            {/* Action row */}
            <div className={cn(
              'flex items-center gap-2 px-1 mt-1 opacity-60 hover:opacity-100 transition-opacity',
              msg.role === 'user' ? 'flex-row-reverse' : 'flex-row'
            )}>
              {msg.role === 'user' && (
                <button
                  onClick={() => retryMessage(i)}
                  className="p-1.5 rounded hover:bg-white/5 text-text-dim hover:text-nexus-gold transition-colors"
                  title="Retry"
                >
                  <RotateCcw size={11} />
                </button>
              )}
              <button
                onClick={() => copyToClipboard(msg.content, i)}
                className="p-1.5 rounded hover:bg-white/5 text-text-dim hover:text-nexus-cyan transition-colors"
                title="Copy"
              >
                {copiedId === i ? <Check size={11} /> : <Copy size={11} />}
              </button>
              {msg.role === 'user' && (
                <button
                  onClick={() => startEdit(i, msg.content)}
                  className="p-1.5 rounded hover:bg-white/5 text-text-dim hover:text-nexus-gold transition-colors"
                  title="Edit"
                >
                  <Edit3 size={11} />
                </button>
              )}
              <button
                onClick={() => handleDelete(i)}
                className="p-1.5 rounded hover:bg-white/5 text-text-dim hover:text-red-400 transition-colors"
                title="Delete"
              >
                <Trash2 size={11} />
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Input */}
      <div className="p-4 bg-bg-surface/50 backdrop-blur-xl border-t border-border shrink-0">
        <div className="max-w-4xl mx-auto relative">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder={state.isAILoading ? 'Nexus is working...' : 'Instruct Nexus AI...'}
            rows={1}
            disabled={state.isAILoading}
            className="w-full bg-nexus-black/50 border-none rounded-2xl px-4 py-3 pr-14 text-[13px] text-white focus:outline-none focus:ring-1 focus:ring-nexus-gold/20 transition-all custom-scrollbar resize-none shadow-inner min-h-[44px] disabled:opacity-50"
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || state.isAILoading}
            className="absolute right-3 bottom-1.5 h-9 w-9 flex items-center justify-center rounded-xl bg-nexus-gold text-bg-deep shadow-[0_0_20px_rgba(212,175,55,0.3)] hover:scale-105 active:scale-95 disabled:opacity-20 disabled:scale-100 transition-all"
          >
            {state.isAILoading ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
          </button>
        </div>
        <p className="text-center text-[8px] text-text-dim/20 mt-2 font-medium uppercase tracking-[0.1em]">
          Cmd/Ctrl+Enter to Send • Silent Operator Protocol Active • Code written directly to files
        </p>
      </div>
    </div>
  );
}
