import React, { useState } from 'react';
import {
  FolderTree, FileCode, ChevronRight, ChevronDown,
  FilePlus, FolderPlus, RefreshCw, Trash2, Edit2, Check, Search,
  Copy, Scissors, ClipboardPaste
} from 'lucide-react';
import { useNexus } from '../NexusContext';
import { cn } from '../utils';
import { FileItem } from '../types';

export function FileExplorer() {
  const { state, setState, refreshFiles, addNotification } = useNexus();
  const [search, setSearch] = useState('');

  const handleOpenFile = async (file: FileItem) => {
    if (file.type === 'folder') return;
    try {
      const res = await fetch(`/api/files/content?path=${encodeURIComponent(file.id)}&sessionId=${state.currentSessionId}`);
      const data = await res.json();
      setState(prev => ({
        ...prev,
        files: prev.files.map(f => f.id === file.id ? { ...f, content: data.content } : f),
        activeFileId: file.id,
        openFileIds: prev.openFileIds.includes(file.id) ? prev.openFileIds : [...prev.openFileIds, file.id],
      }));
    } catch {}
  };

  const handleCreate = async (type: 'file' | 'folder') => {
    const name = prompt(`Enter ${type} name:`);
    if (!name || !state.currentSessionId) return;
    try {
      await fetch('/api/files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: name, sessionId: state.currentSessionId, isFolder: type === 'folder' }),
      });
      refreshFiles();
    } catch {}
  };

  // Paste at the project root.
  const handlePasteAtRoot = async () => {
    const clip = state.fileClipboard;
    if (!clip || !state.currentSessionId) return;
    const baseName = clip.srcPath.split('/').pop() || 'pasted';
    const destPath = baseName;
    try {
      const res = await fetch('/api/files/copy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: state.currentSessionId,
          srcPath: clip.srcPath,
          destPath,
          move: clip.mode === 'cut',
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Paste failed');
      addNotification('success', clip.mode === 'cut' ? 'Moved' : 'Copied', `${clip.srcPath} → ${destPath}`);
      // Cut clears the clipboard; copy keeps it for repeated paste.
      if (clip.mode === 'cut') setState(prev => ({ ...prev, fileClipboard: null }));
      refreshFiles();
    } catch (err: any) {
      addNotification('error', 'Paste failed', err.message);
    }
  };

  const filtered = search
    ? state.files.filter(f => f.name.toLowerCase().includes(search.toLowerCase()))
    : state.files.filter(f => !f.parentId || f.parentId === 'root');

  const clipboardActive = !!state.fileClipboard;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 pt-4 pb-2 shrink-0">
        <h3 className="nexus-label">Explorer</h3>
        <div className="flex items-center gap-1">
          <button
            onClick={() => handleCreate('file')}
            className="p-1 px-1.5 rounded bg-white/[0.03] border border-white/5 text-text-dim hover:text-nexus-cyan hover:border-nexus-cyan/30 transition-all shadow-sm"
            title="New File"
          >
            <FilePlus size={14} />
          </button>
          <button
            onClick={() => handleCreate('folder')}
            className="p-1 px-1.5 rounded bg-white/[0.03] border border-white/5 text-text-dim hover:text-nexus-gold hover:border-nexus-gold/30 transition-all shadow-sm"
            title="New Folder"
          >
            <FolderPlus size={14} />
          </button>
          <button
            onClick={handlePasteAtRoot}
            disabled={!clipboardActive}
            className={cn(
              "p-1 px-1.5 rounded border transition-all shadow-sm",
              clipboardActive
                ? "bg-nexus-gold/10 border-nexus-gold/30 text-nexus-gold hover:bg-nexus-gold/20"
                : "bg-white/[0.03] border-white/5 text-text-dim/30 cursor-not-allowed"
            )}
            title={clipboardActive ? `Paste ${state.fileClipboard!.mode === 'cut' ? '(move)' : '(copy)'}: ${state.fileClipboard!.srcPath}` : 'Clipboard empty'}
          >
            <ClipboardPaste size={14} />
          </button>
          <button
            onClick={refreshFiles}
            className="p-1 px-1.5 rounded bg-white/[0.03] border border-white/5 text-text-dim hover:text-nexus-green hover:border-nexus-green/30 transition-all shadow-sm"
            title="Refresh"
          >
            <RefreshCw size={14} />
          </button>
        </div>
      </div>

      {/* Clipboard pill */}
      {clipboardActive && (
        <div className="mx-3 mb-1 px-2 py-1 rounded bg-nexus-gold/5 border border-nexus-gold/20 flex items-center justify-between text-[10px]">
          <div className="flex items-center gap-1.5 text-nexus-gold/80 truncate">
            {state.fileClipboard!.mode === 'cut' ? <Scissors size={10} /> : <Copy size={10} />}
            <span className="truncate font-mono">{state.fileClipboard!.srcPath}</span>
          </div>
          <button
            onClick={() => setState(prev => ({ ...prev, fileClipboard: null }))}
            className="text-text-dim/60 hover:text-red-400 ml-2"
            title="Clear clipboard"
          >
            ×
          </button>
        </div>
      )}

      {/* Search */}
      <div className="px-3 py-2 shrink-0">
        <div className="flex items-center gap-2 rounded-lg bg-white/[0.04] border border-white/8 px-2.5 py-1.5">
          <Search size={11} className="text-text-dim/40 shrink-0" />
          <input
            type="text"
            placeholder="Search files…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1 bg-transparent text-[11px] text-text-main placeholder:text-text-dim/30 outline-none"
          />
        </div>
      </div>

      {/* File Tree */}
      <div className="flex-1 overflow-y-auto px-2 pb-2 custom-scrollbar">
        {filtered.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-text-dim/20">
            <FolderTree size={28} className="mb-2" />
            <p className="text-[10px] uppercase tracking-widest">
              {state.currentSessionId ? 'Sandbox Empty' : 'No session active'}
            </p>
          </div>
        )}
        {(search ? filtered : state.files.filter(f => !f.parentId || f.parentId === 'root')).map(file => (
          <FileNode
            key={file.id}
            file={file}
            allFiles={state.files}
            activeId={state.activeFileId}
            onOpen={handleOpenFile}
          />
        ))}
      </div>
    </div>
  );
}

