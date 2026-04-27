import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useNexus } from '../NexusContext';
import { motion, AnimatePresence } from 'motion/react';
import {
  Send, Zap, User, Bot, Sparkles, Copy, Check, RefreshCw, Clock,
  Trash2, Edit3, RotateCcw, ChevronDown, ChevronRight, Brain,
  Terminal, ListChecks, FolderOpen, FileCode, Camera, CheckCircle2,
  XCircle, Loader2, AlertCircle, ExternalLink, Play, KeyRound, MessageSquare,
  GitBranch, Shield, CornerDownRight, Lightbulb, BookOpen, Pencil,
  FlaskConical, Eye, ArrowRight, X, Maximize2, GitCommit, LayoutList, FileDiff,
} from 'lucide-react';
import { cn } from '../utils';
import Markdown from 'react-markdown';
import { ChatMessage, ChatMessageMetadata, TerminalEntry, FileWriteEntry } from '../types';

const INTENT_BADGES: Record<string, { label: string; color: string }> = {
  smalltalk: { label: 'CHAT',     color: 'bg-white/5 text-text-dim border-white/10' },
  question:  { label: 'QUESTION', color: 'bg-nexus-cyan/10 text-nexus-cyan border-nexus-cyan/30' },
  command:   { label: 'COMMAND',  color: 'bg-yellow-400/10 text-yellow-400 border-yellow-400/30' },
  build:     { label: 'BUILD',    color: 'bg-nexus-gold/10 text-nexus-gold border-nexus-gold/30' },
};

function sanitizeNexusContent(raw: string): string {
  if (!raw) return raw;
  let s = raw;
  s = s.replace(/\[NEXUS:[A-Z_]+(?::[^\]]*)?\][\s\S]*?\[\/NEXUS:[A-Z_]+\]/g, '');
  s = s.replace(/\[\/?NEXUS:[A-Z_]+(?::[^\]]*)?\]/g, '');
  s = s.replace(/\n{3,}/g, '\n\n').trim();
  return s;
}

// ─── Phase labels (13.4) ────────────────────────────────────────────────────
const PHASE_META: Record<string, { label: string; icon: any; color: string }> = {
  reading:    { label: 'Reading',    icon: BookOpen,    color: 'text-nexus-cyan/70' },
  planning:   { label: 'Planning',   icon: LayoutList,  color: 'text-nexus-gold/70' },
  executing:  { label: 'Executing',  icon: Play,        color: 'text-violet-400/70' },
  verifying:  { label: 'Verifying',  icon: FlaskConical,color: 'text-yellow-400/70' },
  confirmed:  { label: 'Confirmed',  icon: CheckCircle2,color: 'text-nexus-green/70' },
  summarising:{ label: 'Summary',    icon: ArrowRight,  color: 'text-text-dim/50' },
};

function PhaseLabel({ phase }: { phase: string }) {
  const meta = PHASE_META[phase.toLowerCase()];
  if (!meta) return null;
  const Icon = meta.icon;
  return (
    <div className={cn('flex items-center gap-1.5 py-1', meta.color)}>
      <Icon size={9} />
      <span className="text-[8px] font-black uppercase tracking-[0.2em]">{meta.label}</span>
      <div className="flex-1 h-px bg-current opacity-10" />
    </div>
  );
}

