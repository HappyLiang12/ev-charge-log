const SHEET_ID = 'PASTE_SHEET_ID_HERE';
const SHEET_NAME = 'Log';
const HEADER = ['id', 'startAt', '日期', '時間'];
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

function getSheet_() {
  const spreadsheet = SpreadsheetApp.openById(SHEET_ID);
  let sheet = spreadsheet.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = spreadsheet.insertSheet(SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADER);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function json_(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  const sheet = getSheet_();
  const last = sheet.getLastRow();
  const records = [];
  if (last > 1) {
    const values = sheet.getRange(2, 1, last - 1, 2).getValues();
    for (const row of values) {
      const id = String(row[0] || '');
      const raw = row[1];
      const startAt = raw instanceof Date ? raw.toISOString() : String(raw || '');
      if (ID_RE.test(id) && !Number.isNaN(Date.parse(startAt))) {
        records.push({ id, startAt });
      }
    }
  }
  return json_({ ok: true, records });
}

function doPost(event) {
  try {
    const body = JSON.parse((event.postData && event.postData.contents) || '{}');
    const id = String(body.id || '');
    const action = String(body.action || 'append');
    if (!ID_RE.test(id) || (action !== 'append' && action !== 'delete')) {
      return json_({ ok: false, error: 'invalid payload' });
    }
    if (action === 'append') {
      const startAt = String(body.startAt || '');
      const date = String(body.date || '');
      const time = String(body.time || '');
      if (Number.isNaN(Date.parse(startAt))
        || !DATE_RE.test(date)
        || !TIME_RE.test(time)) {
        return json_({ ok: false, error: 'invalid payload' });
      }
    }

    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const sheet = getSheet_();
      const last = sheet.getLastRow();
      const ids = last > 1 ? sheet.getRange(2, 1, last - 1, 1).getValues() : [];

      if (action === 'delete') {
        for (let i = 0; i < ids.length; i += 1) {
          if (String(ids[i][0]) === id) {
            sheet.deleteRow(i + 2);
            return json_({ ok: true, deleted: true });
          }
        }
        return json_({ ok: true, deleted: false });
      }

      for (const row of ids) {
        if (String(row[0]) === id) return json_({ ok: true, duplicate: true });
      }
      sheet.appendRow([id, String(body.startAt), String(body.date), String(body.time)]);
      return json_({ ok: true });
    } finally {
      lock.releaseLock();
    }
  } catch (error) {
    return json_({ ok: false, error: String(error) });
  }
}
