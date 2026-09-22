import React from 'react';
import { createRoot } from 'react-dom/client';
import { injectStyles } from 'bridge-ui';
import App from './App';
import './index.css';

injectStyles();
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
