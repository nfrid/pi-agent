import { Component, type ErrorInfo, type ReactNode, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

class DashboardErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Dashboard render failed', error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="shell centered">
        <h1>Pi Dashboard</h1>
        <p className="error">
          A live update could not be displayed. The dashboard state is safe to
          reload.
        </p>
        <button type="button" onClick={() => window.location.reload()}>
          Reload dashboard
        </button>
      </main>
    );
  }
}

if ('serviceWorker' in navigator)
  void navigator.serviceWorker.register('/sw.js');
const root = document.getElementById('root');
if (!root) throw new Error('Dashboard root element is missing.');
createRoot(root).render(
  <StrictMode>
    <DashboardErrorBoundary>
      <App />
    </DashboardErrorBoundary>
  </StrictMode>,
);
