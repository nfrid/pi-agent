import { useNavigate } from '@tanstack/react-router';
import { useDashboardUtility } from '../features/dashboard-utility-context';

export function useDashboardNavigate(): (path: string) => void {
  const navigate = useNavigate();
  const utility = useDashboardUtility();
  return (path) => {
    // Navigation from a utility panel must never leave the old panel over the
    // destination. The panel state is intentionally independent of the URL.
    utility?.close();
    void navigate({ to: path });
  };
}

export function Back() {
  const go = useDashboardNavigate();
  return (
    <button type="button" className="back" onClick={() => go('/')}>
      ← Dashboard
    </button>
  );
}
