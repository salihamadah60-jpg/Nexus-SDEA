import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { AlertCircle, CheckCircle2, Info, X, Zap } from 'lucide-react';
import { Notification } from '../types';
import { cn } from '../utils';

interface Props {
  notifications: Notification[];
  removeNotification: (id: string) => void;
}

export function NotificationOverlay({ notifications, removeNotification }: Props) {
  return (
    <div className="fixed top-5 right-5 z-[500] flex flex-col gap-2.5 max-w-sm w-full pointer-events-none">
      <AnimatePresence mode="popLayout">
        {notifications?.map((n) => (
          <motion.div
            key={n.id}
            initial={{ opacity: 0, x: 60, scale: 0.9 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: 20, scale: 0.95 }}
            transition={{ type: 'spring', stiffness: 300, damping: 25 }}
            className={cn(
              'pointer-events-auto flex gap-3 rounded-2xl border p-4 backdrop-blur-xl shadow-2xl',
              n.type === 'error'   && 'bg-red-500/10    border-red-500/20    text-red-400',
              n.type === 'success' && 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400',
              n.type === 'warning' && 'bg-yellow-500/10 border-yellow-500/20 text-yellow-400',
              n.type === 'info'    && 'bg-nexus-gold/8   border-nexus-gold/20  text-nexus-gold',
            )}
          >
            <div className="shrink-0 mt-0.5">
              {n.type === 'error'   && <AlertCircle  className="w-4 h-4" />}
              {n.type === 'success' && <CheckCircle2 className="w-4 h-4" />}
              {n.type === 'info'    && <Info          className="w-4 h-4" />}
              {n.type === 'warning' && <Zap           className="w-4 h-4" />}
            </div>
            <div className="flex-1 min-w-0">
              <h4 className="text-[9px] font-black uppercase tracking-widest mb-1 opacity-70">{n.type}</h4>
              <p className="text-[12px] font-medium leading-snug">{n.message}</p>
              {n.description && (
                <p className="text-[10px] opacity-50 mt-1 italic truncate">{n.description}</p>
              )}
            </div>
            <button
              onClick={() => removeNotification(n.id)}
              className="shrink-0 opacity-40 hover:opacity-100 transition-opacity"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
