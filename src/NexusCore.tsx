import React, { useState } from 'react';
import { useNexus } from './NexusContext';
import { NavigationRail } from './components/NavigationRail';
import { HomePanel } from './components/HomePanel';
import { FileExplorer } from './components/FileExplorer';
import { EditorPanel } from './components/EditorPanel';
import { PreviewPanel } from './components/PreviewPanel';
import { TerminalPanel } from './components/TerminalPanel';
import { SessionPanel } from './components/SessionPanel';
import { TaskTracker } from './components/TaskTracker';
import { SettingsPanel } from './components/SettingsPanel';
import { VisualSnapshotPanel } from './components/VisualSnapshotPanel';
import { ActivityFeed } from './components/ActivityFeed';
import { NotificationOverlay } from './components/NotificationOverlay';
import { LoadingKernel } from './components/LoadingKernel';
import { ChatPanel } from './components/ChatPanel';
import BlackboardPanel from './components/BlackboardPanel';
import KnowledgeVaultPanel from './components/KnowledgeVaultPanel';
import { SelfHealingPanel } from './components/SelfHealingPanel';
import { FirstRunKeyBanner } from './components/FirstRunKeyBanner';
import { motion, AnimatePresence } from 'motion/react';
import { X } from 'lucide-react';

export function NexusCore() {
  const { state, setState, createSession, sendMessage, notifications, removeNotification } = useNexus();
  const [activeTab, setActiveTab] = useState('home');
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [isTerminalOpen, setIsTerminalOpen] = useState(false);

  React.useEffect(() => {
    document.documentElement.setAttribute('data-theme', state.theme);
  }, [state.theme]);

  // Phase 11: Arabic / RTL support — toggle <html lang> + <html dir> live and
  // persist the choice so it survives reloads.
  React.useEffect(() => {
    const lang = state.language || 'en';
    document.documentElement.setAttribute('lang', lang);
    document.documentElement.setAttribute('dir', lang === 'ar' ? 'rtl' : 'ltr');
    try { localStorage.setItem('nexus.lang', lang); } catch {}
  }, [state.language]);

  const handleTabClick = (tabId: string) => {
    if (tabId === 'terminal') {
      setIsTerminalOpen(!isTerminalOpen);
    } else if (tabId === 'preview') {
      setState(prev => ({ ...prev, isPreviewOpen: !prev.isPreviewOpen }));
    } else if (tabId === 'home') {
      // If a session is active, clicking home exits to global view
      if (state.currentSessionId) {
        setState(prev => ({ ...prev, currentSessionId: null }));
      }
      setActiveTab('home');
      setIsSidebarOpen(false);
    } else {
      if (activeTab === tabId && isSidebarOpen) {
        setIsSidebarOpen(false);
      } else {
        setActiveTab(tabId);
        setIsSidebarOpen(true);
      }
    }
  };

  const renderSidebarContent = () => {
    switch (activeTab) {
      case 'explorer': return <FileExplorer />;
      case 'sessions': return <SessionPanel onSelect={() => {
        // When a session is selected from the list, we shift into session mode
        setActiveTab('chat');
        setIsSidebarOpen(false);
      }} />;
      case 'tasks': return <TaskTracker tasks={state.tasks || []} activeTaskId={state.activeTaskId} />;
      case 'activity': return <ActivityFeed />;
      case 'heal': return <SelfHealingPanel />;
      case 'settings': return <SettingsPanel />;
      case 'snapshots': return <VisualSnapshotPanel />;
      case 'blackboard': return <BlackboardPanel sessionId={state.currentSessionId} />;
      case 'vault': return <KnowledgeVaultPanel />;
      default: return null;
    }
  };

  const renderMainContent = () => {
    if (!state.currentSessionId || activeTab === 'home') {
      return <HomePanel onStartChat={(msg) => {
        // Starting a chat from Home creates a new isolated session
        createSession(msg.slice(0, 30)).then(() => {
          setActiveTab('chat');
          setIsSidebarOpen(false);
          sendMessage(msg);
        });
      }} />;
    }

    switch (activeTab) {
      case 'chat': 
      case 'sessions': return <ChatPanel />;
      default: return <EditorPanel />;
    }
  };

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-bg-deep text-text-main font-sans cursor-default select-none">
      <NavigationRail 
        activeTab={activeTab} 
        isSidebarOpen={isSidebarOpen} 
        onTabClick={handleTabClick}
        isTerminalOpen={isTerminalOpen}
        isPreviewOpen={state.isPreviewOpen}
        isSessionActive={!!state.currentSessionId}
      />

      <div className="flex-1 flex flex-col relative overflow-hidden">
        <FirstRunKeyBanner />
        <div className="flex-1 flex overflow-hidden">
          {/* Sidebar */}
          <AnimatePresence mode="wait">
            {isSidebarOpen && activeTab !== 'home' && (
              <motion.aside
                initial={{ width: 0, opacity: 0 }}
                animate={{ width: 280, opacity: 1 }}
                exit={{ width: 0, opacity: 0 }}
                transition={{ type: 'spring', damping: 25, stiffness: 200 }}
                className="border-r border-border bg-bg-surface flex flex-col overflow-hidden relative"
              >
                <div className="flex items-center justify-between px-4 py-2 border-b border-white/5 bg-white/[0.02] shrink-0">
                  <span className="text-[10px] font-bold uppercase tracking-widest text-text-dim">
                    {activeTab === 'explorer' ? 'Navigator'
                     : activeTab === 'heal' ? 'Self-Healing'
                     : activeTab}
                  </span>
                  <button 
                    onClick={() => setIsSidebarOpen(false)}
                    className="p-1 rounded hover:bg-white/5 text-text-dim hover:text-white transition-colors"
                  >
                    <X size={14} />
                  </button>
                </div>
                <div className="flex-1 overflow-hidden">
                  {renderSidebarContent()}
                </div>
              </motion.aside>
            )}
          </AnimatePresence>

          {/* Main Workspace */}
          <main className="flex-1 flex flex-col min-w-0 bg-bg-deep relative">
            <div className="flex-1 flex min-w-0 overflow-hidden relative bg-nexus-black">
              <div className="flex-1 min-w-0 flex flex-col relative overflow-hidden">
                {renderMainContent()}
              </div>
              
              {/* Preview Panel Layout */}
              <AnimatePresence>
                {state.isPreviewOpen && (
                  <motion.div
                    initial={{ width: 0, opacity: 0 }}
                    animate={{ width: 420, opacity: 1 }}
                    exit={{ width: 0, opacity: 0 }}
                    transition={{ type: 'spring', damping: 25, stiffness: 200 }}
                    className="overflow-hidden border-l border-border"
                  >
                    <PreviewPanel 
                      isOpen={state.isPreviewOpen} 
                      setIsOpen={(v) => setState(prev => ({ ...prev, isPreviewOpen: v }))} 
                    />
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* Terminal Drawer */}
            {isTerminalOpen && (
              <div className="h-[300px] border-t border-border bg-bg-deep overflow-hidden shrink-0 min-h-[100px] z-20">
                <TerminalPanel />
              </div>
            )}
          </main>
        </div>
      </div>

      <NotificationOverlay 
        notifications={notifications || []} 
        removeNotification={removeNotification} 
      />
      {state.isHydrating && <LoadingKernel />}
    </div>
  );
}
