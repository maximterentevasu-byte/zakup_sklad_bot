/**
 * processor_ostatki.js
 * Собирает файлы Закуп и Сбыт_Маркетинг из 4 источников:
 * Сроки годности, Склад, Остатки товара, Продажи
 */
const XLSX = require('xlsx');

const TODAY = new Date();
TODAY.setHours(0, 0, 0, 0);

// ── Нормализация ШК ──────────────────────────────────────────────────────────
// float 6920339002138.69 → '6920339002138'  (int-часть)
// '089894834106'         → '89894834106'    (убираем ведущие нули у числовых)
function normalizeShk(val) {
  if (val == null) return '';
  let s;
  if (typeof val === 'number') {
    s = String(Math.trunc(val));
  } else {
    s = String(val).trim();
    if (s.includes('.')) {
      const n = parseFloat(s);
      if (!isNaN(n)) s = String(Math.trunc(n));
    }
  }
  // Убираем ведущие нули только у числовых ШК
  if (/^\d+$/.test(s)) s = s.replace(/^0+/, '') || '0';
  return s;
}

function splitShk(val) {
  const raw = normalizeShk(val);
  return raw.replace(/ /g, '').split(',')
    .map(s => s.trim())
    .filter(s => s && s !== 'nan' && s !== 'None');
}

// ── Загрузка Склад (основа) ───────────────────────────────────────────────────
function loadSklad(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: null });

  const result = [];
  const allShks = new Set(); // для canonical ШК

  for (const row of rows) {
    const name = String(row['Наименование'] || '').trim();
    if (!name || name === 'null') continue;
    const shks = splitShk(row['Штрих-код']);
    shks.forEach(s => allShks.add(s));
    result.push({
      name,
      group:   String(row['Группа'] || '').trim(),
      shkRaw:  shks.join(', '),   // оригинальный вид (без ведущих нулей, нормализован)
      shkList: shks,
    });
  }
  return { rows: result, allShks };
}

// ── Загрузка Остатки товара ───────────────────────────────────────────────────
// Дедупликация по row_id: одна строка-источник не считается дважды
// даже если несколько ШК из нашего списка указывают на неё
function loadOstatki(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

  // Строки 0,1,2 = заголовки, с 3-й = данные
  // Колонки: 0=Наим 1=Арт 2=ШК 3=Итого 4=Склад 5=КАМ 6=АСБ 7=ПОБ
  const lookup = new Map(); // shk → [ {rowId, Склад, КАМ, АСБ, ПОБ} ]

  for (let rowId = 3; rowId < raw.length; rowId++) {
    const row = raw[rowId];
    if (!row || !row[2]) continue;
    const shks = splitShk(row[2]);
    if (!shks.length) continue;

    const vals = {
      rowId,
      Склад: parseFloat(row[4]) || 0,
      КАМ:   parseFloat(row[5]) || 0,
      АСБ:   parseFloat(row[6]) || 0,
      ПОБ:   parseFloat(row[7]) || 0,
    };

    for (const shk of shks) {
      if (!lookup.has(shk)) lookup.set(shk, []);
      lookup.get(shk).push(vals);
    }
  }
  return lookup;
}

function sumOstatki(shkList, lookup) {
  const seen = new Set();
  const totals = { Склад: 0, КАМ: 0, АСБ: 0, ПОБ: 0 };
  for (const shk of shkList) {
    for (const entry of (lookup.get(shk) || [])) {
      if (!seen.has(entry.rowId)) {
        seen.add(entry.rowId);
        for (const k of Object.keys(totals)) totals[k] += entry[k];
      }
    }
  }
  return totals;
}

// ── Загрузка Продажи (3 листа) ────────────────────────────────────────────────
function loadProdazhi(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const result = {};

  for (const sheetName of ['АСБ', 'КАМ', 'ПОБ']) {
    const ws = wb.Sheets[sheetName];
    if (!ws) continue;
    const rows = XLSX.utils.sheet_to_json(ws, { defval: null });
    const lookup = new Map(); // shk → [ {rowId, qty} ]

    rows.forEach((row, rowId) => {
      const qty = parseFloat(row['Покупка']) || 0;
      for (const shk of splitShk(row['ШК'])) {
        if (!lookup.has(shk)) lookup.set(shk, []);
        lookup.get(shk).push({ rowId, qty });
      }
    });
    result[sheetName] = lookup;
  }
  return result;
}

function sumProdazhi(shkList, lookup) {
  const seen = new Set();
  let total = 0;
  for (const shk of shkList) {
    for (const { rowId, qty } of (lookup.get(shk) || [])) {
      if (!seen.has(rowId)) { seen.add(rowId); total += qty; }
    }
  }
  return total;
}

// ── Загрузка Сроки годности ────────────────────────────────────────────────────
function loadSroki(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const ws = wb.Sheets['Лист3'];
  if (!ws) throw new Error('Лист "Лист3" не найден в файле Сроки годности');
  return XLSX.utils.sheet_to_json(ws, { defval: null });
}

