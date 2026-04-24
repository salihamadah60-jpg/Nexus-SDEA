import React from 'react';
import ReactDOM from 'react-dom/client';
import { NexusProvider } from './NexusContext';
import { NexusCore } from './NexusCore';
import './theme.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <NexusProvider>
      <NexusCore />
    </NexusProvider>
  </React.StrictMode>
);
