try { require('dotenv').config(); } catch (_) {}

const { Telegraf, Markup } = require('telegraf');
const path = require('path');
const fs   = require('fs');
const fetch = require('node-fetch');
const { processFiles, generateExcel } = require('./processor');
const { processOstatki } = require('./processor_ostatki');
const pMin = require('./processor_min');

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error('Не задан BOT_TOKEN');
const bot = new Telegraf(BOT_TOKEN);

// ── Сессии ─────────────────────────────────────────────────────────────────
const sessions = new Map();

function getSession(chatId) {
  if (!sessions.has(chatId)) {
    sessions.set(chatId, {
      // Сроки годности
      srokiFiles: {},
      srokiBuffer: null,
      // Остатки товара
      ostatki: { sroki: null, sklad: null, ostatki: null, prodazhi: null },
      zakupBuffer: null,
      sbytBuffer:  null,
    });
  }
  return sessions.get(chatId);
}

function resetSroki(chatId) {
  const s = getSession(chatId);
  s.srokiFiles  = {};
  s.srokiBuffer = null;
}

function resetOstatki(chatId) {
  const s = getSession(chatId);
  s.ostatki    = { sroki: null, sklad: null, ostatki: null, prodazhi: null };
  s.zakupBuffer = null;
  s.sbytBuffer  = null;
}

// ── Константы ─────────────────────────────────────────────────────────────
const SROK_STORES = [
  { key: 'АСБ', label: 'Асбест'    },
  { key: 'КАМ', label: 'Каменская' },
  { key: 'ПОБ', label: 'Победы'    },
  { key: 'СКЛ', label: 'Склад'     },
];

const OSTATKI_FILES = [
  { key: 'sroki',    label: '📊 Сроки годности',
    detect: n => /сроки|srok/i.test(n) },
  { key: 'sklad',    label: '🏭 Товары склад',
    detect: n => /склад|sklad/i.test(n) && !/товар/i.test(n) },
  { key: 'ostatki',  label: '📦 Остатки товара',
    detect: n => /остатки.{0,5}товар|ostatki/i.test(n) },
  { key: 'prodazhi', label: '💰 Продажи',
    detect: n => /продаж|prodazh|sales/i.test(n) },
];

// ── Клавиатуры ────────────────────────────────────────────────────────────
const MAIN_MENU = Markup.inlineKeyboard([
  [Markup.button.callback('📊 Сроки годности',   'menu:sroki')],
  [Markup.button.callback('📦 Остатки товара',   'menu:ostatki')],
  [Markup.button.callback('📋 Минимальные остатки', 'menu:minOst')],
]);

const SROKI_MENU = (session) => {
  const ready = !!session.srokiBuffer;
  return Markup.inlineKeyboard([
    [Markup.button.callback('🔄 Обновить сроки годности', 'sroki:update')],
    [Markup.button.callback(
      ready ? '📥 Скачать файл со сроками ✅' : '📥 Скачать файл со сроками',
      'sroki:download')],
    [Markup.button.callback('📋 Скачать шаблон Продажи', 'ostatki:template')],
    [Markup.button.callback('⬅️ Главное меню', 'menu:main')],
  ]);
};

const OSTATKI_MENU = (session) => {
  const hasZakup = !!session.zakupBuffer;
  const hasSbyt  = !!session.sbytBuffer;
  return Markup.inlineKeyboard([
    [Markup.button.callback('🔄 Создать файл', 'ostatki:create')],
    [Markup.button.callback(
      hasZakup ? '📥 Скачать файл Закуп ✅' : '📥 Скачать файл Закуп',
      'ostatki:download_zakup')],
    [Markup.button.callback(
      hasSbyt ? '📥 Скачать файл Сбыт_Маркетинг ✅' : '📥 Скачать файл Сбыт_Маркетинг',
      'ostatki:download_sbyt')],
    [Markup.button.callback('📋 Скачать шаблон Продажи', 'ostatki:template')],
    [Markup.button.callback('⬅️ Главное меню', 'menu:main')],
  ]);
};

const BACK_TO_SROKI    = Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'menu:sroki')],[Markup.button.callback('🏠 Главное меню','menu:main')]]);
const BACK_TO_OSTATKI  = Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад','menu:ostatki')],[Markup.button.callback('🏠 Главное меню','menu:main')]]);

