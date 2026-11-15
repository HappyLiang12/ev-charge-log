import { formatHkDate, formatHkTime12, sourceUrls } from './logic.js';

function textRow(label, value) {
  const row = document.createElement('div');
  row.className = 'owner-card-row';
  const left = document.createElement('span');
  left.textContent = label;
  const right = document.createElement('strong');
  right.textContent = value;
  row.append(left, right);
  return row;
}

export function formatStamp(value) {
  return value && !Number.isNaN(Date.parse(value))
    ? `${formatHkDate(value)} ${formatHkTime12(value)}`
    : '未記錄';
}

export function makeRateCard(rate) {
  const card = document.createElement('div');
  card.className = 'owner-card';
  const head = document.createElement('div');
  head.className = 'owner-card-head';
  const title = document.createElement('span');
  title.className = 'owner-card-title';
  title.textContent = rate.month;
  const badge = document.createElement('span');
  badge.className = 'owner-card-total';
  badge.textContent = rate.manualOverride ? '手動' : '自動';
  head.append(title, badge);
  card.append(head);
  const rebate = Number(rate.rebate) || 0;
  const off = (Number(rate.basicOffPeak) + Number(rate.fuelAdjustment) - rebate) / 100;
  const peak = (Number(rate.basicPeak) + Number(rate.fuelAdjustment) - rebate) / 100;
  card.append(textRow('非高峰', `$${off.toFixed(3)}/kWh`));
  card.append(textRow('高峰', `$${peak.toFixed(3)}/kWh`));
  card.append(textRow('燃料調整 / 回贈', `${Number(rate.fuelAdjustment).toFixed(1)} / ${rebate.toFixed(1)} 港仙`));
  card.append(textRow('高峰時段', `${rate.peakStart}–${rate.peakEnd}`));
  const links = rate.manualOverride ? [] : sourceUrls(rate.sourceUrl);
  if (links.length) {
    const source = document.createElement('div');
    source.className = 'owner-card-row';
    const label = document.createElement('span');
    label.textContent = '來源';
    const value = document.createElement('strong');
    for (let i = 0; i < links.length; i += 1) {
      if (i) value.append(document.createTextNode(' · '));
      const link = document.createElement('a');
      link.href = links[i];
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.textContent = i === 0 ? 'CLP 燃料調整費' : i === 1 ? 'CLP EV 價目' : `來源 ${i + 1}`;
      value.append(link);
    }
    source.append(label, value);
    card.append(source);
  } else {
    card.append(textRow('來源', rate.manualOverride ? '手動設定' : 'CLP 官方'));
  }
  card.append(textRow('更新', formatStamp(rate.fetchedAt)));
  return card;
}

export function renderRateCards(container, rates, emptyMessage) {
  container.replaceChildren();
  const sorted = rates.slice().sort((a, b) => b.month.localeCompare(a.month));
  if (sorted.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = emptyMessage;
    container.append(empty);
    return;
  }
  container.append(makeRateCard(sorted[0]));
  if (sorted.length === 1) return;
  const details = document.createElement('details');
  details.className = 'rate-more';
  const summary = document.createElement('summary');
  summary.textContent = `其他月份（${sorted.length - 1}）`;
  const list = document.createElement('div');
  list.className = 'rate-more-list';
  for (const rate of sorted.slice(1)) list.append(makeRateCard(rate));
  details.append(summary, list);
  container.append(details);
}
