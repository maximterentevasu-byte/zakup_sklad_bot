const XLSX = require('xlsx');

const STORE_MAP = {
  АСБ: 'Асбест',
  КАМ: 'Каменская',
  ПОБ: 'Победы',
  СКЛ: 'Склад',
};

const KNOWN_COLS = new Set([
  'PLU','Наименование','Отдел','Дата изг.','Годен до','Уценено','Снято',
  'Когда добавили','Кто добавил','Когда сняли','Кто снял','Когда уценили','Кто уценил',
  'Количество при добавлении','Количество при снятии','Количество при уценке',
  'Срок хранения','Период срока хранения','Штрихкод',
]);

// Читает один файл магазина.
// Если у позиции 2-3 штрихкода (колонки S, T, U) — разворачивает в несколько строк.
function readStore(buffer, storeKey) {
  const storeName = STORE_MAP[storeKey];
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });

  const ws = wb.Sheets['Список сроков'];
  if (!ws) throw new Error(`В файле ${storeKey} не найден лист "Список сроков"`);

  const rows = XLSX.utils.sheet_to_json(ws, { defval: null });
  const result = [];

  for (const row of rows) {
    if (String(row['Снято'] ?? '').trim() !== 'Нет') continue;

    // Первый штрихкод — основная колонка
    const barcodes = [];
    const main = String(row['Штрихкод'] ?? '').trim();
    if (main && main !== 'null') barcodes.push(main);

    // Дополнительные штрихкоды: любая колонка вне стандартного набора,
    // значение которой выглядит как штрихкод (8–14 цифр)
    for (const [k, v] of Object.entries(row)) {
      if (KNOWN_COLS.has(k)) continue;
      if (v === null) continue;
      const val = String(v).trim();
      if (/^\d{8,14}$/.test(val) && !barcodes.includes(val)) {
        barcodes.push(val);
      }
    }

    if (barcodes.length === 0) barcodes.push('');

    const qty = parseFloat(row['Количество при добавлении']) || 0;

    // Одна запись на каждый штрихкод
    for (const barcode of barcodes) {
      result.push({
        name:   String(row['Наименование'] ?? '').trim(),
        dept:   String(row['Отдел'] ?? '').trim(),
        barcode,
        expiry: row['Годен до'],
        qty,
        store:  storeName,
      });
    }
  }

  return result;
}

function rowKey(row) {
  const expStr = row.expiry instanceof Date
    ? row.expiry.toISOString().split('T')[0]
    : String(row.expiry ?? '');
  return [row.name, row.dept, row.barcode, expStr].join('|||');
}

// Обрабатывает 4 буфера → итоговый массив строк
function processFiles(buffers) {
  const groups = new Map();

  for (const [key, buffer] of Object.entries(buffers)) {
    for (const row of readStore(buffer, key)) {
      const k = rowKey(row);
      if (!groups.has(k)) {
        groups.set(k, {
          'Наименование': row.name,
          'Отдел':        row.dept,
          'Штрихкод':     row.barcode,
          'Годен до':     row.expiry,
          'Асбест':    0, 'Каменская': 0, 'Победы': 0, 'Склад': 0,
        });
      }
      groups.get(k)[row.store] += row.qty;
    }
  }

  const result = Array.from(groups.values()).sort((a, b) => {
    const nc = a['Наименование'].localeCompare(b['Наименование'], 'ru');
    if (nc !== 0) return nc;
    return new Date(a['Годен до']) - new Date(b['Годен до']);
  });

  return result.map(g => {
    const out = {
      'Наименование': g['Наименование'],
      'Отдел':        g['Отдел'],
      'Штрихкод':     g['Штрихкод'],
      'Годен до':     g['Годен до'],
    };
    let total = 0;
    for (const s of ['Асбест', 'Каменская', 'Победы', 'Склад']) {
      out[s] = g[s] > 0 ? g[s] : null;
      total += g[s];
    }
    out['Общий итог'] = total;
    return out;
  });
}

function generateExcel(data) {
  const headers = [
    'Наименование', 'Отдел', 'Штрихкод', 'Годен до',
    'Асбест', 'Каменская', 'Победы', 'Склад', 'Общий итог',
  ];

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(data, { header: headers });

  const range = XLSX.utils.decode_range(ws['!ref']);
  for (let r = 1; r <= range.e.r; r++) {
    const cell = ws[XLSX.utils.encode_cell({ r, c: 3 })];
    if (cell && cell.t === 'd') cell.z = 'DD.MM.YYYY';
  }

  ws['!cols'] = [
    { wch: 40 }, { wch: 20 }, { wch: 16 }, { wch: 12 },
    { wch: 10 }, { wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 12 },
  ];

  XLSX.utils.book_append_sheet(wb, ws, 'Лист3');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', cellDates: true });
}

module.exports = { processFiles, generateExcel, STORE_MAP };
