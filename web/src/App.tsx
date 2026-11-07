import { useCallback, useEffect, useState } from 'react';
import { Gate } from './components/Gate';
import { Toast } from './components/Toast';
import { useArgus } from './lib/useArgus';
import { Commander } from './views/Commander';
import { Intake } from './views/Intake';

function useRoute() {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash.startsWith('#/intake') ? 'intake' : 'commander';
}

export default function App() {
  const state = useArgus();
  const route = useRoute();
  const [error, setError] = useState<string | null>(null);
  const onError = useCallback((m: string) => setError(m), []);
  const clear = useCallback(() => setError(null), []);

  useEffect(() => {
    document.title = route === 'intake' ? 'Argus · Medic intake' : 'Argus · Command';
  }, [route]);

  let body;
  if (!state.connected || !state.sim) body = <Gate connected={state.connected} />;
  else if (route === 'intake') body = <Intake state={state} onError={onError} />;
  else body = <Commander state={state} onError={onError} />;

  return (
    <>
      {body}
      {error && <Toast message={error} onClose={clear} />}
    </>
  );
}
