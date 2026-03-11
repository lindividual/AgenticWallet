import { useEffect, useState, type ComponentType } from 'react';

type AgentationComponent = ComponentType<Record<string, never>>;

export function AgentationDevtools() {
  const [Agentation, setAgentation] = useState<AgentationComponent | null>(null);

  useEffect(() => {
    if (!import.meta.env.DEV) return;

    let cancelled = false;

    void import('agentation')
      .then((module) => {
        if (!cancelled) {
          setAgentation(() => module.Agentation);
        }
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, []);

  if (!import.meta.env.DEV || !Agentation) {
    return null;
  }

  return <Agentation />;
}
