import React, { useRef, useEffect, useState } from 'react';
import { useNexus } from '../NexusContext';
import { 
  TerminalSquare, Maximize2, Minimize2, RefreshCw, Plus, 
  Columns, X, Copy, Trash2, Palette, Check, LayoutGrid, AlertCircle
} from 'lucide-react';
import { cn } from '../utils';
import { motion, AnimatePresence } from 'motion/react';

const THEMES_CONFIG = {
  nexus:     { name: 'Nexus Dark+', bg: '#1e1e1e', text: '#d4d4d4', prompt: '#d4af37', border: '#333333' },
  monokai:   { name: 'Monokai', bg: '#272822', text: '#f8f8f2', prompt: '#e6db74', border: '#3e3d32' },
  dracula:   { name: 'Dracula', bg: '#282a36', text: '#f8f8f2', prompt: '#bd93f9', border: '#44475a' },
  nord:      { name: 'Nord', bg: '#2e3440', text: '#d8dee9', prompt: '#88c0d0', border: '#3b4252' },
  matrix:    { name: 'Matrix', bg: '#000d00', text: '#00cc44', prompt: '#00ff55', border: '#003300' },
  github:    { name: 'GitHub Dark', bg: '#0d1117', text: '#c9d1d9', prompt: '#58a6ff', border: '#30363d' },
  onedark:   { name: 'One Dark', bg: '#282c34', text: '#abb2bf', prompt: '#61afef', border: '#3e4451' },
  solarized: { name: 'Solarized Dark', bg: '#002b36', text: '#839496', prompt: '#b58900', border: '#073642' },
  moonlight: { name: 'Moonlight', bg: '#212333', text: '#b4b4b4', prompt: '#82aaff', border: '#2f334d' },
} as const;