// ── Статусы загрузки ──────────────────────────────────────────────────────
function srokiStatus(files) {
  return SROK_STORES.map(s => `${files[s.key] ? '✅' : '⏳'} ${s.label}`).join('\n');
}

function ostatki_status(files) {
  return OSTATKI_FILES.map(f => `${files[f.key] ? '✅' : '⏳'} ${f.label}`).join('\n');
}

// ── Загрузка файла из Telegram ────────────────────────────────────────────
async function downloadFile(fileId) {
  const info = await bot.telegram.getFile(fileId);
  const url  = `https://api.telegram.org/file/bot${BOT_TOKEN}/${info.file_path}`;
  const res  = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// ═══════════════════════════════════════════════════════════════════════════
// КОМАНДЫ
// ═══════════════════════════════════════════════════════════════════════════

bot.start(ctx => {
  sessions.delete(ctx.chat.id);
  ctx.reply('👋 Привет! Выберите раздел:', MAIN_MENU);
});

// ── Главное меню ─────────────────────────────────────────────────────────
bot.action('menu:main', async ctx => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('🏠 Главное меню:', MAIN_MENU);
});

// ═══════════════════════════════════════════════════════════════════════════
// СРОКИ ГОДНОСТИ
// ═══════════════════════════════════════════════════════════════════════════

bot.action('menu:sroki', async ctx => {
  await ctx.answerCbQuery();
  const session = getSession(ctx.chat.id);

  // ── Минимальные остатки: принимаем файл с любым именем, проверяем структуру ──
  if (pMin.isWaitingForMin(ctx.chat.id)) {
    const saveMsg = await ctx.reply('⏳ Проверяю файл...');
    try {
      const buf = await downloadFile(doc.file_id);
      if (!pMin.isMinOstkiFile(buf)) {
        await ctx.telegram.editMessageText(ctx.chat.id, saveMsg.message_id, null,
          '⚠️ Файл не подходит — не найден лист «Одиночные группы».\n\nЗагрузите заполненный шаблон минимальных остатков.'
        );
        return;
      }
      pMin.clearWaitingForMin(ctx.chat.id);
      pMin.saveMinFile(buf, doc.file_id);
      await ctx.telegram.editMessageText(ctx.chat.id, saveMsg.message_id, null,
        '✅ Файл *Минимальные остатки* сохранён навсегда!\nДоступен до следующей замены.',
        { parse_mode: 'Markdown', ...MIN_OST_MENU() }
      );
    } catch (err) {
      await ctx.telegram.editMessageText(ctx.chat.id, saveMsg.message_id, null,
        `❌ Ошибка: ${err.message}`
      );
    }
    return;
  }


  const status  = session.srokiBuffer
    ? '✅ Файл готов к скачиванию'
    : '⚠️ Файл не сформирован — нажмите «Обновить»';
  await ctx.editMessageText(`📊 *Сроки годности*\n${status}`, {
    parse_mode: 'Markdown', ...SROKI_MENU(session),
  });
});

bot.action('sroki:update', async ctx => {
  await ctx.answerCbQuery();
  const session = getSession(ctx.chat.id);
  await ctx.editMessageText(
    `📤 *Загрузка файлов магазинов*\n\nОтправьте все 4 файла — в любом порядке.\nБот определит магазин по имени файла.\n\n${srokiStatus(session.srokiFiles)}`,
    { parse_mode: 'Markdown', ...BACK_TO_SROKI }
  );
});

