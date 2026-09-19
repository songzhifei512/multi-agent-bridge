import { useMemo } from 'react';

interface Task {
  id: string;
  session?: string;
  [key: string]: any;
}

export function useSessionFilter(tasks: Task[], sessionId: string | null) {
  return useMemo(() => {
    if (!sessionId) return tasks;
    return tasks.filter(t => t.session === sessionId || !t.session);
  }, [tasks, sessionId]);
}