export function TerminalPanel() {
  const { state, setState, switchTerminal, closeTerminal, socketsRef } = useNexus();
  const [isExpanded, setIsExpanded] = useState(false);
  const [isSplit, setIsSplit] = useState(false);
  const [terminalTheme, setTerminalTheme] = useState<keyof typeof THEMES_CONFIG>(() => {
    if (typeof window === 'undefined') return 'nexus';
    const saved = localStorage.getItem('nexus.terminalTheme') as keyof typeof THEMES_CONFIG | null;
    return saved && saved in THEMES_CONFIG ? saved : 'nexus';
  });
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
  const themePickerRef = useRef<HTMLDivElement>(null);

  // Persist + close on outside click + Esc
  useEffect(() => {
    try { localStorage.setItem('nexus.terminalTheme', terminalTheme); } catch {}
  }, [terminalTheme]);

  useEffect(() => {
    if (!themeMenuOpen) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      const el = themePickerRef.current;
      if (el && !el.contains(e.target as Node)) setThemeMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setThemeMenuOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [themeMenuOpen]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollRefSplit = useRef<HTMLDivElement>(null);
  
  const activeTab = state.terminalTabs.find(t => t.id === state.activeTerminalId);
  const sessionTab = state.terminalTabs.find(t => t.id === state.currentSessionId);
  
  const splitTabId = state.terminalTabs.find(t => t.id !== state.activeTerminalId)?.id || state.currentSessionId;
  const splitTab = state.terminalTabs.find(t => t.id === splitTabId);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [activeTab?.output]);

  useEffect(() => {
    if (scrollRefSplit.current) scrollRefSplit.current.scrollTop = scrollRefSplit.current.scrollHeight;
  }, [splitTab?.output]);

  const handleCopy = (id: string, lines: string[]) => {
    navigator.clipboard.writeText(lines.join('\n'));
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleAddTerminal = () => {
    const newId = `term-${Math.random().toString(36).slice(2, 9)}`;
    setState(prev => ({
      ...prev,
      terminalTabs: [...prev.terminalTabs, { id: newId, title: 'Kernel-Ext', output: ['> Remote kernel bound...', '> Awaiting instructions...'] }],
      activeTerminalId: newId
    }));
  };

  const [inputValues, setInputValues] = useState<Record<string, string>>({});
  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const sendCommand = (id: string, cmd: string) => {
    const ws = socketsRef.current[id];
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(cmd + '\n');
    }
  };

  const handleKeyDown = (id: string, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      const val = inputValues[id] || '';
      sendCommand(id, val);
      setInputValues(prev => ({ ...prev, [id]: '' }));
    }
  };

  const renderTerminalOutput = (tab: any, ref: any) => {
    const theme = THEMES_CONFIG[terminalTheme as keyof typeof THEMES_CONFIG] || THEMES_CONFIG.nexus;
    
    return (
      <div 
        ref={ref}
        onClick={() => inputRefs.current[tab?.id]?.focus()}
        className="flex-1 overflow-y-auto p-4 custom-scrollbar text-[12px] leading-relaxed transition-colors font-mono cursor-text"
        style={{ background: theme.bg, color: theme.text }}
      >
        {tab?.output.map((line: string, i: number) => (
          <div key={i} className="flex gap-3 min-h-[1.5em] whitespace-pre-wrap">
            <span className="opacity-20 select-none w-6 shrink-0 text-right font-mono">{i + 1}</span>
            <span 
              className="flex-1 break-all"
              dangerouslySetInnerHTML={{ __html: ansiToHtml(line, terminalTheme as any) }}
            />
          </div>
        ))}

        {/* Input line */}
        <div className="flex items-center gap-2 mt-1">
          <span className="shrink-0 font-bold select-none" style={{ color: theme.prompt }}>
            {terminalTheme === 'matrix' ? '>' : terminalTheme === 'dracula' ? 'λ' : terminalTheme === 'nord' ? '→' : 'nexus$'}
          </span>
          <input
            ref={el => inputRefs.current[tab?.id] = el}
            type="text"
            value={inputValues[tab?.id] || ''}
            onChange={(e) => setInputValues(prev => ({ ...prev, [tab?.id]: e.target.value }))}
            onKeyDown={(e) => handleKeyDown(tab?.id, e)}
            className="flex-1 bg-transparent border-none outline-none font-mono"
            style={{ color: theme.text, caretColor: theme.prompt }}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        
        {(!tab || tab.output.length === 0) && (
          <div className="flex flex-col items-center justify-center py-12 opacity-20">
            <RefreshCw size={24} className="animate-spin mb-4" />
            <p className="text-[10px] uppercase tracking-widest font-bold">Synchronizing Socket...</p>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className={cn(
      "flex flex-col bg-nexus-black font-mono transition-all border-t border-border",
      isExpanded ? "fixed inset-0 h-screen w-screen mt-0 border-t-0 z-[1000] p-4 bg-nexus-black/60 backdrop-blur-3xl" : "h-full"
    )}>
      <div className={cn(
        "flex flex-col h-full overflow-hidden",
        isExpanded ? "bg-nexus-black rounded-3xl border border-white/10 shadow-[0_0_100px_rgba(0,0,0,0.5)]" : ""
      )}>
        {/* Tab Strip */}
        <div className="flex items-center justify-between px-2 h-10 bg-bg-surface/80 backdrop-blur-md border-b border-border shrink-0 select-none">
          <div className="flex items-center gap-1 overflow-x-auto no-scrollbar max-w-[70%]">
            {state.terminalTabs.map(tab => (
              <div
                key={tab.id}
                onClick={() => switchTerminal(tab.id)}
                className={cn(
                  "group flex items-center gap-2 h-8 px-3 rounded-t-lg text-[10px] font-bold uppercase tracking-wider transition-all cursor-pointer border-x border-t",
                  state.activeTerminalId === tab.id 
                    ? "bg-nexus-black border-border text-nexus-gold" 
                    : "bg-transparent border-transparent text-text-dim hover:bg-white/5 hover:text-text-main"
                )}
              >
                <TerminalSquare size={12} className={state.activeTerminalId === tab.id ? "text-nexus-gold" : "text-text-dim"} />
                <span className="truncate max-w-[80px]">{tab.title}</span>
                <X 
                  size={10} 
                  className="opacity-0 group-hover:opacity-100 hover:text-red-400 transition-opacity" 
                  onClick={(e) => { e.stopPropagation(); closeTerminal(tab.id); }}
                />
              </div>
            ))}
            <button 
              onClick={handleAddTerminal}
              className="p-1.5 rounded-md hover:bg-white/10 text-text-dim hover:text-white transition-all ml-1"
            >
              <Plus size={14} />
            </button>
          </div>
          
          <div className="flex items-center gap-1">
            {/* Theme Switcher — click-toggle (desktop dropdown / mobile bottom sheet) */}
            <div className="relative mr-2" ref={themePickerRef}>
              <button
                onClick={() => setThemeMenuOpen(v => !v)}
                aria-haspopup="menu"
                aria-expanded={themeMenuOpen}
                className={cn(
                  "p-2 rounded-lg transition-all",
                  themeMenuOpen
                    ? "bg-nexus-gold/15 text-nexus-gold"
                    : "hover:bg-white/5 text-text-dim"
                )}
                title="Terminal Theme"
              >
                <Palette size={14} />
              </button>

              {/* Desktop dropdown (≥ sm). Anchored ABOVE the palette button. */}
              <AnimatePresence>
                {themeMenuOpen && (
                  <motion.div
                    key="desktop-theme-menu"
                    initial={{ opacity: 0, y: 4, scale: 0.97 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 4, scale: 0.97 }}
                    transition={{ duration: 0.12 }}
                    role="menu"
                    className="hidden sm:flex absolute right-0 bottom-full mb-1.5 flex-col bg-bg-surface/98 backdrop-blur-xl border border-nexus-border rounded-xl p-1 shadow-2xl z-[2000] min-w-[180px] max-h-[60vh] overflow-y-auto custom-scrollbar"
                  >
                    {(Object.entries(THEMES_CONFIG) as [keyof typeof THEMES_CONFIG, any][]).map(([key, th]) => (
                      <button
                        key={key}
                        role="menuitemradio"
                        aria-checked={terminalTheme === key}
                        onClick={() => { setTerminalTheme(key); setThemeMenuOpen(false); }}
                        className={cn(
                          "flex items-center justify-between px-3 py-2 rounded-lg text-[10px] font-bold uppercase tracking-widest transition-all text-left",
                          terminalTheme === key ? "bg-nexus-gold/10 text-nexus-gold" : "hover:bg-white/5 text-text-dim"
                        )}
                      >
                        <div className="flex items-center gap-2">
                          <div className="w-2.5 h-2.5 rounded-full ring-1 ring-white/10" style={{ background: th.prompt }} />
                          <span>{th.name}</span>
                        </div>
                        {terminalTheme === key && <Check size={11} />}
                      </button>
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Mobile bottom sheet (< sm). Renders into the document so it
                  isn't clipped by overflowing parents. */}
              <AnimatePresence>
                {themeMenuOpen && (
                  <motion.div
                    key="mobile-theme-sheet"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.15 }}
                    className="sm:hidden fixed inset-0 z-[2100] bg-black/60 backdrop-blur-sm"
                    onClick={() => setThemeMenuOpen(false)}
                  >
                    <motion.div
                      initial={{ y: '100%' }}
                      animate={{ y: 0 }}
                      exit={{ y: '100%' }}
                      transition={{ type: 'spring', damping: 28, stiffness: 320 }}
                      onClick={(e) => e.stopPropagation()}
                      className="absolute bottom-0 inset-x-0 rounded-t-2xl bg-bg-surface border-t border-nexus-border shadow-2xl pb-[env(safe-area-inset-bottom,0)]"
                      role="dialog"
                      aria-label="Choose terminal theme"
                    >
                      <div className="flex items-center justify-between px-4 pt-3 pb-2 border-b border-white/5">
                        <div className="flex items-center gap-2">
                          <Palette size={13} className="text-nexus-gold" />
                          <span className="text-[10px] font-black uppercase tracking-[0.2em] text-text-main">
                            Terminal Theme
                          </span>
                        </div>
                        <button
                          onClick={() => setThemeMenuOpen(false)}
                          className="p-1.5 rounded-lg hover:bg-white/10 text-text-dim"
                          aria-label="Close"
                        >
                          <X size={14} />
                        </button>
                      </div>
                      <div className="px-2 py-2 max-h-[55vh] overflow-y-auto custom-scrollbar">
                        {(Object.entries(THEMES_CONFIG) as [keyof typeof THEMES_CONFIG, any][]).map(([key, th]) => (
                          <button
                            key={key}
                            onClick={() => { setTerminalTheme(key); setThemeMenuOpen(false); }}
                            className={cn(
                              "w-full flex items-center justify-between px-3 py-3 rounded-xl text-[12px] font-bold tracking-wide transition-all text-left",
                              terminalTheme === key ? "bg-nexus-gold/10 text-nexus-gold" : "hover:bg-white/5 text-text-main"
                            )}
                          >
                            <div className="flex items-center gap-3">
                              <div className="w-4 h-4 rounded-md ring-1 ring-white/10" style={{ background: th.prompt }} />
                              <div className="flex flex-col">
                                <span className="text-[12px]">{th.name}</span>
                                <span className="text-[9px] uppercase tracking-widest opacity-50" style={{ color: th.text }}>{th.bg}</span>
                              </div>
                            </div>
                            {terminalTheme === key && <Check size={14} />}
                          </button>
                        ))}
                      </div>
                    </motion.div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            <button 
              onClick={() => handleCopy(state.activeTerminalId!, activeTab?.output || [])}
              className="p-2 rounded-lg hover:bg-white/5 text-text-dim transition-all"
              title="Copy Output"
            >
              {copiedId === state.activeTerminalId ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
            </button>

            <button 
              onClick={() => setIsSplit(!isSplit)}
              className={cn("p-2 rounded-lg transition-all", isSplit ? "bg-nexus-gold/10 text-nexus-gold" : "hover:bg-white/5 text-text-dim")}
              title="Split Terminal"
            >
              <Columns size={14} />
            </button>

            <button 
              onClick={() => setIsExpanded(!isExpanded)}
              className="p-2 rounded-lg hover:bg-white/5 text-text-dim transition-all"
              title={isExpanded ? "Collapse" : "Maximize"}
            >
              {isExpanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
            
            <div className="w-px h-4 bg-white/10 mx-1" />

            <button 
              className="p-2 rounded-lg hover:bg-red-500/10 text-text-dim hover:text-red-400 transition-all"
              title="Kill Terminal"
            >
              <Trash2 size={14} />
            </button>
          </div>
        </div>

        {/* Primary Workspace */}
        <div className={cn("flex-1 flex overflow-hidden", isSplit ? "flex-col md:flex-row" : "flex-col")}>
          {renderTerminalOutput(activeTab, scrollRef)}
          
          {isSplit && (
            <div className="flex flex-col flex-1 border-t md:border-t-0 md:border-l border-border relative">
               <div className="absolute top-2 right-2 z-10 flex gap-2">
                  <span className="text-[9px] font-mono text-nexus-gold/50 bg-nexus-gold/5 px-2 py-0.5 rounded border border-nexus-gold/10">SPLIT_KRNL</span>
                  <button onClick={() => setIsSplit(false)} className="p-1 hover:bg-white/10 rounded transition-all text-text-dim">
                    <X size={10} />
                  </button>
               </div>
               {renderTerminalOutput(splitTab, scrollRefSplit)}
            </div>
          )}
        </div>

        {/* StatusBar */}
        <div className="h-6 bg-bg-deep border-t border-border px-3 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-1.5">
              <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              <span className="text-[9px] font-bold text-text-dim uppercase tracking-tighter">Socket: Connected</span>
            </div>
            <span className="text-[9px] font-mono text-text-dim/30">UTF-8 • shell/bash • {state.activeTerminalId}</span>
          </div>
          <div className="flex items-center gap-3 text-[9px] font-bold uppercase tracking-tighter text-text-dim/50">
            <span>Row: {activeTab?.output.length || 0}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// Full ANSI escape code → HTML conversion
function ansiToHtml(text: string, theme: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Color map
  const fg: Record<string, string> = {
    '30': '#3d3d4a', '31': '#ff5555', '32': '#50fa7b', '33': '#f1fa8c',
    '34': '#6272a4', '35': '#ff79c6', '36': '#8be9fd', '37': '#f8f8f2',
    '90': '#6272a4', '91': '#ff6e6e', '92': '#69ff94', '93': '#ffffa5',
    '94': '#d6acff', '95': '#ff92df', '96': '#a4ffff', '97': '#ffffff',
  };

  if (theme === 'matrix') {
    fg['32'] = '#00ff55'; fg['33'] = '#33ff33'; fg['92'] = '#00cc33';
  }
  if (theme === 'nord') {
    fg['32'] = '#a3be8c'; fg['31'] = '#bf616a'; fg['33'] = '#ebcb8b'; fg['36'] = '#88c0d0';
  }

  const bg: Record<string, string> = {
    '40': '#21222c', '41': '#ff5555', '42': '#50fa7b', '43': '#f1fa8c',
    '44': '#bd93f9', '45': '#ff79c6', '46': '#8be9fd', '47': '#f8f8f2',
  };

  let result = escaped;
  let openTags = 0;

  result = result.replace(/\x1b\[([0-9;]*)m/g, (_, codes) => {
    if (codes === '' || codes === '0') {
      const close = '</span>'.repeat(openTags);
      openTags = 0;
      return close;
    }
    const parts = codes.split(';');
    let style = '';
    for (let i = 0; i < parts.length; i++) {
      const c = parts[i];
      if (c === '1') style += 'font-weight:bold;';
      else if (c === '2') style += 'opacity:0.7;';
      else if (fg[c]) style += `color:${fg[c]};`;
      else if (bg[c]) style += `background:${bg[c]};`;
      else if (c === '38' && parts[i + 1] === '5') {
        style += `color:${xterm256(parseInt(parts[i + 2] || '7'))};`; i += 2;
      } else if (c === '48' && parts[i + 1] === '5') {
        style += `background:${xterm256(parseInt(parts[i + 2] || '0'))};`; i += 2;
      }
    }
    if (style) { openTags++; return `<span style="${style}">`; }
    return '';
  });

  if (openTags > 0) result += '</span>'.repeat(openTags);
  return result;
}

function xterm256(n: number): string {
  if (n < 8) return ['#000','#800000','#008000','#808000','#000080','#800080','#008080','#c0c0c0'][n];
  if (n < 16) return ['#808080','#ff0000','#00ff00','#ffff00','#0000ff','#ff00ff','#00ffff','#ffffff'][n - 8];
  if (n < 232) {
    n -= 16;
    const r = Math.floor(n / 36) * 51;
    const g = Math.floor((n % 36) / 6) * 51;
    const b = (n % 6) * 51;
    return `rgb(${r},${g},${b})`;
  }
  const v = 8 + (n - 232) * 10;
  return `rgb(${v},${v},${v})`;
}
