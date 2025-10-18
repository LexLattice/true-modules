import React from 'react';
import ReactDOM from 'react-dom/client';
import './styles.css';
import { Shell } from './ui/shell';
import { bootstrapConsole, demoShellRequest } from './bootstrap';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <Shell request={demoShellRequest} bootstrap={bootstrapConsole} />
  </React.StrictMode>,
);
