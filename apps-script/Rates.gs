var CLP_FUEL_URL_ = 'https://www.clp.com.hk/zh/help-support/bills-payment-tariffs/fuel-cost-adjustment';
var CLP_TARIFF_URL_ = 'https://www.clp.com.hk/zh/emobility/bills-payment-tariffs-emobility/tariff-for-ev/ev-residential-tariff';

function fetchText_(url) {
  var response = UrlFetchApp.fetch(url, { method: 'get', muteHttpExceptions: true });
  var status = response.getResponseCode();
  if (status < 200 || status >= 300) return '';
  var text = response.getContentText();
  return text && text.trim() ? text : '';
}

function fetchWithReader_(url, parser) {
  var direct = fetchText_(url);
  if (direct) {
    var directParsed = parser(direct);
    if (directParsed) return { parsed: directParsed, reader: false };
  }
  var reader = fetchText_('https://r.jina.ai/' + url);
  if (reader) {
    var readerParsed = parser(reader);
    if (readerParsed) return { parsed: readerParsed, reader: true };
  }
  throw new Error('CLP page parse failed');
}

function refreshRates_() {
  var fuel = fetchWithReader_(CLP_FUEL_URL_, function (text) {
    var parsed = parseFuelAdjustmentPage_(text);
    return parsed.current ? parsed : null;
  });
  var tariff = fetchWithReader_(CLP_TARIFF_URL_, parseTariffPage_);
  var fetchedAt = new Date().toISOString();
  var rows = [];
  for (var i = 0; i < fuel.parsed.rows.length; i += 1) {
    var item = fuel.parsed.rows[i];
    rows.push({
      month: item.month,
      basicOffPeak: tariff.parsed.basicOffPeak,
      basicPeak: tariff.parsed.basicPeak,
      fuelAdjustment: item.fuelAdjustment,
      rebate: 0,
      peakStart: tariff.parsed.peakStart,
      peakEnd: tariff.parsed.peakEnd,
      sourceUrl: CLP_FUEL_URL_ + ',' + CLP_TARIFF_URL_,
      fetchedAt: fetchedAt,
      manualOverride: false,
    });
  }
  var updated = upsertRates_(rows);
  return {
    updated: updated,
    reader: fuel.reader || tariff.reader,
    month: fuel.parsed.current.month,
    fuelAdjustment: fuel.parsed.current.fuelAdjustment,
  };
}