bot.action('sroki:download', async ctx => {
  await ctx.answerCbQuery();
  const session = getSession(ctx.chat.id);
  if (!session.srokiBuffer) {
    return ctx.answerCbQuery('⚠️ Сначала загрузите файлы магазинов', { show_alert: true });
  }
  const date = new Date().toLocaleDateString('ru-RU').replace(/\./g, '-');
  await ctx.replyWithDocument(
    { source: session.srokiBuffer, filename: `Сроки_годности_${date}.xlsx` },
    { caption: `📊 Сроки годности — ${date}` }
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// ОСТАТКИ ТОВАРА
// ═══════════════════════════════════════════════════════════════════════════

bot.action('menu:ostatki', async ctx => {
  await ctx.answerCbQuery();
  const session = getSession(ctx.chat.id);
  const loaded  = Object.values(session.ostatki).filter(Boolean).length;
  const status  = session.zakupBuffer
    ? '✅ Файлы готовы к скачиванию'
    : loaded > 0 ? `⏳ Загружено ${loaded}/4 файлов`
    : '⚠️ Файлы не сформированы — нажмите «Создать файл»';
  await ctx.editMessageText(`📦 *Остатки товара*\n${status}`, {
    parse_mode: 'Markdown', ...OSTATKI_MENU(session),
  });
});

bot.action('ostatki:create', async ctx => {
  await ctx.answerCbQuery();
  const session = getSession(ctx.chat.id);

  // Если Сроки годности уже есть в сессии — подставляем автоматически
  if (session.srokiBuffer && !session.ostatki.sroki) {
    session.ostatki.sroki = session.srokiBuffer;
  }

  await ctx.editMessageText(
    `📤 *Создание файла Остатки товара*\n\n` +
    `Отправьте 4 файла в любом порядке.\n` +
    `Бот определяет тип по имени файла:\n\n` +
    `${ostatki_status(session.ostatki)}\n\n` +
    `_Если файл Сроки годности уже был загружен в этой сессии — он подставлен автоматически._`,
    { parse_mode: 'Markdown', ...BACK_TO_OSTATKI }
  );
});

// Шаблон файла Продажи встроен как base64 — не зависит от файловой системы сервера
const PRODAZHI_TEMPLATE_B64 = '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';

bot.action('ostatki:template', async ctx => {
  await ctx.answerCbQuery();
  const buffer = Buffer.from(PRODAZHI_TEMPLATE_B64, 'base64');
  await ctx.replyWithDocument(
    { source: buffer, filename: 'Продажи_шаблон.xlsx' },
    { caption: '📋 Шаблон файла Продажи\n\nЗаполните листы АСБ, КАМ, ПОБ:\n• Столбец A: ШК\n• Столбец B: Покупка (кол-во за 14 дней)' }
  );
});

bot.action('ostatki:download_zakup', async ctx => {
  await ctx.answerCbQuery();
  const session = getSession(ctx.chat.id);
  if (!session.zakupBuffer) {
    return ctx.answerCbQuery('⚠️ Сначала создайте файл', { show_alert: true });
  }
  const date = new Date().toLocaleDateString('ru-RU').replace(/\./g, '-');
  await ctx.replyWithDocument(
    { source: session.zakupBuffer, filename: `Закуп_${date}.xlsx` },
    { caption: `📦 Закуп — ${date}` }
  );
});

bot.action('ostatki:download_sbyt', async ctx => {
  await ctx.answerCbQuery();
  const session = getSession(ctx.chat.id);
  if (!session.sbytBuffer) {
    return ctx.answerCbQuery('⚠️ Сначала создайте файл', { show_alert: true });
  }
  const date = new Date().toLocaleDateString('ru-RU').replace(/\./g, '-');
  await ctx.replyWithDocument(
    { source: session.sbytBuffer, filename: `Сбыт_Маркетинг_${date}.xlsx` },
    { caption: `📊 Сбыт_Маркетинг — ${date}` }
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// ОБРАБОТКА ДОКУМЕНТОВ
// ═══════════════════════════════════════════════════════════════════════════

bot.on('document', async ctx => {
  const doc  = ctx.message.document;
  const name = doc.file_name || '';

  if (!name.toLowerCase().endsWith('.xlsx') && !name.toLowerCase().endsWith('.xlsm')) {
    return ctx.reply('⚠️ Нужен файл .xlsx или .xlsm');
  }

  const session = getSession(ctx.chat.id);

  // ── Определяем контекст: Сроки или Остатки ──────────────────────────────
  // СКЛ матчим только как отдельное слово — иначе «товары склад.xlsx» ложно
  // определяется как файл магазина Склад и ломает сборку.
  function matchStore(filename, key) {
    const n = filename.toUpperCase();
    if (key === 'СКЛ') return /(?:^|[^А-ЯЁA-Z0-9])СКЛ(?:[^А-ЯЁA-Z0-9]|$)/.test(n);
    return n.includes(key);
  }

  const isSrokiStore = SROK_STORES.some(s => matchStore(name, s.key));

  // Остатки — по именам файлов
  const ostatki_type = OSTATKI_FILES.find(f => f.detect(name));
  const isOstatki = !!ostatki_type && !isSrokiStore;

  // ── СРОКИ ГОДНОСТИ: файлы магазинов ────────────────────────────────────
  if (isSrokiStore) {
    const store = SROK_STORES.find(s => matchStore(name, s.key));
    const msg = await ctx.reply(`⏳ Получаю файл *${store.label}*...`, { parse_mode: 'Markdown' });

    try {
      session.srokiFiles[store.key] = await downloadFile(doc.file_id);
      const loaded = Object.keys(session.srokiFiles).length;

      await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
        `✅ *${store.label}* загружен (${loaded}/4)\n\n${srokiStatus(session.srokiFiles)}`,
        { parse_mode: 'Markdown' }
      );

      if (loaded === 4) {
        const procMsg = await ctx.reply('⚙️ Формирую Сроки годности...');
        try {
          const data   = processFiles(session.srokiFiles);
          const buffer = generateExcel(data);
          session.srokiBuffer = buffer;
          // Подставляем в остатки если ещё не загружен
          if (!session.ostatki.sroki) session.ostatki.sroki = buffer;

          await ctx.telegram.editMessageText(ctx.chat.id, procMsg.message_id, null,
            `✅ *Сроки годности готовы!* Строк: ${data.length}\n\nНажмите «Скачать» в меню.`,
            { parse_mode: 'Markdown', ...BACK_TO_SROKI }
          );
        } catch (err) {
          await ctx.telegram.editMessageText(ctx.chat.id, procMsg.message_id, null,
            `❌ Ошибка: ${err.message}`
          );
        }
      }
    } catch (err) {
      await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
        `❌ Не удалось загрузить файл: ${err.message}`
      );
    }
    return;
  }

  // ── ОСТАТКИ ТОВАРА: 4 файла ─────────────────────────────────────────────
  if (isOstatki) {
    const ft  = ostatki_type;
    const msg = await ctx.reply(`⏳ Получаю *${ft.label}*...`, { parse_mode: 'Markdown' });

    try {
      const fileBuffer = await downloadFile(doc.file_id);
      session.ostatki[ft.key] = fileBuffer;

      // Сохраняем группы на диск при загрузке Склад
      if (ft.key === 'sklad') {
        try {
          const groups = pMin.extractGroupsFromSklad(fileBuffer);
          if (groups.length > 0) pMin.saveSkładGroups(groups);
        } catch (e) { /* ignore */ }
      }
      const loaded = Object.values(session.ostatki).filter(Boolean).length;

      await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
        `✅ *${ft.label}* загружен (${loaded}/4)\n\n${ostatki_status(session.ostatki)}`,
        { parse_mode: 'Markdown' }
      );

      if (loaded === 4) {
        await buildOstatki(ctx, session);
      }
    } catch (err) {
      await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
        `❌ Не удалось загрузить файл: ${err.message}`
      );
    }
    return;
  }


  // ── Не удалось определить ───────────────────────────────────────────────
  await ctx.reply(
    `❓ Не могу определить тип файла по имени *«${name}»*.\n\n` +
    `Ожидаю файлы с именами содержащими:\n` +
    `• АСБ / КАМ / ПОБ / СКЛ — для Сроков годности\n` +
    `• сроки — Сроки годности (для раздела Остатки)\n` +
    `• склад — Товары склад\n` +
    `• остатки — Остатки товара\n` +
    `• продажи — Продажи`,
    { parse_mode: 'Markdown', ...BACK_TO_OSTATKI }
  );
});

// ── Сборка Остатков ────────────────────────────────────────────────────────
async function buildOstatki(ctx, session) {
  const procMsg = await ctx.reply('⚙️ Все файлы получены! Формирую Закуп и Сбыт_Маркетинг...');
  try {
    const { zakupBuffer, sbytBuffer, rowCount } = processOstatki({
      srokiBuffer:    session.ostatki.sroki,
      skladBuffer:    session.ostatki.sklad,
      ostatki_buffer: session.ostatki.ostatki,
      prodazhiBuffer: session.ostatki.prodazhi,
    });

    session.zakupBuffer = zakupBuffer;
    session.sbytBuffer  = sbytBuffer;

    const date = new Date().toLocaleDateString('ru-RU').replace(/\./g, '-');

    await ctx.telegram.editMessageText(ctx.chat.id, procMsg.message_id, null,
      `✅ *Готово!* Обработано строк: ${rowCount}. Отправляю файлы...`,
      { parse_mode: 'Markdown' }
    );

    // Отправляем оба файла сразу — не зависим от сессии при перезапуске
    await ctx.replyWithDocument(
      { source: zakupBuffer, filename: `Закуп_${date}.xlsx` },
      { caption: `📦 Закуп — ${date}` }
    );
    await ctx.replyWithDocument(
      { source: sbytBuffer, filename: `Сбыт_Маркетинг_${date}.xlsx` },
      { caption: `📊 Сбыт_Маркетинг — ${date}` }
    );

    await ctx.reply(
      '✅ Оба файла отправлены!\nДля повторного скачивания — кнопки меню:',
      OSTATKI_MENU(session)
    );
  } catch (err) {
    console.error('Ошибка сборки:', err);
    await ctx.telegram.editMessageText(ctx.chat.id, procMsg.message_id, null,
      `❌ Ошибка:
${err.message}`
    );
  }
}

// ── Запуск ─────────────────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════════════
// МИНИМАЛЬНЫЕ ОСТАТКИ
// ═══════════════════════════════════════════════════════════════════════════

function MIN_OST_MENU() {
  const hasSaved = pMin.hasMinFile();
  const savedAt  = pMin.getMinFileSavedAt();
  return Markup.inlineKeyboard([
    [Markup.button.callback(
      hasSaved ? `📥 Скачать последний файл (${savedAt})` : '📥 Скачать последний файл',
      'minOst:download')],
    [Markup.button.callback('🔄 Обновить минимальные остатки', 'minOst:update')],
    [Markup.button.callback('⬅️ Главное меню', 'menu:main')],
  ]);
}

bot.action('menu:minOst', async ctx => {
  await ctx.answerCbQuery();
  const hasSaved = pMin.hasMinFile();
  const status   = hasSaved
    ? `✅ Файл загружен ${pMin.getMinFileSavedAt()}`
    : '⚠️ Файл ещё не загружен';
  await ctx.editMessageText(
    `📋 *Минимальные остатки*\n${status}`,
    { parse_mode: 'Markdown', ...MIN_OST_MENU() }
  );
});

// Скачать сохранённый файл
bot.action('minOst:download', async ctx => {
  await ctx.answerCbQuery();
  if (!pMin.hasMinFile()) {
    return ctx.answerCbQuery('⚠️ Файл ещё не загружен', { show_alert: true });
  }
  const filePath = pMin.getMinFilePath();
  const fileId   = pMin.getMinFileId();
  const savedAt  = pMin.getMinFileSavedAt();
  if (filePath) {
    await ctx.replyWithDocument(
      { source: filePath, filename: `Минимальные_остатки_${savedAt}.xlsm` },
      { caption: `📋 Минимальные остатки — сохранён ${savedAt}` }
    );
  } else if (fileId) {
    await ctx.replyWithDocument(fileId,
      { caption: `📋 Минимальные остатки — сохранён ${savedAt}` }
    );
  }
});

// Обновить: заполнить шаблон группами и отдать пользователю
bot.action('minOst:update', async ctx => {
  await ctx.answerCbQuery();
  const session = getSession(ctx.chat.id);

  // Группы берём из disk или из текущей сессии Склад
  let groups = pMin.loadSkładGroups();

  // Если в сессии загружен Склад — обновляем группы с него
  if (session.ostatki && session.ostatki.sklad) {
    try {
      const fresh = pMin.extractGroupsFromSklad(session.ostatki.sklad);
      if (fresh.length > 0) {
        groups = fresh;
        pMin.saveSkładGroups(groups);
      }
    } catch (e) { /* используем сохранённые */ }
  }

  if (groups.length === 0) {
    return ctx.reply(
      '⚠️ Нет данных о группах.\nСначала загрузите файл *Товары склад* в разделе «Остатки товара».',
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'menu:minOst')]]) }
    );
  }

  // Заполняем шаблон
  const buf = await pMin.fillTemplate(groups);
  pMin.setWaitingForMin(ctx.chat.id); // сохраняем на диск — переживает рестарт

  await ctx.replyWithDocument(
    { source: buf, filename: 'Минимальные_остатки_шаблон.xlsm' },
    { caption: `📋 Шаблон заполнен: ${groups.length} групп в столбце A.\n\nЗаполните файл и загрузите его обратно в этот чат.` }
  );
});

bot.launch({ dropPendingUpdates: true }).then(() => console.log('🤖 Бот запущен'));
process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
