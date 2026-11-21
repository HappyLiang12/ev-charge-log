import { fetchLatestSnapshot } from './api.js';

export function startSnapshotPolling({
  apiUrl,
  onSnapshot,
  onError,
  pollMs = 60000,
  fetchLatest = fetchLatestSnapshot,
  timerApi = typeof window !== 'undefined' ? window : globalThis,
  doc = typeof document !== 'undefined' ? document : null,
} = {}) {
  let stopped = false;
  let polling = false;

  async function poll() {
    if (stopped || polling || !apiUrl) return;
    if (doc && doc.visibilityState === 'hidden') return;
    polling = true;
    try {
      const snapshot = await fetchLatest(apiUrl);
      if (!stopped) onSnapshot(snapshot);
    } catch (error) {
      if (!stopped) onError(error);
    } finally {
      polling = false;
    }
  }

  const timer = timerApi.setInterval(() => { void poll(); }, pollMs);
  const onVisible = () => {
    if (!stopped && (!doc || doc.visibilityState === 'visible')) void poll();
  };
  if (doc) doc.addEventListener('visibilitychange', onVisible);
  void poll();

  return {
    stop() {
      stopped = true;
      timerApi.clearInterval(timer);
      if (doc) doc.removeEventListener('visibilitychange', onVisible);
    },
    refresh() { void poll(); },
  };
}
