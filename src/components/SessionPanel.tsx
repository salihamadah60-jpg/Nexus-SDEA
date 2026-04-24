import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useNexus } from '../NexusContext';
import { MessageSquare, Trash2, History, Plus, Edit2, Check, X, Pin, PinOff, MoreHorizontal, RefreshCcw } from 'lucide-react';
import { cn } from '../utils';

interface RenameState { id: string; value: string; }
interface Props {
  onSelect?: () => void;
}

export function SessionPanel({ onSelect }: Props) {
  const { state, createSession, switchSession, deleteSession, renameSession, pinSession } = useNexus();
  const [renaming, setRenaming] = useState<RenameState | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [showOptionsId, setShowOptionsId] = useState<string | null>(null);
  const [rebuilding, setRebuilding] = useState<string | null>(null);

  async function rebuildSandbox(sid: string) {
    if (rebuilding) return;
    setRebuilding(sid);
    try {
      const r = await fetch(`/api/sessions/${sid}/rebuild-sandbox`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template: 'react-vite', reboot: true }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) console.warn('[SessionPanel] rebuild failed', j);
    } catch (e) { console.warn('[SessionPanel] rebuild error', e); }
    finally { setTimeout(() => setRebuilding(null), 800); }
  }

  const handleRename = async (id: string) => {
    if (!renaming || renaming.id !== id || !renaming.value.trim()) {
      setRenaming(null);
      return;
    }
    await renameSession(id, renaming.value.trim());
    setRenaming(null);
  };

  const formatDate = (ts: any) => {
    if (!ts) return '—';
    const d = new Date(ts);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    const isYesterday = new Date(now.getTime() - 86400000).toDateString() === d.toDateString();
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (isToday) return `Today ${time}`;
    if (isYesterday) return `Yesterday ${time}`;
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + time;
  };

  const sorted = [...state.sessions].sort((a, b) => {
    if ((a as any).pinned && !(b as any).pinned) return -1;
    if (!(a as any).pinned && (b as any).pinned) return 1;
    return new Date(b.lastModified || 0).getTime() - new Date(a.lastModified || 0).getTime();
  });

  return (
    <div className="flex flex-col h-full bg-bg-deep/30 backdrop-blur-sm">
      <div className="px-4 pt-4 pb-3 border-b border-border/50 shrink-0">
        <div className="flex items-center justify-between mb-3">
          <h3 className="nexus-label text-nexus-gold/40">Neural Stream</h3>
          <span className="text-[9px] font-mono text-text-dim/20 tracking-widest">{state.sessions.length} Threads</span>
        </div>
        <button
          onClick={() => {
            createSession().then(() => onSelect?.());
          }}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-nexus-gold/5 border border-nexus-gold/10 py-2.5 text-[11px] font-bold text-nexus-gold hover:bg-nexus-gold/10 transition-all active:scale-95 group shadow-lg shadow-nexus-gold/5"
        >
          <Plus size={14} className="group-hover:rotate-90 transition-transform" />
          <span>Initialize Session</span>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto custom-scrollbar p-2 space-y-1.5 pt-4">
        {sorted.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 text-text-dim/10">
            <History size={32} className="mb-3 opacity-50" />
            <span className="text-[10px] font-bold uppercase tracking-[0.3em]">Vacuum detected</span>
          </div>
        )}

        {sorted.map((session, i) => {
          const sid = session.sessionId || `gen-${i}`;
          const isActive = state.currentSessionId === sid;
          const isPinned = (session as any).pinned;
          const isRenaming = renaming?.id === sid;
          const isDeleting = confirmDelete === sid;
          const isOptions = showOptionsId === sid;

          return (
            <motion.div
              key={sid}
              initial={{ opacity: 0, y: 5 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.02 }}
              onClick={() => {
                if (!isRenaming && !isDeleting) {
                  switchSession(sid);
                  onSelect?.();
                }
              }}
              onMouseLeave={() => !isRenaming && !isDeleting && setShowOptionsId(null)}
              className={cn(
                'group relative flex flex-col rounded-xl px-3 py-3 cursor-pointer transition-all duration-300',
                isActive 
                  ? 'bg-nexus-gold/[0.05] shadow-[0_0_15px_rgba(212,175,55,0.05)] border border-nexus-gold/20' 
                  : 'hover:bg-white/[0.03] border border-transparent'
              )}
            >
              {isDeleting ? (
                <div className="flex flex-col gap-2 p-1">
                  <p className="text-[10px] text-red-400 font-bold tracking-tight">Purge this stream?</p>
                  <div className="flex gap-1.5">
                    <button
                      onClick={(e) => { e.stopPropagation(); deleteSession(sid); setConfirmDelete(null); }}
                      className="flex-1 text-[9px] font-black uppercase bg-red-500/10 border border-red-500/20 text-red-400 rounded-lg py-1.5 hover:bg-red-500/20 transition-all"
                    >Purge</button>
                    <button
                      onClick={(e) => { e.stopPropagation(); setConfirmDelete(null); }}
                      className="flex-1 text-[9px] font-black uppercase bg-white/5 border border-white/10 text-text-dim rounded-lg py-1.5 hover:bg-white/10 transition-all"
                    >Abort</button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-3">
                    <div className={cn(
                      'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-all duration-500',
                      isActive ? 'bg-nexus-gold text-bg-deep shadow-[0_0_12px_rgba(212,175,55,0.4)]' : 'bg-white/5 text-text-dim group-hover:bg-white/10'
                    )}>
                      <MessageSquare size={14} />
                    </div>

                    {isRenaming ? (
                      <form
                        className="flex-1 flex items-center gap-1"
                        onSubmit={(e) => { e.preventDefault(); handleRename(sid); }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          autoFocus
                          value={renaming.value}
                          onChange={(e) => setRenaming({ id: sid, value: e.target.value })}
                          className="flex-1 nexus-input text-[11px] py-1 px-2 h-auto"
                          onBlur={() => handleRename(sid)}
                        />
                        <button type="submit" className="text-nexus-gold hover:scale-110 transition-transform"><Check size={14} /></button>
                      </form>
                    ) : (
                      <div className="flex-1 min-w-0 pr-6">
                        <div className="flex items-center gap-2">
                          {isPinned && <Pin size={9} className="text-nexus-gold shrink-0 animate-pulse" />}
                          <p className={cn(
                            'text-[11px] font-bold truncate tracking-tight transition-colors',
                            isActive ? 'text-white' : 'text-text-main/50 group-hover:text-text-main/80'
                          )}>
                            {session.title || 'Vague Intent'}
                          </p>
                        </div>
                        <p className="text-[9px] text-text-dim/20 font-bold mt-0.5 tracking-wider">{formatDate(session.lastModified)}</p>
                      </div>
                    )}

                    {/* Options Trigger */}
                    {!isRenaming && !isDeleting && (
                      <button
                        onClick={(e) => { e.stopPropagation(); setShowOptionsId(isOptions ? null : sid); }}
                        className={cn(
                          "absolute right-2 top-2 p-1.5 rounded-lg transition-all border",
                          isOptions ? "bg-nexus-gold/10 border-nexus-gold/30 text-nexus-gold" : "opacity-0 group-hover:opacity-100 bg-white/5 border-white/5 text-text-dim hover:text-white"
                        )}
                      >
                        <MoreHorizontal size={14} />
                      </button>
                    )}

                    {/* Overlay Options Menu */}
                    <AnimatePresence>
                      {isOptions && (
                        <motion.div
                          initial={{ opacity: 0, scale: 0.9, x: 10 }}
                          animate={{ opacity: 1, scale: 1, x: 0 }}
                          exit={{ opacity: 0, scale: 0.9, x: 10 }}
                          className="absolute right-10 top-2 z-50 flex items-center gap-1 bg-bg-surface border border-white/10 rounded-xl p-1.5 shadow-2xl backdrop-blur-xl"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button
                            onClick={() => { pinSession(sid); setShowOptionsId(null); }}
                            className={cn('p-1.5 rounded-lg transition-all hover:bg-white/5', isPinned ? 'text-nexus-gold' : 'text-text-dim hover:text-nexus-gold')}
                            title={isPinned ? 'Unpin' : 'Pin'}
                          ><Pin size={13} /></button>
                          <button
                            onClick={() => { setRenaming({ id: sid, value: session.title || '' }); setShowOptionsId(null); }}
                            className="p-1.5 rounded-lg text-text-dim hover:text-nexus-gold hover:bg-white/5 transition-all"
                            title="Rename"
                          ><Edit2 size={13} /></button>
                          <button
                            onClick={() => { rebuildSandbox(sid); setShowOptionsId(null); }}
                            disabled={rebuilding === sid}
                            className={cn(
                              'p-1.5 rounded-lg transition-all hover:bg-cyan-500/10',
                              rebuilding === sid ? 'text-nexus-cyan animate-spin' : 'text-text-dim hover:text-nexus-cyan'
                            )}
                            title="Rebuild sandbox (wipe & re-scaffold)"
                          ><RefreshCcw size={13} /></button>
                          <div className="w-[1px] h-4 bg-white/10 mx-1" />
                          <button
                            onClick={() => { setConfirmDelete(sid); setShowOptionsId(null); }}
                            className="p-1.5 rounded-lg text-text-dim hover:text-red-400 hover:bg-red-500/10 transition-all"
                            title="Delete"
                          ><Trash2 size={13} /></button>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                </>
              )}
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}