function buildSrokLookup(srokiRows, onlySklad = false) {
  const lookup = new Map(); // shk → строка с днями или 'Возм. Акция'

  const items = [];
  for (const row of srokiRows) {
    const skladQty = parseFloat(row['Склад']) || 0;
    if (onlySklad && skladQty <= 0) continue;

    const shk = normalizeShk(row['Штрихкод']);
    if (!shk || shk === 'nan') continue;

    let expiry = row['Годен до'];
    if (!expiry) continue;
    if (!(expiry instanceof Date)) expiry = new Date(expiry);
    if (isNaN(expiry)) continue;

    expiry.setHours(0, 0, 0, 0);
    const days = Math.round((expiry - TODAY) / 86400000);

    items.push({ shk, days, isDup: false });
    items.push({ shk: '9' + shk, days, isDup: true });
  }

  // Группируем по ШК
  const grouped = new Map();
  for (const item of items) {
    if (!grouped.has(item.shk)) grouped.set(item.shk, { days: [], isDup: item.isDup });
    const existing = grouped.get(item.shk);
    if (!existing.days.includes(item.days)) existing.days.push(item.days);
  }

  for (const [shk, { days, isDup }] of grouped) {
    days.sort((a, b) => a - b);
    let value;
    if (!onlySklad && !isDup && days.some(d => d <= 30)) {
      value = 'Возм. Акция';
    } else {
      value = days.join(', ');
    }
    lookup.set(shk, value);
  }
  return lookup;
}

function findFirst(shkList, lookup) {
  for (const shk of shkList) {
    if (lookup.has(shk)) return lookup.get(shk);
  }
  return '';
}

// ── F-колонка: связные компоненты по общим ШК ──────────────────────────────
// Два товара в одной "семье" если:
// 1. Прямо: у них есть общий ШК (любой из списка)
// 2. Через canonical: один ШК начинается с '9', а ШК без ведущей '9' есть в базе
//    (акционный товар → его обычная версия)
function computeF(rows, allBaseShks) {
  const n = rows.length;

  // Union-Find
  const parent = Array.from({ length: n }, (_, i) => i);
  function find(x) {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  }
  function union(a, b) {
    const pa = find(a), pb = find(b);
    if (pa !== pb) parent[pa] = pb;
  }

  // Строим shk → [индексы строк]
  const shkToIdxs = new Map();
  rows.forEach((row, idx) => {
    for (const shk of row.shkList) {
      if (!shkToIdxs.has(shk)) shkToIdxs.set(shk, []);
      shkToIdxs.get(shk).push(idx);
    }
  });

  // Связываем строки с одинаковым ШК (прямые связи)
  for (const idxs of shkToIdxs.values()) {
    for (let k = 1; k < idxs.length; k++) union(idxs[0], idxs[k]);
  }

  // Canonical bridge: акционный (9+ШК) → обычный (ШК без 9)
  // Критерий: первый ШК строки начинается с '9' И ШК[1:] существует в базе
  rows.forEach((row, idx) => {
    const first = row.shkList[0];
    if (!first || !first.startsWith('9')) return;
    const canonical = first.slice(1);
    if (!allBaseShks.has(canonical)) return;
    for (const idx2 of (shkToIdxs.get(canonical) || [])) {
      union(idx, idx2);
    }
  });

  // Считаем G по компонентам
  const compG = new Map();
  rows.forEach((row, idx) => {
    const root = find(idx);
    compG.set(root, (compG.get(root) || 0) + row.g);
  });

  return rows.map((_, idx) => compG.get(find(idx)) || 0);
}

// ── Генерация Excel ────────────────────────────────────────────────────────────
function nv(v) { return (v === 0 || v == null || isNaN(v)) ? null : v; }

