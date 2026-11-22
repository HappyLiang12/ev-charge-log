import { fetchRecordSnapshot } from './api.js';
import { formatHkDate, formatHkTime12, withinSnapshotCoverage } from './logic.js';

const cache = new Map();
const pending = new Map();
const queue = [];
const MAX_ACTIVE = 3;
let active = 0;
const keyOf = (apiUrl, recordId) => `${apiUrl}\n${recordId}`;

function pump() {
  while (active < MAX_ACTIVE && queue.length) {
    const job = queue.shift();
    active += 1;
    fetchRecordSnapshot(job.apiUrl, job.recordId)
      .then((data) => {
        const photo = data && data.image
          ? { image: data.image, capturedAt: (data.snapshot && data.snapshot.capturedAt) || '' }
          : null;
        cache.set(job.key, photo);
        job.resolve(photo);
      })
      .catch(() => {
        cache.set(job.key, null);
        job.resolve(null);
      })
      .finally(() => {
        pending.delete(job.key);
        active -= 1;
        pump();
      });
  }
}

export function loadRecordPhoto(apiUrl, recordId) {
  const key = keyOf(apiUrl, recordId);
  if (cache.has(key)) return Promise.resolve(cache.get(key));
  if (pending.has(key)) return pending.get(key);
  const promise = new Promise((resolve) => {
    queue.push({ apiUrl, recordId, key, resolve });
    pump();
  });
  pending.set(key, promise);
  return promise;
}

export function createRecordPhoto({ apiUrl, record, when, buildActions, coverage }) {
  if (!apiUrl || !record || !record.id) return null;
  if (coverage !== undefined && !withinSnapshotCoverage(record, coverage)) return null;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'record-photo-button loading';
  button.setAttribute('aria-label', `${when} 的充電位相片`);
  button.setAttribute('aria-busy', 'true');
  const image = document.createElement('img');
  image.alt = '';
  image.hidden = true;
  button.append(image);
  function start() {
    loadRecordPhoto(apiUrl, record.id).then((photo) => {
      if (!photo) {
        button.remove();
        return;
      }
      image.src = `data:image/jpeg;base64,${photo.image}`;
      image.hidden = false;
      button.classList.remove('loading');
      button.setAttribute('aria-busy', 'false');
    });
  }
  const Observer = typeof window !== 'undefined' ? window.IntersectionObserver : undefined;
  if (typeof Observer === 'function') {
    // Long owner lists should only pay for the photos the reader scrolls to.
    const io = new Observer((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      io.disconnect();
      start();
    }, { rootMargin: '200px' });
    io.observe(button);
  } else {
    start();
  }
  button.addEventListener('click', () => {
    const photo = cache.get(keyOf(apiUrl, record.id));
    if (!photo) return;
    openOverlay(photo, when, buildActions);
  });
  return button;
}

function openOverlay(photo, when, buildActions) {
  const overlay = document.createElement('div');
  overlay.className = 'photo-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', `${when} 的充電位相片`);
  const card = document.createElement('div');
  card.className = 'photo-card';
  const image = document.createElement('img');
  image.className = 'photo-large';
  image.alt = `${when} 的充電位相片`;
  image.src = `data:image/jpeg;base64,${photo.image}`;
  const caption = document.createElement('p');
  caption.className = 'hint';
  caption.textContent = photo.capturedAt
    ? `相片拍攝於 ${formatHkDate(photo.capturedAt)} ${formatHkTime12(photo.capturedAt)}`
    : '';
  const actions = document.createElement('div');
  actions.className = 'photo-actions';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'secondary';
  close.textContent = '關閉';
  card.append(image, caption, actions, close);
  overlay.append(card);

  function dismiss() {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  }
  function onKey(event) {
    if (event.key === 'Escape') dismiss();
  }
  close.addEventListener('click', dismiss);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) dismiss();
  });
  document.addEventListener('keydown', onKey);
  if (typeof buildActions === 'function') {
    const built = buildActions(dismiss);
    if (Array.isArray(built) && built.length) actions.append(...built);
  }
  document.body.append(overlay);
  close.focus();
}
