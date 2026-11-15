import { fetchChargerStatus } from './api.js';
import { costForKwh } from './logic.js';

export function startChargerLive({ apiUrl, getStartAt, getRates, onChange, pollMs = 300000 }) {
  let stopped = false;
  let active = false;
  let lastSampleAt = null;
  let lastPowerW = 0;
  let accumulatedKwh = 0;
  let startedFor = null;
  let polling = false;
  let live = {
    charging: false,
    powerW: 0,
    energyWh: null,
    state: '',
    available: false,
    sampledAt: '',
  };

  function snapshot(now = Date.now()) {
    if (!active) return null;
    const hours = lastSampleAt === null ? 0 : Math.max(0, now - lastSampleAt) / 3600000;
    const kwh = accumulatedKwh + lastPowerW * hours / 1000;
    return {
      active: true,
      charging: live.charging,
      powerW: live.powerW,
      available: live.available,
      state: live.state,
      sampledAt: live.sampledAt,
      kWh: Math.max(0, kwh),
      cost: costForKwh(kwh, getRates(), new Date(now).toISOString()),
    };
  }

  function emit(now = Date.now()) {
    const value = snapshot(now);
    if (value) onChange(value);
  }

  async function poll() {
    if (stopped || polling) return;
    const start = getStartAt();
    if (!start) {
      if (active) {
        active = false;
        onChange(null);
      }
      return;
    }
    if (!active) {
      active = true;
      startedFor = start;
      lastSampleAt = null;
      lastPowerW = 0;
      accumulatedKwh = 0;
    }
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    polling = true;
    try {
      const next = await fetchChargerStatus(apiUrl);
      const now = Date.now();
      if (lastSampleAt === null) {
        const elapsedHours = Math.max(0, now - Date.parse(start)) / 3600000;
        accumulatedKwh = next.energyWh !== null
          ? next.energyWh / 1000
          : next.powerW * elapsedHours / 1000;
      } else {
        const hours = Math.max(0, now - lastSampleAt) / 3600000;
        accumulatedKwh += (lastPowerW + next.powerW) / 2 * hours / 1000;
        if (next.energyWh !== null) accumulatedKwh = next.energyWh / 1000;
      }
      lastSampleAt = now;
      lastPowerW = next.powerW;
      live = next;
    } catch {
      live = { ...live, available: false };
    } finally {
      polling = false;
      emit();
    }
  }

  const timerApi = typeof window !== 'undefined' ? window : globalThis;
  const tick = timerApi.setInterval(() => {
    if (stopped) return;
    const start = getStartAt();
    if (!start) {
      if (active) {
        active = false;
        onChange(null);
      }
      return;
    }
    if (!active) {
      void poll();
      return;
    }
    if (startedFor !== start) {
      startedFor = start;
      lastSampleAt = null;
      lastPowerW = 0;
      accumulatedKwh = 0;
    }
    emit();
  }, 1000);

  const pollTimer = timerApi.setInterval(() => { void poll(); }, pollMs);
  const onVisible = () => {
    if (!stopped && document.visibilityState === 'visible') void poll();
  };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
  void poll();

  return {
    stop() {
      stopped = true;
      timerApi.clearInterval(tick);
      timerApi.clearInterval(pollTimer);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
    },
    refresh() { void poll(); },
  };
}
