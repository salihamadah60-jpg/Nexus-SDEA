import React, { useMemo } from 'react';
import { motion } from 'motion/react';
import { CheckCircle2, Circle, AlertCircle, Clock, Brain, ListChecks, AlertOctagon, Activity } from 'lucide-react';
import { Task, NexusEvent } from '../types';
import { cn } from '../utils';
import { useNexus } from '../NexusContext';

interface Props { tasks: Task[]; activeTaskId: string | null; }

const KIND_LABEL: Record<string, { label: string; icon: any; color: string }> = {
  'agent.plan':    { label: 'PLAN',    icon: ListChecks,  color: 'text-nexus-cyan border-nexus-cyan/30 bg-nexus-cyan/5' },
  'agent.thought': { label: 'THOUGHT', icon: Brain,       color: 'text-nexus-gold border-nexus-gold/30 bg-nexus-gold/5' },
  'obs.error':     { label: 'ERROR',   icon: AlertOctagon,color: 'text-red-400 border-red-400/30 bg-red-400/5' },
  'obs.preview.ready': { label: 'PREVIEW', icon: Activity, color: 'text-emerald-400 border-emerald-400/30 bg-emerald-400/5' },
  'action.command': { label: 'CMD',    icon: Activity,    color: 'text-purple-400 border-purple-400/30 bg-purple-400/5' },
};

// Phase 10.2 — wire to live agent events streamed over WS instead of polling.
function LiveTimeline() {
  const { state } = useNexus();
  const events = useMemo(() => {
    const all = state.recentEvents || [];
    return all
      .filter((e: NexusEvent) => /^(agent\.|obs\.error|obs\.preview\.ready|action\.command)/.test(e.kind))
      .slice(-20)
      .reverse();
  }, [state.recentEvents]);

  if (events.length === 0) {
    return (
      <div className="text-[9px] text-text-dim/40 text-center py-3 uppercase tracking-widest">
        Awaiting agent events…
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {events.map((ev: NexusEvent) => {
        const meta = KIND_LABEL[ev.kind] || { label: ev.kind, icon: Activity, color: 'text-text-dim border-white/10 bg-white/5' };
        const Icon = meta.icon;
        const summary =
          ev.payload?.phase ||
          ev.payload?.status ||
          ev.payload?.cmd ||
          ev.payload?.reason ||
          (typeof ev.payload?.steps === 'number' ? `${ev.payload.steps} steps` : undefined) ||
          '—';
        return (
          <motion.div
            key={ev.id}
            initial={{ opacity: 0, x: -6 }}
            animate={{ opacity: 1, x: 0 }}
            className={cn('flex items-start gap-2 rounded-md border px-2 py-1.5', meta.color)}
          >
            <Icon size={10} className="mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-[8px] font-black uppercase tracking-[0.18em] opacity-80">{meta.label}</span>
                <span className="text-[8px] font-mono opacity-40">{new Date(ev.ts).toLocaleTimeString()}</span>
              </div>
              <div className="text-[10px] truncate font-mono opacity-90">{String(summary)}</div>
            </div>
          </motion.div>
        );
      })}
    </div>
  );
}

export function TaskTracker({ tasks = [], activeTaskId }: Props) {
  return (
    <div className="flex flex-col gap-3 p-4 h-full overflow-y-auto custom-scrollbar">
      <div className="flex items-center justify-between">
        <h3 className="nexus-label text-nexus-gold/70">Orchestration Queue</h3>
        <span className="text-[9px] font-mono text-text-dim/30">{tasks?.length || 0} vectors</span>
      </div>

      {(tasks?.length || 0) === 0 && (
        <div className="flex flex-col items-center justify-center py-8 text-text-dim/20">
          <Clock size={28} className="mb-2" />
          <p className="text-[10px] uppercase tracking-widest">Awaiting Neural Sequence</p>
        </div>
      )}

      <div className="space-y-2">
        {tasks?.map(task => (
          <motion.div
            key={task.id}
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            className={cn(
              'rounded-xl border p-3 transition-all',
              task.id === activeTaskId ? 'bg-nexus-gold/5 border-nexus-gold/20' : 'bg-white/[0.03] border-white/5'
            )}
          >
            <div className="flex items-center gap-2.5 mb-2">
              {task.status === 'completed' ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
              ) : task.status === 'failed' ? (
                <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
              ) : (
                <Circle className={cn('w-4 h-4 shrink-0', task.id === activeTaskId ? 'text-nexus-gold animate-pulse' : 'text-text-dim')} />
              )}
              <div className="flex-1 min-w-0">
                <div className={cn('text-[11px] font-bold truncate', task.id === activeTaskId ? 'text-text-main' : 'text-text-dim')}>
                  {task.title}
                </div>
                <div className="text-[8px] font-mono text-text-dim/30 truncate uppercase tracking-tighter">ID: {task.id}</div>
              </div>
            </div>

            {task.subtasks && task.subtasks.length > 0 && (
              <div className="pl-6 space-y-1.5 border-l border-white/5 ml-2 mt-2">
                {task.subtasks.map(sub => (
                  <div key={sub.id} className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <div className={cn('h-1 w-1 rounded-full shrink-0', sub.status === 'completed' ? 'bg-emerald-400' : sub.status === 'running' ? 'bg-nexus-gold animate-pulse' : 'bg-text-dim/30')} />
                      <span className={cn('text-[9px] uppercase tracking-tight', sub.status === 'running' ? 'text-nexus-gold' : 'text-text-dim/40')}>{sub.title}</span>
                    </div>
                    {sub.logs && sub.logs.length > 0 && (
                      <div className="pl-3 space-y-0.5">
                        {sub.logs.slice(-2).map((log, li) => (
                          <div key={li} className="text-[8px] font-mono text-text-dim/20 leading-tight">› {log}</div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {task.lessonLearned && (
              <div className="mt-3 pt-2 border-t border-nexus-gold/10">
                <div className="text-[8px] font-bold text-nexus-gold uppercase tracking-[0.2em] mb-1">DNA Synthesis</div>
                <p className="text-[9px] text-text-dim/70 leading-relaxed italic">"{task.lessonLearned}"</p>
              </div>
            )}
          </motion.div>
        ))}
      </div>

      {/* Phase 10.2 — Live agent timeline (streamed over WS, no polling). */}
      <div className="mt-3 pt-3 border-t border-white/5">
        <div className="flex items-center justify-between mb-2">
          <h3 className="nexus-label text-nexus-cyan/70">Live Timeline</h3>
          <span className="text-[8px] font-mono text-text-dim/30 uppercase tracking-widest">streaming</span>
        </div>
        <LiveTimeline />
      </div>
    </div>
  );
}
