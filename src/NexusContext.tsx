import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import { IDEState, Session, FileItem, ChatMessage, ChatMessageMetadata, Notification, Task, NexusEvent } from './types';
import { generateId } from './utils';
import { MODELS, MODES } from './constants';

interface NexusContextType {
  state: IDEState;
  setState: React.Dispatch<React.SetStateAction<IDEState>>;
  createSession: (title?: string) => Promise<string | null>;
  switchSession: (sessionId: string) => Promise<void>;
  deleteSession: (sessionId: string) => Promise<void>;
  renameSession: (sessionId: string, title: string) => Promise<void>;
  pinSession: (sessionId: string) => void;
  refreshFiles: () => Promise<void>;
  sendMessage: (content: string) => Promise<void>;
  retryMessage: (index: number) => Promise<void>;
  deleteMessage: (index: number) => Promise<void>;
  editMessage: (index: number, newContent: string) => Promise<void>;
  addNotification: (type: Notification['type'], message: string, description?: string) => void;
  removeNotification: (id: string) => void;
  notifications: Notification[];
  closeTerminal: (id: string) => void;
  switchTerminal: (id: string) => void;
  socketsRef: React.MutableRefObject<Record<string, WebSocket>>;
  openFileInEditor: (filePath: string) => void;
}

const NexusContext = createContext<NexusContextType | undefined>(undefined);

const INITIAL_STATE: IDEState = {
  files: [],
  activeFileId: null,
  openFileIds: [],
  terminalTabs: [],
  activeTerminalId: null,
  chatHistory: [],
  isAILoading: false,
  isHydrating: true,
  sessions: [],
  currentSessionId: null,
  previewVersion: 0,
  selectedModel: MODELS[0].id,
  selectedMode: MODES[0].id,
  theme: 'sovereign-dark',
  systemStatus: { database: 'LOADING', gemini: 'LOADING', groq: 'LOADING', github: 'LOADING', hf: 'LOADING' },
  tasks: [],
  activeTaskId: null,
  suggestions: [],
  snapshots: {},
  isPreviewOpen: false,
  customKeys: {},
  language: (typeof window !== 'undefined' && (localStorage.getItem('nexus.lang') as 'en' | 'ar')) || 'en',
  fileClipboard: null,
  recentEvents: [],
};

