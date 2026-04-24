import React from 'react';
import { motion } from 'motion/react';
import { Cpu, Loader2, Orbit, ShieldCheck } from 'lucide-react';

export function LoadingKernel() {
  return (
    <div className="fixed inset-0 bg-nexus-black z-[500] flex items-center justify-center nexus-loading-kernel">
      <div className="relative flex flex-col items-center max-w-xs w-full p-8 text-center">
        <div className="absolute inset-0 bg-nexus-gold/4 blur-[120px] blur-bg" />

        <div className="relative z-10 mb-8">
          <motion.div
            animate={{ rotate: 360 }}
            transition={{ duration: 4, repeat: Infinity, ease: 'linear' }}
          >
            <Orbit className="w-20 h-20 text-nexus-gold opacity-25" />
          </motion.div>
          <motion.div
            className="absolute inset-0 flex items-center justify-center"
            animate={{ rotate: -360 }}
            transition={{ duration: 10, repeat: Infinity, ease: 'linear' }}
          >
            <Cpu className="w-8 h-8 text-nexus-gold shadow-[0_0_20px_rgba(212,175,55,0.4)]" />
          </motion.div>
          <div className="absolute inset-0 flex items-center justify-center">
            <Loader2 className="w-24 h-24 text-nexus-gold/15 animate-spin" />
          </div>
        </div>

        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
          className="relative z-10 space-y-4"
        >
          <h2 className="font-display text-xl font-black tracking-tight uppercase text-text-main">
            Initializing Sovereign Kernel
          </h2>
          <div className="flex flex-col gap-2 items-center">
            <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest text-nexus-gold font-bold animate-pulse">
              <ShieldCheck size={13} />
              <span>Verifying Security Protocols</span>
            </div>
            <p className="text-[11px] text-text-dim/50 font-mono leading-relaxed max-w-[200px]">
              Synthesizing neural pathways…
            </p>
          </div>
        </motion.div>

        <div className="relative w-48 h-1 bg-nexus-surface rounded-full mt-10 overflow-hidden border border-border/10">
          <motion.div
            className="absolute inset-y-0 left-0 bg-nexus-gold rounded-full shadow-[0_0_12px_rgba(212,175,55,0.5)]"
            initial={{ width: '0%' }}
            animate={{ width: '100%' }}
            transition={{ duration: 2.2, ease: 'easeInOut' }}
          />
        </div>
      </div>
    </div>
  );
}
