var CLP_FUEL_URL_ = 'https://www.clp.com.hk/zh/help-support/bills-payment-tariffs/fuel-cost-adjustment';
var CLP_TARIFF_URL_ = 'https://www.clp.com.hk/zh/emobility/bills-payment-tariffs-emobility/tariff-for-ev/ev-residential-tariff';
var CLP_READER_URL_ = 'https://r.jina.ai/';
var BROWSER_USER_AGENT_ = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function fetchText_(url) {
  var response = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { 'User-Agent': BROWSER_USER_AGENT_ },
    muteHttpExceptions: true,
  });
  var text = response.getContentText();
  return {
    status: response.getResponseCode(),
    text: text && text.trim() ? text : '',
  };
}

function fetchWithReader_(url, parser) {
  var direct = fetchText_(url);
  var directOk = direct.status >= 200 && direct.status < 300 && direct.text;
  if (directOk) {
    var directParsed = parser(direct.text);
    if (directParsed) return { parsed: directParsed, reader: false };
  }
  var reader = fetchText_(CLP_READER_URL_ + url);
  var readerOk = reader.status >= 200 && reader.status < 300 && reader.text;
  if (readerOk) {
    var readerParsed = parser(reader.text);
    if (readerParsed) return { parsed: readerParsed, reader: true };
  }
  if (!directOk && !readerOk) {
    throw new Error('CLP fetch failed for ' + url + ' (HTTP ' + direct.status + ', reader ' + reader.status + ')');
  }
  throw new Error('CLP page parse failed for ' + url);
}

function refreshRates_() {
  var fuel = fetchWithReader_(CLP_FUEL_URL_, function (text) {
    var parsed = parseFuelAdjustmentPage_(text);
    var hasTable = text.indexOf('每月燃料調整費') !== -1;
    return parsed.current && parsed.rows.length && hasTable ? parsed : null;
  });
  var tariff = fetchWithReader_(CLP_TARIFF_URL_, parseTariffPage_);
  validateParsedRates_(fuel.parsed, tariff.parsed);
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