export function NexusProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<IDEState>(INITIAL_STATE);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const socketsRef = useRef<Record<string, WebSocket>>({});
  const reconnectRefs = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const addNotification = (type: Notification['type'], message: string, description?: string) => {
    const id = generateId('notif');
    setNotifications(prev => [...prev, { id, type, message, description }]);
    setTimeout(() => removeNotification(id), 7000);
  };

  const removeNotification = (id: string) => {
    setNotifications(prev => prev.filter(n => n.id !== id));
  };

  const fetchStatus = async () => {
    try {
      const res = await fetch('/api/status');
      const data = await res.json();
      setState(prev => ({ ...prev, systemStatus: data }));
    } catch {}
  };

  const fetchSessions = async () => {
    try {
      const res = await fetch('/api/sessions');
      const raw = await res.json();
      const data: any[] = Array.isArray(raw) ? raw : [];
      setState(prev => {
        const currentId = prev.currentSessionId || (data.length > 0 ? data[0].sessionId : null);
        return {
          ...prev,
          sessions: data,
          currentSessionId: currentId,
          chatHistory: data.find((s: any) => s.sessionId === currentId)?.messages || [],
        };
      });
      return data;
    } catch { return []; }
  };

  const createSession = async (title?: string): Promise<string | null> => {
    const sessionId = generateId('session');
    try {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, title: title || 'New Thread' }),
      });
      const newSession = await res.json();
      setState(prev => ({
        ...prev,
        sessions: [newSession, ...prev.sessions],
        currentSessionId: sessionId,
        chatHistory: [],
        files: [],
        activeFileId: null,
        openFileIds: [],
        terminalTabs: [...prev.terminalTabs, { id: sessionId, title: (title || 'New Thread').slice(0, 15), output: [] }],
        activeTerminalId: sessionId,
        suggestions: [],
      }));
      connectSocket(sessionId);
      addNotification('success', 'New Thread Initialized', `Session active.`);
      return sessionId;
    } catch { return null; }
  };

  const switchSession = async (sessionId: string) => {
    const session = state.sessions.find(s => s.sessionId === sessionId);
    if (session) {
      setState(prev => {
        const existingTab = prev.terminalTabs.find(t => t.id === sessionId);
        const newTabs = existingTab
          ? prev.terminalTabs
          : [...prev.terminalTabs, { id: sessionId, title: (session.title || 'Kernel').slice(0, 15), output: [] }];
        return {
          ...prev,
          currentSessionId: sessionId,
          chatHistory: session.messages || [],
          activeFileId: null,
          openFileIds: [],
          suggestions: [],
          terminalTabs: newTabs,
          activeTerminalId: sessionId,
        };
      });
      connectSocket(sessionId);
    }
  };

  const deleteSession = async (sessionId: string) => {
    try {
      await fetch(`/api/sessions/${sessionId}`, { method: 'DELETE' });
      closeTerminal(sessionId);
      setState(prev => {
        const newSessions = prev.sessions.filter(s => s.sessionId !== sessionId);
        const nextId = prev.currentSessionId === sessionId
          ? (newSessions[0]?.sessionId || null)
          : prev.currentSessionId;
        return {
          ...prev,
          sessions: newSessions,
          currentSessionId: nextId,
          chatHistory: nextId !== prev.currentSessionId ? [] : prev.chatHistory,
        };
      });
    } catch {}
  };

  const renameSession = async (sessionId: string, title: string) => {
    try {
      await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, title }),
      });
      setState(prev => ({
        ...prev,
        sessions: prev.sessions.map(s => s.sessionId === sessionId ? { ...s, title } : s),
      }));
    } catch {}
  };

  const pinSession = (sessionId: string) => {
    setState(prev => ({
      ...prev,
      sessions: prev.sessions.map(s =>
        s.sessionId === sessionId ? { ...s, pinned: !(s as any).pinned } : s
      ),
    }));
  };

  const refreshDebounceRef = useRef<number | null>(null);

  const refreshFiles = async () => {
    const sid = state.currentSessionId;
    if (!sid) return;
    if (refreshDebounceRef.current) window.clearTimeout(refreshDebounceRef.current);
    refreshDebounceRef.current = window.setTimeout(async () => {
      try {
        const res = await fetch(`/api/files?sessionId=${sid}`);
        const data = await res.json();
        setState(prev => ({ ...prev, files: Array.isArray(data) ? data : [] }));
      } catch {}
    }, 300);
  };

  const openFileInEditor = async (filePath: string) => {
    const sid = state.currentSessionId;
    if (!sid) return;
    try {
      const res = await fetch(`/api/files/content?path=${encodeURIComponent(filePath)}&sessionId=${sid}`);
      const data = await res.json();
      if (data.content !== undefined) {
        const fileItem: FileItem = {
          id: filePath,
          name: filePath.split('/').pop() || filePath,
          type: 'file',
          content: data.content,
          language: detectLanguage(filePath),
        };
        setState(prev => ({
          ...prev,
          files: prev.files.some(f => f.id === filePath)
            ? prev.files.map(f => f.id === filePath ? { ...f, content: data.content } : f)
            : [...prev.files, fileItem],
          activeFileId: filePath,
          openFileIds: prev.openFileIds.includes(filePath) ? prev.openFileIds : [...prev.openFileIds, filePath],
        }));
      }
    } catch {}
  };

  function detectLanguage(filePath: string): string {
    if (filePath.endsWith('.tsx') || filePath.endsWith('.jsx')) return 'jsx';
    if (filePath.endsWith('.ts')) return 'typescript';
    if (filePath.endsWith('.js')) return 'javascript';
    if (filePath.endsWith('.css')) return 'css';
    if (filePath.endsWith('.html')) return 'html';
    if (filePath.endsWith('.json')) return 'json';
    if (filePath.endsWith('.md')) return 'markdown';
    return 'text';
  }

  const connectSocket = (sessionId: string) => {
    if (reconnectRefs.current[sessionId]) clearTimeout(reconnectRefs.current[sessionId]);
    if (socketsRef.current[sessionId]) {
      if (socketsRef.current[sessionId].readyState === WebSocket.OPEN) return;
      socketsRef.current[sessionId].onclose = null;
      socketsRef.current[sessionId].close();
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}?sessionId=${sessionId}`);
    socketsRef.current[sessionId] = ws;

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
          if (data.type === 'output') {
            if (data.data === '__REFRESH_FS__') {
              refreshFiles();
            } else if (data.data === '__DIAGNOSTIC_FAILURE__') {
              addNotification('error', 'Surgical Execution Failed', 'Auto-rollback initiated...');
            } else if (data.data === '__DIAGNOSTIC_SUCCESS__') {
              addNotification('success', 'Surgical Execution Success', 'Logic integrity verified.');
            } else if (data.data?.startsWith('__VISUAL_SNAPSHOT__:')) {
              const filename = data.data.replace('__VISUAL_SNAPSHOT__:', '');
              setState(prev => ({
                ...prev,
                snapshots: { ...prev.snapshots, [sessionId]: [...(prev.snapshots[sessionId] || []), filename] }
              }));
            } else if (data.data === '__OPEN_PREVIEW__') {
              setState(prev => ({ ...prev, isPreviewOpen: true }));
            } else if (data.data === '__REFRESH_PREVIEW__') {
              setState(prev => ({ ...prev, previewVersion: prev.previewVersion + 1 }));
            } else {
              const clean = data.data.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
              const lines = clean.split('\n').filter((l: string) => l !== '');
              setState(prev => ({
                ...prev,
                terminalTabs: prev.terminalTabs.map(t =>
                  t.id === sessionId
                    ? { ...t, output: [...t.output, ...lines].slice(-2000) }
                    : t
                )
              }));
            }
          }

          if (data.nexus_sandbox_id) {
            addNotification('info', 'E2B Sandbox Initialized', `ID: ${data.nexus_sandbox_id}`);
          }

          // Action/Observation event bus — refresh affected UI panes + feed activity log.
          if (data.type === 'nexus_event' && data.event) {
            const ev = data.event as NexusEvent;
            setState(prev => ({
              ...prev,
              recentEvents: [...prev.recentEvents, ev].slice(-300),
            }));
            if (
              ev.kind === 'obs.file.changed' ||
              ev.kind === 'action.file.write' ||
              ev.kind === 'action.file.delete' ||
              ev.kind === 'action.file.rename' ||
              ev.kind === 'action.file.copy'
            ) {
              refreshFiles();
            }
            if (ev.kind === 'obs.preview.ready') {
              setState(prev => ({ ...prev, isPreviewOpen: true, previewVersion: prev.previewVersion + 1 }));
            }
          }
      } catch {}
    };

    ws.onerror = () => {};
    ws.onclose = () => {
      reconnectRefs.current[sessionId] = setTimeout(() => {
        setState(prev => {
          if (prev.terminalTabs.find(t => t.id === sessionId)) connectSocket(sessionId);
          return prev;
        });
      }, 3000);
    };
  };

  const closeTerminal = (id: string) => {
    if (socketsRef.current[id]) {
      socketsRef.current[id].onclose = null;
      socketsRef.current[id].close();
      delete socketsRef.current[id];
    }
    if (reconnectRefs.current[id]) {
      clearTimeout(reconnectRefs.current[id]);
      delete reconnectRefs.current[id];
    }
    setState(prev => {
      const newTabs = prev.terminalTabs.filter(t => t.id !== id);
      return {
        ...prev,
        terminalTabs: newTabs,
        activeTerminalId: prev.activeTerminalId === id ? (newTabs[0]?.id || null) : prev.activeTerminalId
      };
    });
  };

  const switchTerminal = (id: string) => {
    setState(prev => ({ ...prev, activeTerminalId: id }));
    connectSocket(id);
  };

  async function processSSEStream(
    response: Response,
    onMetadataUpdate: (meta: Partial<ChatMessageMetadata>) => void,
    onStatusUpdate: (status: string) => void
  ): Promise<string> {
    if (!response.body) throw new Error('No response body');
    const reader = response.body.getReader();
    let buffer = '';
    let summary = '';
    const accFilesModified: any[] = [];
    const accTerminals: any[] = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += new TextDecoder().decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const dataStr = trimmed.slice(6);
        if (dataStr === '[DONE]') return summary;

        try {
          const parsed = JSON.parse(dataStr);

          if (parsed.nexus_streaming) {
            onStatusUpdate(parsed.status || 'Neural synthesis in progress...');
          }

          if (parsed.nexus_thought) {
            onMetadataUpdate({ thought: parsed.nexus_thought });
          }

          if (parsed.nexus_chain) {
            onMetadataUpdate({ actionChain: parsed.nexus_chain });
          }

          if (parsed.nexus_file_read) {
            onMetadataUpdate({ filesRead: parsed.nexus_file_read });
          }

          if (parsed.nexus_file_write) {
            accFilesModified.push(parsed.nexus_file_write);
            onMetadataUpdate({ filesModified: [...accFilesModified] });
          }

          if (parsed.nexus_terminal_running) {
            onStatusUpdate(`Running: ${parsed.nexus_terminal_running.cmd}`);
          }

          if (parsed.nexus_terminal) {
            accTerminals.push(parsed.nexus_terminal);
            onMetadataUpdate({ terminals: [...accTerminals] });
          }

          if (parsed.nexus_screenshot) {
            onMetadataUpdate({ screenshot: parsed.nexus_screenshot });
          }

          if (parsed.nexus_summary) {
            summary = parsed.nexus_summary;
          }

          if (parsed.nexus_intent) {
            onMetadataUpdate({ intent: parsed.nexus_intent });
          }

          if (parsed.nexus_used_key) {
            onMetadataUpdate({ usedKey: parsed.nexus_used_key });
          }

          if (parsed.nexus_thinking) {
            onMetadataUpdate({ thinking: parsed.nexus_thinking });
          }

          if (parsed.nexus_suggestion) {
            onMetadataUpdate({ suggestion: parsed.nexus_suggestion });
          }

          if (parsed.nexus_phase) {
            onMetadataUpdate({ phase: parsed.nexus_phase });
          }

          if (parsed.system_notification) {
            addNotification('info', 'Kernel Switch', parsed.system_notification);
          }
        } catch {}
      }
    }
    return summary;
  }

  const sendMessage = async (content: string) => {
    if (!content.trim()) return;

    let sessionId = state.currentSessionId;
    if (!sessionId) {
      sessionId = await createSession(content.slice(0, 40));
      if (!sessionId) return;
    }

    const taskId = generateId('task');

    let checkpointId = '';
    try {
      const cpRes = await fetch('/api/kernel/checkpoint', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, affectedFiles: state.openFileIds }),
      });
      const cpData = await cpRes.json();
      checkpointId = cpData.checkpointId;
    } catch {}

    const userMsg: ChatMessage = { role: 'user', content, timestamp: Date.now(), checkpointId: checkpointId || undefined };
    const newTask: Task = {
      id: taskId,
      title: content.slice(0, 45) + (content.length > 45 ? '…' : ''),
      status: 'running',
      subtasks: [
        { id: 'analyze', title: 'Neural Analysis', status: 'running' },
        { id: 'generate', title: 'Pattern Synthesis', status: 'pending' },
        { id: 'execute', title: 'Execution & Verification', status: 'pending' },
      ],
      logs: [`Checkpoint: ${checkpointId || 'None'}`],
      checkpointId,
      timestamp: Date.now(),
    };

    const assistantPlaceholder: ChatMessage = {
      role: 'assistant',
      content: '',
      timestamp: Date.now() + 1,
      metadata: { streaming: true, streamChars: 0 }
    };

    setState(prev => ({
      ...prev,
      chatHistory: [...prev.chatHistory, userMsg, assistantPlaceholder],
      isAILoading: true,
      tasks: [newTask, ...prev.tasks],
      activeTaskId: taskId,
      suggestions: [],
    }));

    const placeholderTs = assistantPlaceholder.timestamp;

    const updateAssistantMsg = (updater: (prev: ChatMessage) => ChatMessage) => {
      setState(prev => {
        const idx = prev.chatHistory.findIndex(m => m.timestamp === placeholderTs);
        if (idx === -1) return prev;
        const newHistory = [...prev.chatHistory];
        newHistory[idx] = updater(newHistory[idx]);
        return { ...prev, chatHistory: newHistory };
      });
    };

    const metaRef: ChatMessageMetadata = {
      streaming: true,
      filesRead: [],
      filesModified: [],
      terminals: [],
      actionChain: [],
    };

    const onMetadataUpdate = (update: Partial<ChatMessageMetadata> | ((prev: any) => any)) => {
      if (typeof update === 'function') {
        const result = update(metaRef);
        Object.assign(metaRef, result);
      } else {
        Object.assign(metaRef, update);
      }
      updateAssistantMsg(msg => ({
        ...msg,
        metadata: { ...metaRef }
      }));
    };

    const onStatusUpdate = (status: string) => {
      metaRef.statusHistory = [...(metaRef.statusHistory || []), status];
      updateAssistantMsg(msg => ({
        ...msg,
        metadata: { ...metaRef }
      }));
    };

    setState(prev => ({
      ...prev,
      tasks: prev.tasks.map(t => t.id !== taskId ? t : {
        ...t,
        subtasks: t.subtasks.map(s =>
          s.id === 'analyze' ? { ...s, status: 'completed' } :
          s.id === 'generate' ? { ...s, status: 'running' } : s
        )
      })
    }));

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          message: content, 
          sessionId, 
          model: state.selectedModel, 
          mode: state.selectedMode,
          customKeys: state.customKeys
        }),
      });

      if (!response.ok || !response.body) throw new Error('Neural link failure');

      const summary = await processSSEStream(response, onMetadataUpdate, onStatusUpdate);

      const finalContent = summary || content.slice(0, 100) + '...';
      metaRef.streaming = false;

      updateAssistantMsg(msg => ({
        ...msg,
        content: finalContent,
        metadata: { ...metaRef, streaming: false }
      }));

      setState(prev => ({
        ...prev,
        isAILoading: false,
        activeTaskId: null,
        tasks: prev.tasks.map(t => t.id !== taskId ? t : {
          ...t,
          status: 'completed',
          subtasks: t.subtasks.map(s => ({ ...s, status: 'completed' })),
        }),
        previewVersion: prev.previewVersion + 1,
      }));

      refreshFiles();

      if ((metaRef.filesModified?.length || 0) > 0) {
        addNotification('success', `${metaRef.filesModified!.length} file(s) written`, 'Sandbox updated by Nexus.');
      }

      try {
        await fetch('/api/kernel/dna/lessons', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            lesson: finalContent.slice(0, 300),
            taskId
          }),
        });
      } catch {}

    } catch (err: any) {
      addNotification('error', 'AI Interaction Failed', err.message || 'Neural link failure');
      updateAssistantMsg(msg => ({
        ...msg,
        content: 'Neural synthesis failed. Please try again.',
        metadata: { ...metaRef, streaming: false }
      }));
      setState(prev => ({
        ...prev,
        isAILoading: false,
        activeTaskId: null,
        tasks: prev.tasks.map(t => t.id !== taskId ? t : { ...t, status: 'failed' }),
      }));
    }
  };

  const retryMessage = async (index: number) => {
    const userMsg = state.chatHistory[index];
    if (!userMsg || userMsg.role !== 'user' || !state.currentSessionId) return;

    const sessionId = state.currentSessionId;
    // Delete ALL messages after this user message (full history truncation from this point)
    let newHistory = state.chatHistory.slice(0, index + 1);

    const placeholder: ChatMessage = {
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      metadata: { streaming: true }
    };
    newHistory.splice(index + 1, 0, placeholder);
    const placeholderTs = placeholder.timestamp;

    try {
      await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, messages: newHistory.filter(m => m.content !== '') }),
      });
    } catch {}

    setState(prev => ({ ...prev, chatHistory: newHistory, isAILoading: true }));

    const updateAssistantMsg = (updater: (prev: ChatMessage) => ChatMessage) => {
      setState(prev => {
        const idx = prev.chatHistory.findIndex(m => m.timestamp === placeholderTs);
        if (idx === -1) return prev;
        const h = [...prev.chatHistory];
        h[idx] = updater(h[idx]);
        return { ...prev, chatHistory: h };
      });
    };

    const metaRef: ChatMessageMetadata = { streaming: true };
    const onMetadataUpdate = (update: any) => {
      if (typeof update === 'function') Object.assign(metaRef, update(metaRef));
      else Object.assign(metaRef, update);
      updateAssistantMsg(msg => ({ ...msg, metadata: { ...metaRef } }));
    };
    const onStatusUpdate = (status: string) => {
      metaRef.statusHistory = [...(metaRef.statusHistory || []), status];
      updateAssistantMsg(msg => ({ ...msg, metadata: { ...metaRef } }));
    };

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: userMsg.content, sessionId, model: state.selectedModel, mode: state.selectedMode }),
      });

      if (!response.ok || !response.body) throw new Error('Neural link failure');
      const summary = await processSSEStream(response, onMetadataUpdate, onStatusUpdate);

      updateAssistantMsg(msg => ({
        ...msg,
        content: summary || 'Regeneration complete.',
        metadata: { ...metaRef, streaming: false }
      }));
      setState(prev => ({ ...prev, isAILoading: false, activeTaskId: null }));
      refreshFiles();
    } catch (err: any) {
      addNotification('error', 'Regeneration Failed', String(err.message));
      setState(prev => ({ ...prev, isAILoading: false }));
    }
  };

  const deleteMessage = async (index: number) => {
    if (!state.currentSessionId) return;
    const newHistory = state.chatHistory.filter((_, i) => i !== index);
    setState(prev => ({ ...prev, chatHistory: newHistory }));
    try {
      await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: state.currentSessionId, messages: newHistory }),
      });
    } catch {}
  };

  const editMessage = async (index: number, newContent: string) => {
    if (!state.currentSessionId) return;
    const newHistory = [...state.chatHistory];
    newHistory[index] = { ...newHistory[index], content: newContent };
    setState(prev => ({ ...prev, chatHistory: newHistory }));
    try {
      await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: state.currentSessionId, messages: newHistory }),
      });
    } catch {}
  };

  useEffect(() => {
    fetchSessions().then((data) => {
      if (!data || data.length === 0) createSession('Sovereign Initial Thread');
      setState(prev => ({ ...prev, isHydrating: false }));
    });
    fetchStatus();
    const statusInterval = setInterval(fetchStatus, 30000);

    // Initial load of custom keys
    const savedKeys = localStorage.getItem('nexus_custom_keys');
    if (savedKeys) {
      try {
        const keys = JSON.parse(savedKeys);
        setState(prev => ({ ...prev, customKeys: keys }));
      } catch {}
    }

    const suggestionInterval = setInterval(async () => {
      if (!state.currentSessionId) return;
      try {
        const res = await fetch(`/api/kernel/ideation/suggestions?sessionId=${state.currentSessionId}`);
        const data = await res.json();
        if (data.suggestions?.length > 0) {
          setState(prev => ({ ...prev, suggestions: [...new Set([...prev.suggestions, ...data.suggestions])] as string[] }));
        }
      } catch {}
    }, 60000);
    return () => {
      clearInterval(statusInterval);
      clearInterval(suggestionInterval);
    };
  }, []);

  useEffect(() => {
    if (state.currentSessionId) {
      refreshFiles();
    }
  }, [state.currentSessionId]);

  useEffect(() => {
    if (state.activeTerminalId) connectSocket(state.activeTerminalId);
  }, [state.activeTerminalId]);

  useEffect(() => {
    if (state.customKeys && Object.keys(state.customKeys).length > 0) {
      localStorage.setItem('nexus_custom_keys', JSON.stringify(state.customKeys));
    }
  }, [state.customKeys]);

  useEffect(() => {
    if (state.customKeys && Object.keys(state.customKeys).length > 0) {
      localStorage.setItem('nexus_custom_keys', JSON.stringify(state.customKeys));
    }
  }, [state.customKeys]);

  return (
    <NexusContext.Provider value={{
      state, setState,
      createSession, switchSession, deleteSession, renameSession, pinSession,
      refreshFiles, sendMessage, retryMessage, deleteMessage, editMessage,
      addNotification, removeNotification, notifications,
      closeTerminal, switchTerminal, socketsRef,
      openFileInEditor,
    }}>
      {children}
    </NexusContext.Provider>
  );
}

export function useNexus() {
  const ctx = useContext(NexusContext);
  if (!ctx) throw new Error('useNexus must be used within NexusProvider');
  return ctx;
}
