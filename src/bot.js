try { require('dotenv').config(); } catch (_) {}

const { Telegraf, Markup } = require('telegraf');
const path = require('path');
const fs   = require('fs');
const fetch = require('node-fetch');
const { processFiles, generateExcel } = require('./processor');
const { processOstatki } = require('./processor_ostatki');

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

bot.action('ostatki:template', async ctx => {
  await ctx.answerCbQuery();
  const templatePath = path.join(__dirname, 'templates', 'Продажи_шаблон.xlsx');
  if (!fs.existsSync(templatePath)) {
    return ctx.reply('⚠️ Файл шаблона не найден на сервере.');
  }
  await ctx.replyWithDocument(
    { source: fs.createReadStream(templatePath), filename: 'Продажи_шаблон.xlsx' },
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
      session.ostatki[ft.key] = await downloadFile(doc.file_id);
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
bot.launch({ dropPendingUpdates: true }).then(() => console.log('🤖 Бот запущен'));
process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