function generateExcel(rows, withSrokSklad, sheetTitle) {
  const headers = withSrokSklad
    ? ['Группа', 'Наименование товара', 'ШК',
       'Окончание срока годности', 'Все сроки товара склад',
       'Общий остаток\nАкция и Неакция', 'Все остатки',
       'ОСТ Склад', 'ОСТ КАМ', 'ОСТ АСБ', 'ОСТ ПОБ',
       'Продажи ОБЩ', 'Продажи КАМ', 'Продажи АСБ', 'Продажи ПОБ']
    : ['Группа', 'Наименование товара', 'ШК',
       'Окончание срока годности',
       'Общий остаток\nАкция и Неакция', 'Все остатки',
       'ОСТ Склад', 'ОСТ КАМ', 'ОСТ АСБ', 'ОСТ ПОБ',
       'Продажи ОБЩ', 'Продажи КАМ', 'Продажи АСБ', 'Продажи ПОБ'];

  // Поля которые суммируются в промежуточных итогах
  const SUM_FIELDS = ['f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o'];

  // ── Строим плоский массив строк с промежуточными итогами ─────────────────
  const allRows = [];   // { isSubtotal, ...данные }
  let curGroup  = null;
  let groupAcc  = {};   // накопители сумм текущей группы

  function resetAcc() { SUM_FIELDS.forEach(f => groupAcc[f] = 0); }
  function flushGroup() {
    if (curGroup === null) return;
    allRows.push({
      isSubtotal: true,
      group:  `Итого: ${curGroup}`,
      ...Object.fromEntries(SUM_FIELDS.map(f => [f, groupAcc[f]]))
    });
  }

  resetAcc();
  for (const row of rows) {
    if (curGroup !== null && row.group !== curGroup) {
      flushGroup();
      resetAcc();
    }
    curGroup = row.group;
    SUM_FIELDS.forEach(f => groupAcc[f] += (row[f] || 0));
    allRows.push({ isSubtotal: false, ...row });
  }
  flushGroup(); // последняя группа

  // ── Конвертируем в формат для json_to_sheet ───────────────────────────────
  const sheetData = allRows.map(row => {
    if (row.isSubtotal) {
      const r = { 'Группа': row.group };
      // Числовые столбцы — вычисленные суммы (null если 0)
      Object.assign(r, {
        ['Общий остаток\nАкция и Неакция']: nv(row.f),
        'Все остатки': nv(row.g),
        'ОСТ Склад':   nv(row.h),
        'ОСТ КАМ':     nv(row.i),
        'ОСТ АСБ':     nv(row.j),
        'ОСТ ПОБ':     nv(row.k),
        'Продажи ОБЩ': nv(row.l),
        'Продажи КАМ': nv(row.m),
        'Продажи АСБ': nv(row.n),
        'Продажи ПОБ': nv(row.o),
      });
      return r;
    }
    // Обычная строка данных
    const r = {
      'Группа':               row.group,
      'Наименование товара':  row.name,
      'ШК':                   row.shkRaw || null,
      'Окончание срока годности': row.colD || null,
    };
    if (withSrokSklad) r['Все сроки товара склад'] = row.colE || null;
    Object.assign(r, {
      ['Общий остаток\nАкция и Неакция']: nv(row.f),
      'Все остатки': nv(row.g),
      'ОСТ Склад':   nv(row.h),
      'ОСТ КАМ':     nv(row.i),
      'ОСТ АСБ':     nv(row.j),
      'ОСТ ПОБ':     nv(row.k),
      'Продажи ОБЩ': nv(row.l),
      'Продажи КАМ': nv(row.m),
      'Продажи АСБ': nv(row.n),
      'Продажи ПОБ': nv(row.o),
    });
    return r;
  });

  // ── Пишем в xlsx ──────────────────────────────────────────────────────────
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(sheetData, { header: headers });

  ws['!cols'] = withSrokSklad
    ? [18, 44, 17, 15, 15, 8, 8, 8, 8, 8, 8, 9, 9, 9, 9].map(w => ({ wch: w }))
    : [18, 44, 17, 15,     8, 8, 8, 8, 8, 8, 9, 9, 9, 9].map(w => ({ wch: w }));

  XLSX.utils.book_append_sheet(wb, ws, sheetTitle);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}


// ── Главная функция сборки ────────────────────────────────────────────────────
function processOstatki({ srokiBuffer, skladBuffer, ostatki_buffer, prodazhiBuffer }) {
  // Загрузка
  const srokiRows  = loadSroki(srokiBuffer);
  const { rows: skladRows, allShks: allBaseShks } = loadSklad(skladBuffer);
  const ostatki    = loadOstatki(ostatki_buffer);
  const prodazhi   = loadProdazhi(prodazhiBuffer);

  const srokLookup  = buildSrokLookup(srokiRows, false);
  const srokSkladLookup = buildSrokLookup(srokiRows, true);

  // Основной цикл
  const rows = [];
  for (const rec of skladRows) {
    const { shkList, group, name, shkRaw } = rec;
    const ost = sumOstatki(shkList, ostatki);
    const h = ost.Склад, i = ost.КАМ, j = ost.АСБ, k = ost.ПОБ;
    const g = h + i + j + k;
    const m = sumProdazhi(shkList, prodazhi['КАМ'] || new Map());
    const n = sumProdazhi(shkList, prodazhi['АСБ'] || new Map());
    const o = sumProdazhi(shkList, prodazhi['ПОБ'] || new Map());

    rows.push({
      group, name, shkRaw, shkList,
      colD: findFirst(shkList, srokLookup),
      colE: findFirst(shkList, srokSkladLookup),
      g, h, i, j, k,
      l: m + n + o, m, n, o,
      f: 0, // заполним после
    });
  }

  // Сортировка
  rows.sort((a, b) => {
    const gc = a.group.localeCompare(b.group, 'ru');
    return gc !== 0 ? gc : a.name.localeCompare(b.name, 'ru');
  });

  // F: связные компоненты
  const fValues = computeF(rows, allBaseShks);
  rows.forEach((r, idx) => r.f = fValues[idx]);

  // Генерируем два отдельных файла
  const zakupBuffer = generateExcel(rows, false, 'Закуп');
  const sbytBuffer  = generateExcel(rows, true,  'Сбыт_Маркетинг');

  return { zakupBuffer, sbytBuffer, rowCount: rows.length };
}

module.exports = { processOstatki };
