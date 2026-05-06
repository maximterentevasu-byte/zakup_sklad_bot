const XLSX = require('xlsx');

const STORE_MAP = {
  АСБ: 'Асбест',
  КАМ: 'Каменская',
  ПОБ: 'Победы',
  СКЛ: 'Склад',
};

// Читает один файл магазина, возвращает массив строк
function readStore(buffer, storeKey) {
  const storeName = STORE_MAP[storeKey];
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });

  const ws = wb.Sheets['Список сроков'];
  if (!ws) throw new Error(`В файле ${storeKey} не найден лист "Список сроков"`);

  const rows = XLSX.utils.sheet_to_json(ws, { defval: null, raw: false });

  return rows
    .filter(row => String(row['Снято'] ?? '').trim() === 'Нет')
    .map(row => {
      // Берём первый штрихкод (могут быть несколько в соседних ячейках)
      const barcode = String(row['Штрихкод'] ?? '').trim().split(/\s+/)[0];
      const expiry  = row['Годен до'];
      const qty     = parseFloat(row['Количество при добавлении']) || 0;

      return {
        name:    String(row['Наименование'] ?? '').trim(),
        dept:    String(row['Отдел'] ?? '').trim(),
        barcode,
        expiry,
        qty,
        store:   storeName,
      };
    });
}

// Строит ключ для группировки
function rowKey(row) {
  const expStr = row.expiry instanceof Date
    ? row.expiry.toISOString().split('T')[0]
    : String(row.expiry ?? '');
  return [row.name, row.dept, row.barcode, expStr].join('|||');
}

// Обрабатывает 4 буфера и возвращает сводную таблицу
function processFiles(buffers) {
  // buffers: { АСБ: Buffer, КАМ: Buffer, ПОБ: Buffer, СКЛ: Buffer }
  const groups = new Map();

  for (const [key, buffer] of Object.entries(buffers)) {
    const rows = readStore(buffer, key);

    for (const row of rows) {
      const k = rowKey(row);
      if (!groups.has(k)) {
        groups.set(k, {
          'Наименование': row.name,
          'Отдел':        row.dept,
          'Штрихкод':     row.barcode,
          'Годен до':     row.expiry,
          'Асбест':       0,
          'Каменская':    0,
          'Победы':       0,
          'Склад':        0,
        });
      }
      groups.get(k)[row.store] += row.qty;
    }
  }

  // Сортировка: по названию, потом по дате
  const result = Array.from(groups.values()).sort((a, b) => {
    const nameComp = a['Наименование'].localeCompare(b['Наименование'], 'ru');
    if (nameComp !== 0) return nameComp;
    return new Date(a['Годен до']) - new Date(b['Годен до']);
  });

  // Обнуляем нули → null (пустые ячейки как в оригинале), считаем итог
  return result.map(g => {
    const stores = ['Асбест', 'Каменская', 'Победы', 'Склад'];
    const row = {
      'Наименование': g['Наименование'],
      'Отдел':        g['Отдел'],
      'Штрихкод':     g['Штрихкод'],
      'Годен до':     g['Годен до'],
    };
    let total = 0;
    for (const s of stores) {
      const v = g[s];
      row[s] = v > 0 ? v : null;
      total += v;
    }
    row['Общий итог'] = total;
    return row;
  });
}

// Генерирует Excel-буфер из итоговых данных
function generateExcel(data) {
  const headers = [
    'Наименование', 'Отдел', 'Штрихкод', 'Годен до',
    'Асбест', 'Каменская', 'Победы', 'Склад', 'Общий итог',
  ];

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(data, { header: headers });

  // Формат даты для колонки D
  const range = XLSX.utils.decode_range(ws['!ref']);
  for (let r = 1; r <= range.e.r; r++) {
    const cell = ws[XLSX.utils.encode_cell({ r, c: 3 })]; // колонка D
    if (cell && cell.t === 'd') {
      cell.z = 'DD.MM.YYYY';
    }
  }

  // Ширина колонок
  ws['!cols'] = [
    { wch: 40 }, { wch: 20 }, { wch: 16 }, { wch: 12 },
    { wch: 10 }, { wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 12 },
  ];

  XLSX.utils.book_append_sheet(wb, ws, 'Лист3');

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', cellDates: true });
}

module.exports = { processFiles, generateExcel, STORE_MAP };
