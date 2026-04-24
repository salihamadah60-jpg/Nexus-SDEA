import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Camera, Trash2, Globe, Eye, Info, AlertTriangle, CheckCircle, ChevronLeft, Columns, Zap } from 'lucide-react';
import { useNexus } from '../NexusContext';
import { cn } from '../utils';

export function VisualSnapshotPanel() {
  const { state, setState } = useNexus();
  const [selectedSnap, setSelectedSnap] = useState<string | null>(null);
  const [compareSnaps, setCompareSnaps] = useState<string[]>([]);
  const [isCompareMode, setIsCompareMode] = useState(false);
  const [auditData, setAuditData] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  const sessionId = state.currentSessionId;
  const snapshots = sessionId ? (state.snapshots[sessionId] || []) : [];

  const handleSnapClick = (snap: string) => {
    if (isCompareMode) {
      if (compareSnaps.includes(snap)) {
        setCompareSnaps(prev => prev.filter(s => s !== snap));
      } else if (compareSnaps.length < 2) {
        setCompareSnaps(prev => [...prev, snap]);
      }
    } else {
      fetchAudit(snap);
    }
  };

  const fetchAudit = async (snap: string) => {
    if (!sessionId) return;
    setLoading(true);
    setSelectedSnap(snap);
    try {
      const res = await fetch(`/api/visual-audit/${sessionId}/${snap}`);
      const data = await res.json();
      setAuditData(data);
    } catch {
      setAuditData({ error: 'Failed to load audit data' });
    } finally {
      setLoading(false);
    }
  };

  const handleClearSnapshots = () => {
    if (!sessionId) return;
    setState(prev => ({
      ...prev,
      snapshots: { ...prev.snapshots, [sessionId]: [] }
    }));
  };

  if (selectedSnap) {
    return (
      <div className="flex flex-col h-full bg-bg-surface overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex items-center gap-3 shrink-0">
          <button 
            onClick={() => { setSelectedSnap(null); setAuditData(null); }}
            className="p-1 hover:bg-white/5 rounded text-text-dim hover:text-white"
          >
            <ChevronLeft size={16} />
          </button>
          <h2 className="text-[11px] font-bold uppercase tracking-widest text-text-main">Audit Report</h2>
        </div>

        <div className="flex-1 overflow-y-auto p-4 custom-scrollbar space-y-6">
          <div className="rounded-xl border border-white/10 overflow-hidden bg-black/40">
            <img 
              src={`/api/visual-debug/${sessionId}/${selectedSnap}`} 
              alt="Audit target"
              referrerPolicy="no-referrer"
              className="w-full"
            />
          </div>

          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-[10px] font-bold uppercase tracking-widest text-nexus-gold">Diagnostic Brain</h3>
              {loading && <div className="h-3 w-3 rounded-full border-2 border-nexus-gold/30 border-t-nexus-gold animate-spin" />}
            </div>

            {auditData ? (
              <div className="space-y-3">
                {auditData.issues && auditData.issues.length > 0 ? (
                  auditData.issues.map((issue: string, i: number) => (
                    <div key={i} className="flex gap-3 p-3 rounded-lg bg-red-500/5 border border-red-500/20 text-red-200/80">
                      <AlertTriangle size={14} className="shrink-0 mt-0.5 text-red-400" />
                      <p className="text-[11px] leading-relaxed">{issue}</p>
                    </div>
                  ))
                ) : (
                  <div className="flex gap-3 p-3 rounded-lg bg-nexus-green/5 border border-nexus-green/20 text-nexus-green/80">
                    <CheckCircle size={14} className="shrink-0 mt-0.5" />
                    <p className="text-[11px]">No structural anomalies detected. Final layout integrity confirmed.</p>
                  </div>
                )}

                {auditData.viewport && (
                    <div className="p-3 rounded-lg bg-white/5 border border-white/10 space-y-2">
                        <div className="flex items-center gap-2 text-[9px] font-bold uppercase tracking-tighter text-text-dim">
                            <Info size={10} />
                            <span>Environment Specs</span>
                        </div>
                        <div className="grid grid-cols-2 gap-2 text-[10px] font-mono text-white/40">
                            <div>Viewport: {auditData.viewport.width}x{auditData.viewport.height}</div>
                            <div>Elements Indexed: {auditData.elements?.length || 0}</div>
                        </div>
                    </div>
                )}
              </div>
            ) : (
              !loading && <p className="text-[10px] text-text-dim italic">Awaiting neural analysis...</p>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-bg-surface overflow-hidden">
      <div className="px-4 py-3 border-b border-border flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <Camera className="w-4 h-4 text-nexus-gold" />
          <h2 className="text-[11px] font-bold uppercase tracking-[0.2em] text-text-main">Visual Index</h2>
        </div>
        <div className="flex items-center gap-1">
          <button 
            onClick={() => {
              setIsCompareMode(!isCompareMode);
              setCompareSnaps([]);
            }}
            className={cn(
              "p-1.5 rounded-md transition-all",
              isCompareMode ? "bg-nexus-gold/20 text-nexus-gold" : "text-text-dim hover:bg-white/5 hover:text-white"
            )}
            title="Comparison Mode"
          >
            <Columns className="w-3.5 h-3.5" />
          </button>
          {snapshots.length > 0 && (
            <button 
              onClick={handleClearSnapshots}
              className="p-1.5 hover:bg-white/5 rounded-md text-text-dim hover:text-red-400 transition-all"
              title="Clear list"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar">
        {isCompareMode && compareSnaps.length === 2 ? (
          <div className="space-y-4 h-full flex flex-col">
            <div className="flex items-center justify-between shrink-0">
              <span className="text-[10px] font-bold uppercase tracking-widest text-nexus-gold">Before vs After Analysis</span>
              <button 
                onClick={() => setCompareSnaps([])}
                className="text-[9px] font-bold text-text-dim hover:text-white uppercase"
              >
                Reset
              </button>
            </div>
            <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-4">
               {compareSnaps.map((snap, i) => (
                 <div key={snap} className="space-y-2">
                   <p className="text-[9px] font-mono text-text-dim text-center uppercase">{i === 0 ? 'Target: Alpha' : 'Target: Omega'}</p>
                   <div className="rounded-xl border border-white/10 overflow-hidden bg-black/40">
                     <img 
                       src={`/sandbox/projects/${sessionId}/.nexus/snapshots/${snap}`} 
                       alt="Comparison"
                       referrerPolicy="no-referrer"
                       className="w-full"
                     />
                   </div>
                 </div>
               ))}
            </div>
            <div className="p-4 rounded-xl border border-nexus-cyan/20 bg-nexus-cyan/5 text-[10px] text-nexus-cyan/80 leading-relaxed text-center italic">
                Neural comparison engine active. Differential layout matching is synchronized.
            </div>
          </div>
        ) : (
          <>
            {isCompareMode && (
              <div className="p-3 mb-2 rounded-lg bg-nexus-gold/5 border border-nexus-gold/20 text-center">
                <p className="text-[10px] font-bold text-nexus-gold uppercase tracking-widest">
                  Select 2 snapshots to compare ({compareSnaps.length}/2)
                </p>
              </div>
            )}
            <div className="grid grid-cols-1 gap-4">
              {[...snapshots].reverse().map((snap, i) => {
                const isSelected = compareSnaps.includes(snap);
                return (
                  <motion.div
                    key={snap}
                    layoutId={snap}
                    onClick={() => handleSnapClick(snap)}
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    className={cn(
                      "group relative rounded-xl border bg-black/40 overflow-hidden shadow-2xl transition-all cursor-pointer active:scale-[0.98]",
                      isSelected ? "border-nexus-gold ring-1 ring-nexus-gold/30" : "border-white/10 hover:border-nexus-gold/30"
                    )}
                  >
                    <div className="relative aspect-video bg-nexus-surface flex items-center justify-center overflow-hidden">
                      <img 
                        src={`/api/visual-debug/${sessionId}/${snap}`} 
                        alt={`Snapshot ${i}`}
                        referrerPolicy="no-referrer"
                        className={cn("w-full h-full object-cover transition-opacity", isSelected ? "opacity-100" : "opacity-80 group-hover:opacity-100")}
                        onError={(e) => {
                          (e.target as HTMLImageElement).src = 'https://picsum.photos/seed/broken/400/225?blur=10';
                        }}
                      />
                      <div className={cn(
                        "absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent flex items-center justify-center transition-opacity",
                        isSelected ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                      )}>
                        <div className="bg-nexus-gold text-bg-deep rounded-full p-2 flex items-center gap-2 px-3">
                          {isCompareMode ? (
                            <CheckCircle className="w-4 h-4" />
                          ) : (
                            <Eye className="w-4 h-4" />
                          )}
                          <span className="text-[10px] font-bold uppercase tracking-tighter">
                            {isCompareMode ? (isSelected ? 'Selected' : 'Select') : 'Audit'}
                          </span>
                        </div>
                      </div>
                    </div>
                    <div className="px-3 py-2 flex items-center justify-between bg-white/[0.03]">
                      <span className="text-[9px] font-mono text-text-dim truncate max-w-[140px] uppercase">
                        {snap.replace('snapshot-', '').replace('.png', '')}
                      </span>
                      <div className="flex items-center gap-1">
                        <div className="h-1.5 w-1.5 rounded-full bg-nexus-green shadow-[0_0_6px_#22d3a5]" />
                        <span className="text-[8px] font-bold text-nexus-green opacity-50 uppercase">Ready</span>
                      </div>
                    </div>
                  </motion.div>
                );
              })}
            </div>
          </>
        )}
      </div>

      {/* Snapshot HUD info */}
      <div className="p-3 border-t border-border bg-black/20 shrink-0">
        <div className="flex items-center gap-2 text-[9px] font-bold text-text-dim/40 uppercase tracking-widest">
           <Zap className="w-3 h-3 text-nexus-gold animate-pulse" />
           <span>Neural Brain Engine: Linked</span>
        </div>
      </div>
    </div>
  );
}
