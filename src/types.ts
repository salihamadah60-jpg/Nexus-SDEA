export interface FileItem {
  id: string;
  name: string;
  type: 'file' | 'folder';
  content?: string;
  language?: string;
  parentId?: string;
  isOpen?: boolean;
}

export interface TerminalEntry {
  cmd: string;
  output: string;
  success: boolean;
  retried?: boolean;
  fixedCmd?: string;
}

export interface FileWriteEntry {
  path: string;
  size: number;
  preview?: string;
  beforeContent?: string;
}

export interface ChatMessageMetadata {
  thought?: string;
  thinking?: string;
  thinkingMs?: number;
  actionChain?: string[];
  filesRead?: string[];
  filesModified?: FileWriteEntry[];
  terminals?: TerminalEntry[];
  screenshot?: string;
  statusHistory?: string[];
  streaming?: boolean;
  streamChars?: number;
  intent?: 'smalltalk' | 'question' | 'build' | 'command';
  usedKey?: string;
  suggestion?: string;
  phase?: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  metadata?: ChatMessageMetadata;
  checkpointId?: string;
}

export interface Session {
  sessionId: string;
  title: string;
  messages: ChatMessage[];
  lastModified: number;
  pinned?: boolean;
}

export interface Task {
  id: string;
  title: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  subtasks: SubTask[];
  logs: string[];
  affectedFiles?: string[];
  lessonLearned?: string;
  checkpointId?: string;
  timestamp: number;
}

export interface SubTask {
  id: string;
  title: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  logs?: string[];
}

export interface SystemStatus {
  database: string;
  gemini: string;
  groq: string;
  github: string;
  hf: string;
  audit?: string;
}

export interface Notification {
  id: string;
  type: 'error' | 'success' | 'info' | 'warning';
  message: string;
  description?: string;
}

export interface TerminalTab {
  id: string;
  title: string;
  output: string[];
}

export interface IDEState {
  files: FileItem[];
  activeFileId: string | null;
  openFileIds: string[];
  terminalTabs: TerminalTab[];
  activeTerminalId: string | null;
  chatHistory: ChatMessage[];
  isAILoading: boolean;
  isHydrating: boolean;
  sessions: Session[];
  currentSessionId: string | null;
  previewVersion: number;
  selectedModel: string;
  selectedMode: string;
  theme: string;
  systemStatus: SystemStatus;
  tasks: Task[];
  activeTaskId: string | null;
  suggestions: string[];
  snapshots: Record<string, string[]>;
  isPreviewOpen: boolean;
  customKeys: Record<string, string>;
  language: 'en' | 'ar';
  fileClipboard: { srcPath: string; mode: 'copy' | 'cut' } | null;
  recentEvents: NexusEvent[];
  // Phase 13.9 — Budget guardrails
  budgetUsd: number;        // 0 = disabled
  budgetTokens: number;     // 0 = disabled
  pausedSessions: Record<string, boolean>;
}

export interface NexusEvent {
  id: string;
  kind: string;
  sessionId?: string;
  taskId?: string;
  ts: number;
  payload: Record<string, any>;
}
