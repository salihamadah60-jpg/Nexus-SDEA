import React from 'react';
import {
  Home,
  FolderTree,
  MessageSquare,
  ListTodo,
  Settings,
  Zap,
  Camera,
  Terminal as TerminalIcon,
  Globe,
  Activity,
  Network,
  Brain,
  ShieldCheck,
} from 'lucide-react';
import { cn } from '../utils';

const GLOBAL_TABS = [
  { id: 'home',     icon: Home,          label: 'Home'     },
  { id: 'settings', icon: Settings,      label: 'Settings' },
  { id: 'sessions', icon: MessageSquare, label: 'Sessions' },
  { id: 'terminal', icon: TerminalIcon,  label: 'Terminal' },
];

const SESSION_TABS = [
  { id: 'home',       icon: Home,          label: 'Back 01'   }, // Home acts as "Go back to Global"
  { id: 'explorer',   icon: FolderTree,    label: 'Explorer'  },
  { id: 'sessions',   icon: MessageSquare, label: 'Sessions'  },
  { id: 'tasks',      icon: ListTodo,      label: 'Tasks'     },
  { id: 'blackboard', icon: Network,       label: 'Blackboard'},
  { id: 'vault',      icon: Brain,         label: 'Vault'     },
  { id: 'activity',   icon: Activity,      label: 'Activity'  },
  { id: 'heal',       icon: ShieldCheck,   label: 'Healing'   },
  { id: 'snapshots',  icon: Camera,        label: 'Visuals'   },
  { id: 'preview',    icon: Globe,         label: 'Preview'   },
  { id: 'chat',       icon: Zap,           label: 'Chat'      },
  { id: 'terminal',   icon: TerminalIcon,  label: 'Terminal'  },
];

interface Props {
  activeTab: string;
  isSidebarOpen: boolean;
  onTabClick: (tab: string) => void;
  isTerminalOpen: boolean;
  isPreviewOpen: boolean;
  isSessionActive: boolean;
}

export function NavigationRail({ activeTab, isSidebarOpen, onTabClick, isTerminalOpen, isPreviewOpen, isSessionActive }: Props) {
  const tabs = isSessionActive ? SESSION_TABS : GLOBAL_TABS;

  return (
    <aside className="w-14 shrink-0 bg-bg-deep border-r border-border flex flex-col items-center py-4 gap-1 z-50">
      {tabs.map(tab => {
        const isActive = tab.id === 'terminal'
          ? isTerminalOpen
          : tab.id === 'preview'
            ? isPreviewOpen
            : (activeTab === tab.id && isSidebarOpen);

        return (
          <button
            key={tab.id}
            onClick={() => onTabClick(tab.id)}
            title={tab.label}
            className={cn(
              'group relative flex h-10 w-10 items-center justify-center rounded-xl transition-all duration-150',
              isActive
                ? 'bg-nexus-gold/10 text-nexus-gold shadow-[inset_0_0_10px_rgba(212,175,55,0.08)]'
                : 'text-text-dim hover:text-text-main hover:bg-white/5'
            )}
          >
            <tab.icon className="w-[18px] h-[18px]" strokeWidth={isActive ? 2 : 1.5} />

            {/* Active indicator */}
            {isActive && (
              <span className="absolute left-0 top-2.5 bottom-2.5 w-[2px] bg-nexus-gold rounded-r" />
            )}

            {/* Tooltip */}
            <span className="pointer-events-none absolute left-14 z-50 rounded-lg bg-bg-surface border border-border px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest text-text-main whitespace-nowrap opacity-0 scale-95 group-hover:opacity-100 group-hover:scale-100 transition-all duration-150 shadow-xl">
              {tab.label}
            </span>
          </button>
        );
      })}
    </aside>
  );
}
