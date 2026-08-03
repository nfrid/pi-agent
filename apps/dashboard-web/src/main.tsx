import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

if ('serviceWorker' in navigator)
  void navigator.serviceWorker.register('/sw.js');
const root = document.getElementById('root');
if (!root) throw new Error('Dashboard root element is missing.');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
