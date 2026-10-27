import {useEffect, useState} from 'react';
import {bridge, emptyState} from './bridge';
import type {AppState} from './types';
import type {Run} from './ui';
import Player from './Player';

export default function PlayerOverlayApp() {
  const [state, setState] = useState<AppState>(emptyState), [error, setError] = useState('');
  useEffect(() => {document.documentElement.classList.add('player-overlay-document'); void bridge.invoke<AppState>('state').then(setState); return bridge.onState(setState);}, []);
  const run: Run = async <T,>(method: string, payload?: unknown) => {
    try {setError(''); return await bridge.invoke<T>(method, payload);}
    catch (reason) {setError((reason as Error).message); return undefined;}
  };
  return state.player ? <Player state={state} run={run} error={error} /> : null;
}
