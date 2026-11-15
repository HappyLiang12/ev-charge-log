import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const sources = ['Logic.gs', 'SheetRepo.gs', 'Tesla.gs', 'Rates.gs'].map((name) => (
  readFileSync(new URL(`../apps-script/${name}`, import.meta.url), 'utf8')
));

function makeSheet(initial) {
  const data = (initial || []).map((row) => [...row]);
  return {
    getLastRow: () => data.length,
    getLastColumn: () => data.reduce((max, row) => Math.max(max, row.length), 0),
    getDataRange: () => ({ getValues: () => data.map((row) => [...row]) }),
    getRange(row, col, numRows = 1, numCols = 1) {
      return {
        getValues() {
          const out = [];
          for (let r = 0; r < numRows; r += 1) {
            const line = [];
            for (let c = 0; c < numCols; c += 1) {
              const source = data[row - 1 + r] || [];
              line.push(source[col - 1 + c] ?? '');
            }
            out.push(line);
          }
          return out;
        },
        setValues(next) {
          for (let r = 0; r < numRows; r += 1) {
            const target = row - 1 + r;
            while (data.length <= target) data.push([]);
            const line = data[target];
            for (let c = 0; c < numCols; c += 1) line[col - 1 + c] = next[r][c];
          }
        },
      };
    },
    appendRow(next) { data.push([...next]); },
    deleteRow(row) { data.splice(row - 1, 1); },
    setFrozenRows() {},
  };
}

export function createAppsScriptEnv({ sheets = {}, props = {}, fetch: fetchHandler } = {}) {
  const scriptProps = { SHEET_ID: 'fake-sheet', ...props };
  const sheetMap = new Map();
  for (const [name, values] of Object.entries(sheets)) {
    sheetMap.set(name, makeSheet(values));
  }
  const spreadsheet = {
    getSheetByName: (name) => sheetMap.get(name) || null,
    insertSheet: (name) => {
      const sheet = makeSheet([]);
      sheetMap.set(name, sheet);
      return sheet;
    },
  };
  const context = vm.createContext({
    SpreadsheetApp: { openById: () => spreadsheet },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key) => (Object.prototype.hasOwnProperty.call(scriptProps, key) ? scriptProps[key] : null),
        setProperty: (key, value) => { scriptProps[key] = String(value); },
        deleteProperty: (key) => { delete scriptProps[key]; },
      }),
    },
    Utilities: {
      formatDate: (date, timeZone, format) => {
        if (format !== 'HH:mm') return '';
        const parts = new Intl.DateTimeFormat('en-US', {
          timeZone,
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        }).formatToParts(date);
        const hour = parts.find((part) => part.type === 'hour').value;
        const minute = parts.find((part) => part.type === 'minute').value;
        return `${hour}:${minute}`;
      },
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    UrlFetchApp: {
      fetch: fetchHandler || (() => { throw new Error('Unexpected UrlFetchApp.fetch'); }),
    },
    ContentService: {
      createTextOutput: (text) => ({
        text,
        mimeType: '',
        setMimeType(type) { this.mimeType = type; return this; },
        getContent() { return this.text; },
      }),
    },
    MimeType: { JSON: 'application/json' },
    console: { log() {}, error() {} },
  });
  for (const source of sources) vm.runInContext(source, context);
  return {
    context,
    props: scriptProps,
    spreadsheet,
    call: (name, ...args) => context[name](...args),
    values: (name) => {
      const sheet = sheetMap.get(name);
      return sheet ? sheet.getDataRange().getValues() : [];
    },
  };
}
