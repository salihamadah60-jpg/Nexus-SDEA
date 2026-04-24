import React, { useState, useRef } from 'react';
import { motion } from 'motion/react';
import { Cpu, Database, Zap, GitBranch, Shield, Activity, Send, Sparkles } from 'lucide-react';
import { useNexus } from '../NexusContext';
import { cn } from '../utils';
import { MODELS } from '../constants';

interface Props { onStartChat: (msg: string) => void; }

export function HomePanel({ onStartChat }: Props) {
  const { state, createSession } = useNexus();
  const { systemStatus } = state;
  const [quickInput, setQuickInput] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const statusDot = (status: string) => cn(
    'h-2 w-2 rounded-full shrink-0',
    status === 'ACTIVE' || status === 'CONNECTED'
      ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.8)]'
      : status === 'LOADING' ? 'bg-nexus-gold animate-pulse'
      : 'bg-red-400 shadow-[0_0_4px_rgba(239,68,68,0.5)]'
  );

  const providers = [
    { label: 'GitHub GPT-4o', key: 'github',   icon: GitBranch },
    { label: 'Gemini Flash',  key: 'gemini',   icon: Zap },
    { label: 'Groq Kernel',   key: 'groq',     icon: Activity },
    { label: 'HuggingFace',   key: 'hf',       icon: Cpu },
    { label: 'Neural Memory', key: 'database', icon: Database },
  ];

  const handleSend = () => {
    if (!quickInput.trim()) return;
    onStartChat(quickInput.trim());
    setQuickInput('');
  };

  const suggestions = [
    'Build me a React todo app',
    'Explain the codebase structure',
    'Write a Python web scraper',
    'Create a REST API with Express',
  ];

  return (
    <div className="flex flex-col h-full overflow-y-auto custom-scrollbar">
      {/* Hero */}
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex flex-col items-center pt-8 pb-5 px-4 gap-2 border-b border-border"
      >
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-nexus-gold/10 border border-nexus-gold/20 shadow-[0_0_30px_rgba(212,175,55,0.15)]">
          <Shield className="w-7 h-7 text-nexus-gold" />
        </div>
        <div className="text-center mt-1">
          <h1 className="font-display text-lg font-black tracking-tight text-white uppercase">
            Nexus <span className="text-nexus-gold">AI</span>
          </h1>
          <p className="text-[9px] font-bold tracking-[0.25em] text-nexus-gold/40 uppercase">Sovereign IDE v6.2</p>
        </div>
      </motion.div>

      {/* Quick Chat Input */}
      <div className="px-4 pt-4 pb-3 border-b border-border">
        <p className="nexus-label mb-2">Start a Conversation</p>
        <div className="relative">
          <textarea
            ref={inputRef}
            value={quickInput}
            onChange={(e) => setQuickInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
            placeholder="Ask Nexus AI anything…"
            rows={2}
            className="w-full resize-none rounded-xl bg-nexus-surface border-none px-3 py-2.5 pr-10 text-[12px] text-white placeholder:text-white/20 focus:ring-1 focus:ring-nexus-gold/20 focus:outline-none transition-all custom-scrollbar shadow-inner"
          />
          <button
            onClick={handleSend}
            disabled={!quickInput.trim()}
            className="absolute bottom-2.5 right-2.5 flex h-6 w-6 items-center justify-center rounded-lg bg-nexus-gold/10 text-nexus-gold hover:bg-nexus-gold/20 disabled:opacity-20 transition-all active:scale-95"
          >
            <Send size={12} />
          </button>
        </div>
        {/* Quick suggestions */}
        <div className="mt-2 flex flex-col gap-1">
          {suggestions.map((s, i) => (
            <button
              key={i}
              onClick={() => onStartChat(s)}
              className="text-left text-[10px] text-text-dim/50 hover:text-nexus-gold/80 px-2 py-1 rounded hover:bg-nexus-gold/5 transition-all truncate flex items-center gap-1.5"
            >
              <Sparkles size={9} className="shrink-0 text-nexus-gold/30" />
              {s}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-4 p-4">
        {/* Kernel Status */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="nexus-label mb-0">Kernel Pulse</h3>
            <div className="text-[8px] font-bold tracking-[0.2em] text-white/20 uppercase">Real-time Sync</div>
          </div>
          {providers.map(({ label, key, icon: Icon }) => {
            const status = (systemStatus as any)[key] || 'UNKNOWN';
            const isActive = status === 'ACTIVE' || status === 'CONNECTED';
            return (
              <div 
                key={key} 
                className={cn(
                  "group flex items-center justify-between rounded-xl px-4 py-2.5 transition-all duration-300",
                  "bg-white/[0.02] border border-white/5 hover:bg-white/[0.05] hover:border-white/10",
                  isActive && "bg-emerald-400/[0.02] border-emerald-400/10"
                )}
              >
                <div className="flex items-center gap-3">
                  <div className={cn(
                    "flex h-7 w-7 items-center justify-center rounded-lg transition-colors",
                    isActive ? "bg-emerald-400/10 text-emerald-400" : "bg-white/5 text-text-dim/40"
                  )}>
                    <Icon className="w-3.5 h-3.5" />
                  </div>
                  <span className={cn(
                    "text-[11px] font-bold tracking-tight transition-colors",
                    isActive ? "text-white" : "text-text-dim/60 group-hover:text-text-dim"
                  )}>{label}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className={cn(
                    "text-[8px] font-black tracking-[0.2em] uppercase transition-all",
                    isActive ? "text-emerald-400" : "text-text-dim/30"
                  )}>{status}</span>
                  <div className={cn(
                    statusDot(status),
                    isActive && "scale-110 shadow-[0_0_8px_rgba(52,211,153,0.5)]"
                  )} />
                </div>
              </div>
            );
          })}
        </div>

        {/* Stats */}
        <div>
          <h3 className="nexus-label mb-2">Quick Actions</h3>
          <button
            onClick={() => createSession()}
            className="w-full flex items-center gap-3 rounded-lg bg-nexus-gold/5 border border-nexus-gold/15 px-3 py-2.5 text-left hover:bg-nexus-gold/10 hover:border-nexus-gold/30 transition-all mb-2"
          >
            <Zap className="w-4 h-4 text-nexus-gold shrink-0" />
            <div>
              <div className="text-[11px] font-bold text-nexus-gold">New Neural Thread</div>
              <div className="text-[9px] text-text-dim/50">Initialize a fresh session sandbox</div>
            </div>
          </button>
          <div className="grid grid-cols-2 gap-2">
            {[
              { label: 'Sessions', count: state.sessions.length },
              { label: 'Tasks', count: state.tasks.length },
            ].map(({ label, count }) => (
              <div key={label} className="flex flex-col items-center rounded-lg bg-white/[0.03] border border-white/5 py-3 gap-1">
                <span className="text-xl font-black text-nexus-gold">{count}</span>
                <span className="text-[9px] font-bold uppercase tracking-widest text-text-dim/50">{label}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Active Model */}
        <div>
          <h3 className="nexus-label mb-2">Active Model</h3>
          <div className="rounded-lg bg-nexus-cyan/5 border border-nexus-cyan/10 p-3">
            <p className="text-[11px] font-bold text-nexus-cyan">
              {MODELS.find(m => m.id === state.selectedModel)?.name || 'Nexus Prime'}
            </p>
            <p className="text-[9px] text-text-dim/50 mt-0.5">
              Mode: <span className="text-nexus-gold/70 capitalize">{state.selectedMode}</span>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