// ─── Thinking block (13.2) ──────────────────────────────────────────────────
function ThinkingBlock({ content, ms }: { content: string; ms?: number }) {
  const [open, setOpen] = useState(false);
  const secs = ms ? Math.round(ms / 1000) : null;
  return (
    <div className="rounded-xl border border-nexus-gold/15 bg-nexus-gold/[0.03] overflow-hidden mb-2">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-white/[0.02] transition-colors text-left"
      >
        <Brain size={10} className="text-nexus-gold/60 shrink-0" />
        <span className="text-[9px] font-bold uppercase tracking-[0.18em] text-nexus-gold/60 flex-1">
          Thought{secs !== null ? ` for ${secs}s` : ''}
        </span>
        {open ? <ChevronDown size={10} className="text-text-dim/30" /> : <ChevronRight size={10} className="text-text-dim/30" />}
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="overflow-hidden"
          >
            <div className="px-3 pb-3 pt-0 border-t border-nexus-gold/10">
              <p className="text-[11px] text-text-dim/60 font-mono leading-relaxed whitespace-pre-wrap italic">
                {content}
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Action cards (13.1) ────────────────────────────────────────────────────
function ReadFileGroup({ paths, onOpen }: { paths: string[]; onOpen: (p: string) => void }) {
  const [expanded, setExpanded] = useState(paths.length <= 2);

  if (paths.length === 0) return null;

  if (paths.length <= 2) {
    return (
      <div className="space-y-1 mb-1">
        {paths.map((p, i) => (
          <div key={i} className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg border border-white/5 bg-white/[0.02] group">
            <FileCode size={10} className="text-nexus-cyan/50 shrink-0" />
            <span className="text-[10px] font-mono text-text-dim/60 truncate flex-1">{p}</span>
            <button
              onClick={() => onOpen(p)}
              className="flex items-center gap-1 text-[8px] font-bold uppercase tracking-widest text-nexus-cyan/60 hover:text-nexus-cyan px-1.5 py-0.5 rounded border border-nexus-cyan/20 hover:border-nexus-cyan/40 transition-colors"
            >
              <ExternalLink size={8} /> Open
            </button>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="mb-1 rounded-xl border border-white/5 bg-white/[0.02] overflow-hidden">
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center gap-2 px-2.5 py-2 hover:bg-white/[0.02] transition-colors"
      >
        <BookOpen size={10} className="text-nexus-cyan/50 shrink-0" />
        <span className="text-[9px] font-bold uppercase tracking-[0.15em] text-text-dim/50 flex-1 text-left">
          {paths.length} files read
        </span>
        {expanded ? <ChevronDown size={9} className="text-text-dim/30" /> : <ChevronRight size={9} className="text-text-dim/30" />}
      </button>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="overflow-hidden border-t border-white/5"
          >
            <div className="p-2 space-y-1">
              {paths.map((p, i) => (
                <div key={i} className="flex items-center gap-2 px-2 py-1 rounded group">
                  <FileCode size={9} className="text-nexus-cyan/40 shrink-0" />
                  <span className="text-[10px] font-mono text-text-dim/55 truncate flex-1">{p}</span>
                  <button
                    onClick={() => onOpen(p)}
                    className="text-[8px] text-nexus-cyan/50 hover:text-nexus-cyan transition-colors"
                  >
                    <ExternalLink size={8} />
                  </button>
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Inline diff viewer (13.3 / issue #5) ────────────────────────────────────
function computeLineDiff(before: string, after: string): Array<{ type: 'eq' | 'del' | 'ins'; text: string }> {
  const a = before.split('\n');
  const b = after.split('\n');
  const out: Array<{ type: 'eq' | 'del' | 'ins'; text: string }> = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push({ type: 'eq', text: a[i] }); i++; j++;
    } else if (i >= a.length) {
      out.push({ type: 'ins', text: b[j++] });
    } else if (j >= b.length) {
      out.push({ type: 'del', text: a[i++] });
    } else {
      let matched = false;
      for (let d = 1; d <= 10; d++) {
        if (i + d < a.length && a[i + d] === b[j]) {
          for (let k = 0; k < d; k++) out.push({ type: 'del', text: a[i + k] });
          i += d; matched = true; break;
        }
        if (j + d < b.length && a[i] === b[j + d]) {
          for (let k = 0; k < d; k++) out.push({ type: 'ins', text: b[j + k] });
          j += d; matched = true; break;
        }
      }
      if (!matched) { out.push({ type: 'del', text: a[i++] }); out.push({ type: 'ins', text: b[j++] }); }
    }
  }
  return out;
}

type RevertState = 'idle' | 'confirm' | 'reverting' | 'done' | 'error';

function DiffModal({
  file,
  sessionId,
  onClose,
}: {
  file: FileWriteEntry;
  sessionId: string;
  onClose: () => void;
}) {
  const [afterContent, setAfterContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [copyFlash, setCopyFlash] = useState(false);
  const [revertState, setRevertState] = useState<RevertState>('idle');

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`/api/files/content?sessionId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(file.path)}`);
        if (r.ok) { const d = await r.json(); setAfterContent(d.content || ''); }
        else setAfterContent('');
      } catch { setAfterContent(''); }
      finally { setLoading(false); }
    })();
  }, [file.path, sessionId]);

  const before = file.beforeContent ?? '';
  const after = afterContent ?? '';
  const diff = !loading ? computeLineDiff(before, after) : [];

  const added   = diff.filter(l => l.type === 'ins').length;
  const removed = diff.filter(l => l.type === 'del').length;

  const handleCopyDiff = () => {
    if (!diff.length) return;
    const text = diff.map(l =>
      `${l.type === 'del' ? '-' : l.type === 'ins' ? '+' : ' '} ${l.text}`
    ).join('\n');
    navigator.clipboard.writeText(`--- ${file.path} (before)\n+++ ${file.path} (after)\n${text}`)
      .then(() => { setCopyFlash(true); setTimeout(() => setCopyFlash(false), 1500); })
      .catch(() => {});
  };

  const handleRevert = async () => {
    if (revertState === 'idle') { setRevertState('confirm'); return; }
    if (revertState === 'confirm') {
      setRevertState('reverting');
      try {
        const r = await fetch('/api/files', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId, path: file.path, content: before }),
        });
        if (r.ok) {
          setRevertState('done');
          setTimeout(() => onClose(), 1200);
        } else {
          setRevertState('error');
          setTimeout(() => setRevertState('idle'), 2500);
        }
      } catch {
        setRevertState('error');
        setTimeout(() => setRevertState('idle'), 2500);
      }
    }
  };

  const canRevert = !!before && !!sessionId && !loading;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[9999] bg-black/80 flex items-center justify-center p-6"
      onClick={revertState === 'confirm' ? () => setRevertState('idle') : onClose}
    >
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.95, opacity: 0 }}
        transition={{ duration: 0.18 }}
        className="bg-bg-surface border border-white/10 rounded-2xl overflow-hidden shadow-2xl w-full max-w-3xl max-h-[80vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-white/10 shrink-0">
          <FileDiff size={12} className="text-nexus-cyan/70" />
          <code className="text-[11px] font-mono text-text-main flex-1 truncate">{file.path}</code>
          <span className="text-[9px] text-nexus-green font-bold">+{added}</span>
          <span className="text-[9px] text-text-dim/30 mx-1">/</span>
          <span className="text-[9px] text-red-400 font-bold">-{removed}</span>

          {/* ── Copy Diff ── */}
          {!loading && diff.length > 0 && (
            <button
              onClick={handleCopyDiff}
              title="Copy unified diff to clipboard"
              className={cn(
                'flex items-center gap-1 px-2 py-0.5 rounded border text-[8px] font-bold uppercase tracking-widest transition-all',
                copyFlash
                  ? 'bg-nexus-green/15 border-nexus-green/40 text-nexus-green'
                  : 'bg-white/[0.04] border-white/10 text-text-dim/60 hover:text-nexus-cyan hover:border-nexus-cyan/30 hover:bg-nexus-cyan/5'
              )}
            >
              {copyFlash ? <Check size={9} /> : <Copy size={9} />}
              {copyFlash ? 'Copied!' : 'Copy Diff'}
            </button>
          )}

          {/* ── Revert File ── */}
          {canRevert && (
            <div className="flex items-center gap-1">
              {revertState === 'confirm' ? (
                <>
                  <span className="text-[8px] text-red-400/80 font-bold tracking-widest">Restore original?</span>
                  <button
                    onClick={handleRevert}
                    className="flex items-center gap-1 px-2 py-0.5 rounded border text-[8px] font-bold uppercase tracking-widest bg-red-400/15 border-red-400/50 text-red-400 hover:bg-red-400/25 transition-all"
                  >
                    <RotateCcw size={9} /> Confirm
                  </button>
                  <button
                    onClick={() => setRevertState('idle')}
                    className="px-2 py-0.5 rounded border text-[8px] font-bold uppercase tracking-widest bg-white/5 border-white/10 text-text-dim/50 hover:text-white transition-all"
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  onClick={handleRevert}
                  disabled={revertState === 'reverting' || revertState === 'done'}
                  title="Restore file to its state before Nexus last wrote it"
                  className={cn(
                    'flex items-center gap-1 px-2 py-0.5 rounded border text-[8px] font-bold uppercase tracking-widest transition-all',
                    revertState === 'done'
                      ? 'bg-nexus-green/15 border-nexus-green/40 text-nexus-green cursor-default'
                    : revertState === 'reverting'
                      ? 'bg-nexus-gold/10 border-nexus-gold/30 text-nexus-gold cursor-wait opacity-70'
                    : revertState === 'error'
                      ? 'bg-red-400/10 border-red-400/30 text-red-400'
                    : 'bg-white/[0.04] border-white/10 text-text-dim/60 hover:text-red-400 hover:border-red-400/30 hover:bg-red-400/5'
                  )}
                >
                  {revertState === 'reverting' ? <Loader2 size={9} className="animate-spin" /> :
                   revertState === 'done'      ? <Check size={9} /> :
                   revertState === 'error'     ? <AlertCircle size={9} /> :
                   <RotateCcw size={9} />}
                  {revertState === 'done'    ? 'Reverted!' :
                   revertState === 'reverting' ? 'Reverting…' :
                   revertState === 'error'   ? 'Failed' : 'Revert File'}
                </button>
              )}
            </div>
          )}

          <button onClick={onClose} className="p-1 rounded hover:bg-white/10 text-text-dim/40 hover:text-white transition-colors ml-1">
            <X size={12} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto custom-scrollbar">
          {loading ? (
            <div className="flex items-center justify-center h-32 text-text-dim/40">
              <Loader2 size={16} className="animate-spin mr-2" />
              <span className="text-[11px]">Loading diff…</span>
            </div>
          ) : diff.length === 0 ? (
            <div className="flex items-center justify-center h-32 text-text-dim/30 text-[11px]">No changes detected</div>
          ) : (
            <div className="font-mono text-[10px] leading-relaxed">
              {diff.map((line, idx) => (
                <div
                  key={idx}
                  className={cn(
                    'px-4 py-0.5 whitespace-pre-wrap break-all',
                    line.type === 'del' ? 'bg-red-400/[0.08] text-red-400/90' :
                    line.type === 'ins' ? 'bg-nexus-green/[0.08] text-nexus-green/90' :
                    'text-text-dim/50'
                  )}
                >
                  <span className="select-none mr-3 opacity-40">
                    {line.type === 'del' ? '−' : line.type === 'ins' ? '+' : ' '}
                  </span>
                  {line.text}
                </div>
              ))}
            </div>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}

function WriteFileCard({
  file,
  sessionId,
  onOpen,
}: {
  file: FileWriteEntry;
  sessionId?: string;
  onOpen: (p: string) => void;
}) {
  const [showDiff, setShowDiff] = useState(false);
  const kb = (file.size / 1024).toFixed(1);
  const hasDiff = !!file.beforeContent && !!sessionId;
  return (
    <>
      <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg border border-nexus-green/15 bg-nexus-green/[0.03] group mb-1">
        <CheckCircle2 size={10} className="text-nexus-green/70 shrink-0" />
        <code className="text-[10px] font-mono text-nexus-green/80 truncate flex-1">{file.path}</code>
        <span className="text-[9px] text-text-dim/30 shrink-0">{kb}kb</span>
        {hasDiff && (
          <button
            onClick={() => setShowDiff(true)}
            className="flex items-center gap-1 text-[8px] font-bold uppercase tracking-widest text-nexus-gold/70 hover:text-nexus-gold px-1.5 py-0.5 rounded border border-nexus-gold/20 hover:border-nexus-gold/40 shrink-0 transition-colors"
          >
            <FileDiff size={8} /> Diff
          </button>
        )}
        <button
          onClick={() => onOpen(file.path)}
          className="flex items-center gap-1 text-[8px] font-bold uppercase tracking-widest text-nexus-cyan/70 hover:text-nexus-cyan px-1.5 py-0.5 rounded border border-nexus-cyan/20 hover:border-nexus-cyan/40 shrink-0 transition-colors"
        >
          <ExternalLink size={8} /> Open
        </button>
      </div>
      <AnimatePresence>
        {showDiff && sessionId && (
          <DiffModal file={file} sessionId={sessionId} onClose={() => setShowDiff(false)} />
        )}
      </AnimatePresence>
    </>
  );
}

function RunShellCard({ entry }: { entry: TerminalEntry }) {
  const [open, setOpen] = useState(!entry.success);
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(entry.cmd);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div className={cn(
      'rounded-lg border overflow-hidden mb-1',
      entry.success ? 'border-nexus-green/15 bg-nexus-green/[0.02]' : 'border-red-400/20 bg-red-400/[0.02]'
    )}>
      <div className="flex items-center gap-2 px-2.5 py-1.5">
        {entry.success
          ? <CheckCircle2 size={10} className="text-nexus-green/70 shrink-0" />
          : <XCircle size={10} className="text-red-400/70 shrink-0" />
        }
        <code className={cn(
          'text-[10px] font-mono flex-1 truncate',
          entry.success ? 'text-nexus-green/80' : 'text-red-400/80'
        )}>
          $ {entry.retried ? (entry.fixedCmd || entry.cmd) : entry.cmd}
        </code>
        {entry.retried && (
          <span className="text-[8px] text-yellow-400 font-bold px-1 py-0.5 rounded bg-yellow-400/10 shrink-0">
            AUTO-FIXED
          </span>
        )}
        <button onClick={copy} className="p-1 rounded hover:bg-white/10 text-text-dim hover:text-white transition-colors shrink-0">
          {copied ? <Check size={9} /> : <Copy size={9} />}
        </button>
        {entry.output && (
          <button onClick={() => setOpen(v => !v)} className="p-1 rounded hover:bg-white/10 text-text-dim transition-colors shrink-0">
            {open ? <ChevronDown size={9} /> : <ChevronRight size={9} />}
          </button>
        )}
      </div>
      <AnimatePresence initial={false}>
        {open && entry.output && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.12 }}
            className="overflow-hidden"
          >
            <pre className="px-2.5 py-2 text-[9px] font-mono text-text-dim/60 whitespace-pre-wrap break-words bg-black/20 border-t border-white/5 max-h-36 overflow-y-auto custom-scrollbar">
              {entry.output.slice(0, 2000) || '(no output)'}
            </pre>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Inline screenshot with lightbox (13.5) ─────────────────────────────────
function InlineScreenshot({ sessionId, filename }: { sessionId: string; filename: string }) {
  const [lightbox, setLightbox] = useState(false);
  const [open, setOpen] = useState(true);
  const src = `/api/visual-debug/${sessionId}/${filename}`;
  return (
    <>
      <div className="rounded-xl border border-nexus-cyan/15 overflow-hidden mb-1">
        <button
          onClick={() => setOpen(v => !v)}
          className="w-full flex items-center gap-2 px-2.5 py-2 hover:bg-white/[0.02] transition-colors text-left"
        >
          <Camera size={10} className="text-nexus-cyan/60 shrink-0" />
          <span className="text-[9px] font-bold uppercase tracking-[0.15em] text-nexus-cyan/60 flex-1">
            Visual Verification
          </span>
          <button
            onClick={e => { e.stopPropagation(); setLightbox(true); }}
            className="p-1 rounded hover:bg-white/10 text-text-dim/40 hover:text-nexus-cyan transition-colors"
            title="Full screen"
          >
            <Maximize2 size={9} />
          </button>
          {open ? <ChevronDown size={9} className="text-text-dim/30" /> : <ChevronRight size={9} className="text-text-dim/30" />}
        </button>
        <AnimatePresence initial={false}>
          {open && (
            <motion.div
              initial={{ height: 0 }}
              animate={{ height: 'auto' }}
              exit={{ height: 0 }}
              className="overflow-hidden border-t border-nexus-cyan/10"
            >
              <img
                src={src}
                alt="Visual snapshot"
                className="w-full object-cover cursor-zoom-in"
                onClick={() => setLightbox(true)}
                onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <AnimatePresence>
        {lightbox && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[9999] bg-black/90 flex items-center justify-center p-8"
            onClick={() => setLightbox(false)}
          >
            <button
              onClick={() => setLightbox(false)}
              className="absolute top-4 right-4 p-2 rounded-full bg-white/10 text-white hover:bg-white/20"
            >
              <X size={16} />
            </button>
            <img
              src={src}
              alt="Full size snapshot"
              className="max-w-full max-h-full object-contain rounded-xl shadow-2xl"
              onClick={e => e.stopPropagation()}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

// ─── Suggestion card (13.6) ─────────────────────────────────────────────────
function SuggestionCard({
  text,
  onAccept,
  onDismiss,
}: {
  text: string;
  onAccept: (text: string) => void;
  onDismiss: () => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.2 }}
      className="mt-2 flex items-start gap-2 px-3 py-2.5 rounded-xl border border-nexus-gold/20 bg-nexus-gold/[0.05]"
    >
      <Lightbulb size={11} className="text-nexus-gold/70 shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <p className="text-[10px] text-text-dim/70 leading-relaxed">
          <span className="font-bold text-nexus-gold/80">Next: </span>
          I can {text}. Would you like me to do that?
        </p>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <button
          onClick={() => onAccept(`Yes, please ${text}`)}
          className="text-[8px] font-bold uppercase tracking-widest px-2 py-1 rounded border bg-nexus-gold/15 border-nexus-gold/30 text-nexus-gold hover:bg-nexus-gold/25 transition-colors"
        >
          Yes, do it
        </button>
        <button
          onClick={onDismiss}
          className="p-1 rounded hover:bg-white/10 text-text-dim/40 hover:text-text-dim transition-colors"
        >
          <X size={10} />
        </button>
      </div>
    </motion.div>
  );
}

// ─── Action chain (step list) ────────────────────────────────────────────────
function ActionChain({ steps }: { steps: string[] }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="rounded-xl border border-nexus-cyan/15 bg-nexus-cyan/[0.02] overflow-hidden mb-1">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center gap-2 px-2.5 py-2 hover:bg-white/[0.02] transition-colors"
      >
        <ListChecks size={10} className="text-nexus-cyan/60 shrink-0" />
        <span className="text-[9px] font-bold uppercase tracking-[0.15em] text-nexus-cyan/60 flex-1 text-left">
          Plan
        </span>
        <span className="text-[8px] font-bold px-1.5 py-0.5 rounded bg-white/10 text-text-dim/50">{steps.length}</span>
        {open ? <ChevronDown size={9} className="text-text-dim/30" /> : <ChevronRight size={9} className="text-text-dim/30" />}
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="overflow-hidden border-t border-nexus-cyan/10"
          >
            <div className="px-2.5 py-2 space-y-1.5">
              {steps.map((step, i) => (
                <div key={i} className="flex items-start gap-2">
                  <div className="w-4 h-4 rounded-full bg-nexus-cyan/10 border border-nexus-cyan/25 flex items-center justify-center shrink-0 mt-0.5">
                    <span className="text-[7px] font-bold text-nexus-cyan/60">{i + 1}</span>
                  </div>
                  <span className="text-[10px] text-text-dim/70 leading-relaxed">{step}</span>
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Action group chip (13.7) ────────────────────────────────────────────────
function ActionGroupChip({
  filesRead,
  filesModified,
  terminals,
  screenshot,
  sessionId,
  onOpenFile,
}: {
  filesRead: string[];
  filesModified: FileWriteEntry[];
  terminals: TerminalEntry[];
  screenshot?: string;
  sessionId: string;
  onOpenFile: (p: string) => void;
}) {
  const hasFailure = terminals.some(t => !t.success);
  const [expanded, setExpanded] = useState(hasFailure);

  const total = filesRead.length + filesModified.length + terminals.length + (screenshot ? 1 : 0);
  if (total === 0) return null;

  return (
    <div className="mb-2 rounded-xl border border-white/[0.07] bg-white/[0.02] overflow-hidden">
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center gap-2 px-2.5 py-1.5 hover:bg-white/[0.03] transition-colors"
      >
        <div className="flex items-center gap-1 text-text-dim/40">
          {filesRead.length > 0 && <BookOpen size={9} />}
          {filesModified.length > 0 && <Pencil size={9} />}
          {terminals.length > 0 && <Terminal size={9} />}
          {screenshot && <Camera size={9} />}
        </div>
        <span className="text-[9px] font-bold text-text-dim/50 uppercase tracking-[0.15em] flex-1 text-left">
          {total} action{total !== 1 ? 's' : ''}
        </span>
        {hasFailure && (
          <span className="text-[8px] text-red-400 font-bold px-1.5 py-0.5 rounded bg-red-400/10 mr-1">
            ERRORS
          </span>
        )}
        {expanded
          ? <ChevronDown size={9} className="text-text-dim/30" />
          : <ChevronRight size={9} className="text-text-dim/30" />
        }
      </button>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="overflow-hidden border-t border-white/5"
          >
            <div className="p-2 space-y-1">
              {filesRead.length > 0 && (
                <ReadFileGroup paths={filesRead} onOpen={onOpenFile} />
              )}
              {filesModified.map((f, i) => (
                <WriteFileCard key={i} file={f} sessionId={sessionId} onOpen={onOpenFile} />
              ))}
              {terminals.map((t, i) => (
                <RunShellCard key={i} entry={t} />
              ))}
              {screenshot && (
                <InlineScreenshot sessionId={sessionId} filename={screenshot} />
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Streaming indicator ─────────────────────────────────────────────────────
function StreamingIndicator({ metadata }: { metadata?: ChatMessageMetadata }) {
  const latestStatus = metadata?.statusHistory?.slice(-1)[0] || 'Neural synthesis in progress...';
  return (
    <div className="space-y-3 py-2">
      <div className="flex items-center gap-3">
        <div className="flex gap-1">
          {[0, 0.2, 0.4].map((delay, i) => (
            <div key={i} className="w-1.5 h-1.5 rounded-full bg-nexus-gold animate-bounce"
              style={{ animationDelay: `${delay}s` }} />
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

// ─── Assistant message bubble (all Phase 13 features) ────────────────────────
function NexusMessageBubble({
  msg,
  index,
  isLast,
  sessionId,
  onOpenFile,
  onSuggestionAccept,
}: {
  msg: ChatMessage;
  index: number;
  isLast: boolean;
  sessionId: string;
  onOpenFile: (p: string) => void;
  onSuggestionAccept: (text: string) => void;
}) {
  const meta = msg.metadata;
  const isStreaming = meta?.streaming;

  const [dismissedSuggestion, setDismissedSuggestion] = useState(false);

  const hasThought    = !!(meta?.thought || meta?.thinking);
  const thoughtText   = meta?.thinking || meta?.thought || '';
  const hasChain      = (meta?.actionChain?.length || 0) > 0;
  const hasFilesRead  = (meta?.filesRead?.length || 0) > 0;
  const hasFilesWritten = (meta?.filesModified?.length || 0) > 0;
  const hasTerminals  = (meta?.terminals?.length || 0) > 0;
  const hasScreenshot = !!meta?.screenshot;
  const hasSuggestion = !!meta?.suggestion && isLast && !dismissedSuggestion;

  const intentBadge = meta?.intent ? INTENT_BADGES[meta.intent] : null;

  return (
    <div className="space-y-1">
      {/* Provenance badges */}
      {(intentBadge || meta?.usedKey) && !isStreaming && (
        <div className="flex items-center gap-1.5 text-[8px] font-bold uppercase tracking-[0.15em] mb-1">
          {intentBadge && (
            <span className={cn('inline-flex items-center gap-1 px-1.5 py-0.5 rounded border', intentBadge.color)}>
              <MessageSquare size={9} /> {intentBadge.label}
            </span>
          )}
          {meta?.usedKey && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border bg-white/5 text-text-dim/70 border-white/10" title="Provider key used">
              <KeyRound size={9} /> {meta.usedKey}
            </span>
          )}
        </div>
      )}

      {/* 13.2 — Thinking block */}
      {!isStreaming && hasThought && (
        <ThinkingBlock content={thoughtText} ms={meta?.thinkingMs} />
      )}

      {/* 13.1 + 13.7 — Action cards grouped into a collapsible chip */}
      {!isStreaming && (
        <div className="space-y-0.5">
          {/* 13.4 — Phase labels */}
          {meta?.phase && <PhaseLabel phase={meta.phase} />}

          {/* 13.1 — Plan / Action chain (shown separately — it's structural) */}
          {hasChain && <ActionChain steps={meta!.actionChain!} />}

          {/* 13.7 — All tool-call cards grouped into one collapsed chip */}
          {(hasFilesRead || hasFilesWritten || hasTerminals || hasScreenshot) && (
            <ActionGroupChip
              filesRead={meta?.filesRead || []}
              filesModified={meta?.filesModified || []}
              terminals={meta?.terminals || []}
              screenshot={meta?.screenshot}
              sessionId={sessionId}
              onOpenFile={onOpenFile}
            />
          )}
        </div>
      )}

      {/* Main prose bubble */}
      <div className="bg-white/[0.03] border border-white/5 text-text-main rounded-2xl rounded-tl-none p-4 shadow-xl backdrop-blur-md">
        {isStreaming ? (
          <StreamingIndicator metadata={meta} />
        ) : (
          <div className="markdown-body prose-nexus text-[13px] leading-relaxed">
            <Markdown>{sanitizeNexusContent(msg.content) || '...'}</Markdown>
          </div>
        )}
      </div>

      {/* 13.6 — Suggestion card (last assistant message only) */}
      <AnimatePresence>
        {hasSuggestion && (
          <SuggestionCard
            text={meta!.suggestion!}
            onAccept={text => { onSuggestionAccept(text); setDismissedSuggestion(true); }}
            onDismiss={() => setDismissedSuggestion(true)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Live Blackboard Bar (Phase 8.1) ─────────────────────────────────────────
interface PlanStep { id: string; description: string; acceptance: string; status: string }
interface AuditEntry { step: number; passed: boolean; severity: string; issues: string[]; reviewerModel: string }
interface BlackboardTask { id: string; goal: string; plan: PlanStep[]; currentStep: number; status: string; retries: number; audits: AuditEntry[]; createdAt: number }

const TASK_STATUS_COLORS: Record<string, string> = {
  done: 'border-emerald-400/20 bg-emerald-400/[0.02]',
  stasis: 'border-red-400/20 bg-red-400/[0.02]',
  planning: 'border-nexus-gold/20 bg-nexus-gold/[0.02]',
  writing: 'border-nexus-cyan/20 bg-nexus-cyan/[0.02]',
  reviewing: 'border-purple-400/20 bg-purple-400/[0.02]',
  pending: 'border-white/5 bg-white/[0.01]',
  failed: 'border-red-400/20 bg-red-400/[0.02]',
};

const STEP_STATUS_COLORS: Record<string, string> = {
  done: 'text-emerald-400', in_progress: 'text-nexus-gold animate-pulse',
  failed: 'text-red-400', todo: 'text-text-dim/30',
};

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
        <span className="text-[9px] font-black uppercase tracking-[0.2em] text-nexus-gold/70 flex-1 text-left">Blackboard Graph</span>
        <span className="text-[8px] font-mono text-text-dim/30">{visible.length} task{visible.length !== 1 ? 's' : ''}</span>
        {open ? <ChevronDown size={10} className="text-text-dim/30" /> : <ChevronRight size={10} className="text-text-dim/30" />}
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden">
            <div className="px-3 pb-2 space-y-1.5 max-h-64 overflow-y-auto custom-scrollbar">
              {visible.map(task => (
                <div key={task.id} className={cn('rounded-lg border overflow-hidden', TASK_STATUS_COLORS[task.status] || 'border-white/5')}>
                  <button className="w-full flex items-center gap-2 px-2.5 py-2 text-left hover:bg-white/[0.03] transition-colors" onClick={() => setExpanded(expanded === task.id ? null : task.id)}>
                    <div className={cn('text-[8px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded shrink-0',
                      task.status === 'done' ? 'bg-emerald-400/10 text-emerald-400' :
                      task.status === 'stasis' ? 'bg-red-400/10 text-red-400' :
                      task.status === 'writing' ? 'bg-nexus-cyan/10 text-nexus-cyan' :
                      task.status === 'reviewing' ? 'bg-purple-400/10 text-purple-400' :
                      'bg-nexus-gold/10 text-nexus-gold'
                    )}>{task.status}</div>
                    <span className="text-[10px] text-text-main/80 flex-1 truncate">{task.goal}</span>
                    {task.retries > 0 && <span className="text-[8px] text-yellow-400/70 shrink-0">{task.retries}↺</span>}
                    {task.plan.length > 0 && <span className="text-[8px] text-text-dim/40 shrink-0">{task.plan.filter(s => s.status === 'done').length}/{task.plan.length}</span>}
                    {expanded === task.id ? <ChevronDown size={9} className="text-text-dim/30 shrink-0" /> : <ChevronRight size={9} className="text-text-dim/30 shrink-0" />}
                  </button>
                  <AnimatePresence initial={false}>
                    {expanded === task.id && task.plan.length > 0 && (
                      <motion.div initial={{ height: 0 }} animate={{ height: 'auto' }} exit={{ height: 0 }} className="overflow-hidden border-t border-white/5">
                        <div className="px-2.5 py-2 space-y-1.5">
                          {task.plan.map((step, si) => {
                            const audit = task.audits.find(a => a.step === si);
                            return (
                              <div key={step.id} className="flex items-start gap-2">
                                <CornerDownRight size={9} className="text-text-dim/20 shrink-0 mt-1" />
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-1.5 mb-0.5">
                                    <span className="text-[8px] font-black text-text-dim/40">{step.id}</span>
                                    <span className={cn('text-[8px] font-bold uppercase', STEP_STATUS_COLORS[step.status] || 'text-text-dim/30')}>{step.status.replace('_', ' ')}</span>
                                    {audit && <span className={cn('text-[7px] font-black px-1 py-0.5 rounded', audit.passed ? 'bg-emerald-400/10 text-emerald-400' : 'bg-red-400/10 text-red-400')}>{audit.passed ? '✓ PASS' : '✗ FAIL'}</span>}
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

// ─── Main ChatPanel ───────────────────────────────────────────────────────────
export function ChatPanel() {
  const { state, setState, sendMessage, retryMessage, createSession, deleteMessage, editMessage, openFileInEditor } = useNexus();
  const currentSession = state.sessions.find(s => s.sessionId === state.currentSessionId);
  const [input, setInput] = useState('');
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editVal, setEditVal] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  }, [input]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
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

  const handleDeleteRequest = (index: number) => {
    setConfirmDeleteId(index);
  };

  const handleDeleteConfirm = (index: number) => {
    deleteMessage(index);
    setConfirmDeleteId(null);
  };

  const startEdit = (index: number, content: string) => {
    setEditingId(index);
    setEditVal(content);
  };

  const saveEdit = (index: number) => {
    editMessage(index, editVal);
    setEditingId(null);
  };

  const handleSuggestionAccept = (text: string) => {
    if (!state.currentSessionId) createSession();
    sendMessage(text);
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
              {state.selectedModel} • {state.selectedMode} • Silent Operator v8.0
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

      {/* Live Blackboard (Phase 8.1) */}
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
            <div className={cn('flex items-center gap-2 mb-2 px-1', msg.role === 'user' ? 'flex-row-reverse' : 'flex-row')}>
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
                <div className="flex items-center gap-1.5 mt-0.5">
                  <span className="text-[8px] text-text-dim flex items-center gap-1 opacity-50">
                    <Clock size={7} /> {new Date(msg.timestamp || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                  {/* Checkpoint badge */}
                  {msg.checkpointId && (
                    <span
                      className="flex items-center gap-1 text-[7px] font-bold px-1.5 py-0.5 rounded border bg-nexus-green/10 border-nexus-green/25 text-nexus-green/70 cursor-default"
                      title={`Checkpoint: ${msg.checkpointId}`}
                    >
                      <GitCommit size={7} /> CHECKPOINT
                    </span>
                  )}
                </div>
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
              <NexusMessageBubble
                msg={msg}
                index={i}
                isLast={i === state.chatHistory.length - 1}
                sessionId={state.currentSessionId || ''}
                onOpenFile={openFileInEditor}
                onSuggestionAccept={handleSuggestionAccept}
              />
            )}

            {/* Action row */}
            <div className={cn(
              'flex items-center gap-1 px-1 mt-1 opacity-40 hover:opacity-100 focus-within:opacity-100 transition-opacity',
              msg.role === 'user' ? 'flex-row-reverse' : 'flex-row'
            )}>
              {/* Inline delete confirmation */}
              {confirmDeleteId === i ? (
                <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-red-400/10 border border-red-400/20">
                  <span className="text-[8px] font-bold text-red-400/80 uppercase tracking-widest">Delete?</span>
                  <button onClick={() => handleDeleteConfirm(i)} className="text-[8px] font-bold text-red-400 hover:text-red-300 transition-colors px-1">Yes</button>
                  <button onClick={() => setConfirmDeleteId(null)} className="text-[8px] font-bold text-text-dim hover:text-white transition-colors px-1">No</button>
                </div>
              ) : (
                <>
                  {/* Retry — only for user messages; deletes everything after + re-sends */}
                  {msg.role === 'user' && (
                    <button
                      onClick={() => retryMessage(i)}
                      className="p-1.5 rounded hover:bg-white/5 text-text-dim hover:text-nexus-gold transition-colors"
                      title="Retry from this point (removes all messages after)"
                    >
                      <RotateCcw size={11} />
                    </button>
                  )}
                  {/* Copy */}
                  <button
                    onClick={() => copyToClipboard(msg.content, i)}
                    className="p-1.5 rounded hover:bg-white/5 text-text-dim hover:text-nexus-cyan transition-colors"
                    title="Copy"
                  >
                    {copiedId === i ? <Check size={11} /> : <Copy size={11} />}
                  </button>
                  {/* Edit (user only) */}
                  {msg.role === 'user' && (
                    <button
                      onClick={() => startEdit(i, msg.content)}
                      className="p-1.5 rounded hover:bg-white/5 text-text-dim hover:text-nexus-gold transition-colors"
                      title="Edit"
                    >
                      <Pencil size={11} />
                    </button>
                  )}
                  {/* Delete */}
                  <button
                    onClick={() => handleDeleteRequest(i)}
                    className="p-1.5 rounded hover:bg-white/5 text-text-dim hover:text-red-400 transition-colors"
                    title="Delete"
                  >
                    <Trash2 size={11} />
                  </button>
                </>
              )}
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
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); handleSend(); }
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
          Cmd/Ctrl+Enter to Send • Retry clears history from that point • Phase 13 Active
        </p>
      </div>
    </div>
  );
}
