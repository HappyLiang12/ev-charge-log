import { groupUnassignedByMonthDay } from './logic.js';

const toastTimers = new WeakMap();

export function byId(id) {
  return document.getElementById(id);
}

export function appendUnassignedRows(list, records, makeRow, now = Date.now()) {
  const grouped = groupUnassignedByMonthDay(records, now);
  for (const record of grouped.recent) list.append(makeRow(record));
  for (const month of grouped.months) {
    const li = document.createElement('li');
    li.className = 'unassigned-month';
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    const count = month.days.reduce((total, day) => total + day.records.length, 0);
    const [year, monthNumber] = month.month.split('-');
    summary.textContent = `${year} 年 ${Number(monthNumber)} 月（${count}）`;
    const monthList = document.createElement('ul');
    monthList.className = 'owner-list unassigned-month-list';
    for (const day of month.days) {
      const dayLi = document.createElement('li');
      dayLi.className = 'unassigned-day';
      const dayDetails = document.createElement('details');
      const daySummary = document.createElement('summary');
      daySummary.textContent = `${day.day}（${day.records.length}）`;
      const dayList = document.createElement('ul');
      dayList.className = 'owner-list unassigned-day-list';
      for (const record of day.records) dayList.append(makeRow(record));
      dayDetails.append(daySummary, dayList);
      dayLi.append(dayDetails);
      monthList.append(dayLi);
    }
    details.append(summary, monthList);
    li.append(details);
    list.append(li);
  }
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

export function friendlyError(error, fallback) {
  const raw = String((error && error.message) || '');
  if (/CLP|manualOverride|fuel adjustment|off-peak|peak rate/i.test(raw)) {
    return 'CLP 費率格式已變，請在 Google Sheet 的 Rates 手動輸入並設 manualOverride=TRUE。';
  }
  if (/authorization|授權|401|403|Tesla token/i.test(raw)) {
    return '充電樁授權已過期，請重新執行本機設定工具。';
  }
  if (/inactive|停用/i.test(raw)) return '此車輛已停用，請聯絡車主。';
  if (/unknown car|404|連結無效/i.test(raw)) return '車輛連結無效，請向車主索取新連結。';
  if (/[\u4e00-\u9fff]/.test(raw) && !/^HTTP \d+$/i.test(raw)) return raw;
  return fallback;
}