function FileNode({ file, allFiles, activeId, onOpen }: {
  file: FileItem; allFiles: FileItem[]; activeId: string | null; onOpen: (f: FileItem) => void;
}) {
  const { state, setState, refreshFiles, addNotification } = useNexus();
  const [isOpen, setIsOpen] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [newName, setNewName] = useState(file.name);

  const isFolder = file.type === 'folder';
  const isActive = file.id === activeId;
  const children = allFiles.filter(f => f.parentId === file.id);
  const isClippedHere = state.fileClipboard?.srcPath === file.id;

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!window.confirm(`Delete "${file.name}"?`)) return;
    try {
      await fetch(`/api/files?path=${encodeURIComponent(file.id)}&sessionId=${state.currentSessionId}`, { method: 'DELETE' });
      refreshFiles();
    } catch {}
  };

  const handleRename = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (newName === file.name) { setIsRenaming(false); return; }
    try {
      const newPath = file.id.replace(file.name, newName);
      await fetch('/api/files/rename', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oldPath: file.id, newPath, sessionId: state.currentSessionId }),
      });
      setIsRenaming(false);
      refreshFiles();
    } catch {}
  };

  const setClipboard = (mode: 'copy' | 'cut') => (e: React.MouseEvent) => {
    e.stopPropagation();
    setState(prev => ({ ...prev, fileClipboard: { srcPath: file.id, mode } }));
    addNotification('info', mode === 'cut' ? 'Cut to clipboard' : 'Copied to clipboard', file.id);
  };

  // Paste INTO this folder.
  const pasteInto = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const clip = state.fileClipboard;
    if (!clip || !state.currentSessionId) return;
    const baseName = clip.srcPath.split('/').pop() || 'pasted';
    const destPath = `${file.id.replace(/\/$/, '')}/${baseName}`.replace(/^\/+/, '');
    try {
      const res = await fetch('/api/files/copy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: state.currentSessionId,
          srcPath: clip.srcPath,
          destPath,
          move: clip.mode === 'cut',
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Paste failed');
      addNotification('success', clip.mode === 'cut' ? 'Moved' : 'Copied', `→ ${destPath}`);
      if (clip.mode === 'cut') setState(prev => ({ ...prev, fileClipboard: null }));
      refreshFiles();
    } catch (err: any) {
      addNotification('error', 'Paste failed', err.message);
    }
  };

  return (
    <div className="flex flex-col">
      <div
        onClick={() => isFolder ? setIsOpen(v => !v) : onOpen(file)}
        className={cn(
          'group flex items-center gap-1.5 rounded-md px-2 py-1.5 cursor-pointer transition-all text-[12px]',
          isActive ? 'bg-nexus-cyan/8 text-nexus-cyan' : 'text-text-dim hover:bg-white/[0.04] hover:text-text-main',
          isClippedHere && state.fileClipboard?.mode === 'cut' && 'opacity-50 italic'
        )}
      >
        <span className="w-4 flex items-center justify-center shrink-0">
          {isFolder
            ? (isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />)
            : <FileCode size={12} className={isActive ? 'text-nexus-cyan' : 'text-text-dim/50'} />
          }
        </span>
        {isRenaming ? (
          <form onSubmit={handleRename} className="flex-1 flex items-center gap-1" onClick={e => e.stopPropagation()}>
            <input
              autoFocus
              value={newName}
              onChange={e => setNewName(e.target.value)}
              className="flex-1 nexus-input text-[11px] py-0.5 h-auto"
            />
            <button type="submit"><Check size={11} className="text-nexus-gold" /></button>
          </form>
        ) : (
          <>
            <span className="truncate flex-1">{file.name}</span>
            <div className="hidden group-hover:flex items-center gap-1 ml-1">
              <button onClick={setClipboard('copy')} className="p-0.5 hover:text-nexus-cyan" title="Copy"><Copy size={11} /></button>
              <button onClick={setClipboard('cut')} className="p-0.5 hover:text-nexus-gold" title="Cut"><Scissors size={11} /></button>
              {isFolder && state.fileClipboard && (
                <button onClick={pasteInto} className="p-0.5 hover:text-nexus-green" title="Paste here"><ClipboardPaste size={11} /></button>
              )}
              <button onClick={(e) => { e.stopPropagation(); setIsRenaming(true); }} className="p-0.5 hover:text-nexus-gold" title="Rename"><Edit2 size={11} /></button>
              <button onClick={handleDelete} className="p-0.5 hover:text-red-400" title="Delete"><Trash2 size={11} /></button>
            </div>
          </>
        )}
      </div>
      {isFolder && isOpen && children.length > 0 && (
        <div className="ml-4 border-l border-white/5 pl-1">
          {children.map(child => (
            <FileNode key={child.id} file={child} allFiles={allFiles} activeId={activeId} onOpen={onOpen} />
          ))}
        </div>
      )}
    </div>
  );
}
