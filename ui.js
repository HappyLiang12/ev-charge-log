const toastTimers = new WeakMap();

export function byId(id) {
  return document.getElementById(id);
}

export function showToast(element, message) {
  if (!element) return;
  element.textContent = message;
  element.classList.add('show');
  clearTimeout(toastTimers.get(element));
  toastTimers.set(element, setTimeout(() => element.classList.remove('show'), 2500));
}

export function setStatus(element, status) {
  if (!element) return;
  element.textContent = status;
  element.dataset.state = status === '已連接'
    ? 'ok'
    : status === '未設定'
      ? 'idle'
      : status === '連線中'
        ? 'loading'
        : 'warn';
}

export function setBusy(button, busy, busyLabel, idleLabel) {
  if (!button) return;
  button.disabled = busy;
  button.classList.toggle('loading', busy);
  button.textContent = busy ? busyLabel : idleLabel;
  button.setAttribute('aria-busy', busy ? 'true' : 'false');
}
