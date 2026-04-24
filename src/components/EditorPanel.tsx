import React, { useState, useEffect } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { vscodeDark } from '@uiw/codemirror-theme-vscode';
import { useNexus } from '../NexusContext';
import { Save, X, Code, FileCode, Hash, Globe } from 'lucide-react';
import { cn } from '../utils';

const getExt = (p: string) => p.split('.').pop() || '';

const getLang = (p: string) => {
  const ext = getExt(p);
  if (['js', 'ts', 'tsx', 'jsx'].includes(ext)) return [javascript({ jsx: true, typescript: true })];
  if (ext === 'html') return [html()];
  if (ext === 'css') return [css()];
  return [javascript()];
};

const getIcon = (p: string) => {
  const ext = getExt(p);
  if (ext === 'html') return <Globe size={13} className="text-orange-400" />;
  if (ext === 'css') return <Hash size={13} className="text-blue-400" />;
  if (['js', 'ts', 'tsx', 'jsx'].includes(ext)) return <Code size={13} className="text-nexus-cyan" />;
  return <FileCode size={13} className="text-text-dim/50" />;
};

export function EditorPanel() {
  const { state, setState, addNotification } = useNexus();
  const [content, setContent] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);

  useEffect(() => {
    if (state.activeFileId) loadFile(state.activeFileId);
    else { setContent(''); setIsDirty(false); }
  }, [state.activeFileId]);

  const loadFile = async (path: string) => {
    try {
      const res = await fetch(`/api/files/content?path=${encodeURIComponent(path)}&sessionId=${state.currentSessionId}`);
      const data = await res.json();
      setContent(data.content || '');
      setIsDirty(false);
    } catch {}
  };

  const handleSave = async () => {
    if (!state.activeFileId) return;
    setIsSaving(true);
    try {
      await fetch('/api/files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: state.activeFileId, content, sessionId: state.currentSessionId }),
      });
      setIsDirty(false);
      setState(prev => ({ ...prev, previewVersion: prev.previewVersion + 1 }));
      // We'll skip the toast for auto-save to avoid noise, but maybe add a subtle indicator
    } catch {
      addNotification('error', 'Auto-Save Failed', state.activeFileId || '');
    } finally {
      setIsSaving(false);
    }
  };

  // Auto-Save Effect (Autopilot Protocol)
  useEffect(() => {
    if (!isDirty || !state.activeFileId) return;
    const timer = setTimeout(handleSave, 1000);
    return () => clearTimeout(timer);
  }, [content, state.activeFileId, isDirty]);

  // Ctrl+S shortcut
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); handleSave(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state.activeFileId, content]);

  const closeFile = (path: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setState(prev => {
      const remaining = prev.openFileIds.filter(id => id !== path);
      const nextActive = prev.activeFileId === path ? (remaining[0] || null) : prev.activeFileId;
      return { ...prev, openFileIds: remaining, activeFileId: nextActive };
    });
  };

  return (
    <div className="flex flex-1 flex-col bg-[#050508] overflow-hidden min-w-0">
      {/* Tabs */}
      <div className="flex h-9 items-center bg-[#08080d] border-b border-white/5 overflow-x-auto shrink-0" style={{ scrollbarWidth: 'none' }}>
        {state.openFileIds.map(path => (
          <div
            key={path}
            onClick={() => setState(prev => ({ ...prev, activeFileId: path }))}
            className={cn(
              'group relative flex min-w-[100px] max-w-[180px] h-full items-center gap-1.5 px-3 border-r border-white/5 cursor-pointer transition-all shrink-0',
              state.activeFileId === path ? 'bg-[#050508] text-white' : 'text-white/30 hover:bg-white/[0.03] hover:text-white/60'
            )}
          >
            {getIcon(path)}
            <span className="text-[11px] font-medium truncate">{path.split('/').pop()}</span>
            <button
              onClick={(e) => closeFile(path, e)}
              className="ml-auto opacity-0 group-hover:opacity-100 h-4 w-4 flex items-center justify-center rounded hover:bg-white/10"
            ><X size={10} /></button>
            {state.activeFileId === path && (
              <div className="absolute top-0 left-0 right-0 h-[2px] bg-nexus-cyan shadow-[0_0_8px_rgba(0,242,255,0.4)]" />
            )}
          </div>
        ))}
      </div>

      {/* Toolbar */}
      {state.activeFileId && (
        <div className="flex h-8 items-center justify-between px-4 border-b border-white/5 bg-white/[0.01] shrink-0">
          <div className="flex items-center gap-2 text-[9px] font-mono text-white/20 uppercase tracking-widest">
            <span className="text-nexus-cyan/30">dna://</span>
            <span>{state.activeFileId}</span>
            {isDirty && <span className="text-nexus-gold/60">• unsaved</span>}
          </div>
          <button
            onClick={handleSave}
            disabled={isSaving}
            className={cn('flex items-center gap-1.5 text-[10px] font-bold uppercase transition-colors', isDirty ? 'text-nexus-gold hover:text-white' : 'text-text-dim/40 hover:text-text-dim')}
          >
            <Save size={11} className={isSaving ? 'animate-spin' : ''} />
            {isDirty ? 'Save Changes' : 'Saved'}
          </button>
        </div>
      )}

      {/* Editor */}
      <div className="flex-1 overflow-hidden">
        {state.activeFileId ? (
          <CodeMirror
            value={content}
            height="100%"
            theme={vscodeDark}
            extensions={getLang(state.activeFileId)}
            onChange={(val) => { setContent(val); setIsDirty(true); }}
            basicSetup={{ lineNumbers: true, foldGutter: true, dropCursor: true, allowMultipleSelections: true, indentOnInput: true, bracketMatching: true, autocompletion: true }}
            className="h-full text-[13px]"
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center text-center p-12">
            <Code size={52} className="text-white/4 mb-4" />
            <h4 className="text-[12px] font-bold text-white/15 uppercase tracking-[0.2em]">Neural Architect Standby</h4>
            <p className="mt-2 text-[10px] text-white/8 max-w-[200px] leading-relaxed">
              Select or create a file in the Explorer to begin editing.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
