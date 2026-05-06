try { require('dotenv').config(); } catch (_) {}

const { Telegraf, Markup } = require('telegraf');
const fetch = require('node-fetch');
const { processFiles, generateExcel } = require('./processor');

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error('Не задан BOT_TOKEN в переменных окружения');

const bot = new Telegraf(BOT_TOKEN);

// ─── Сессии ───────────────────────────────────────────────────────────────────
// chatId → { files: {АСБ,КАМ,ПОБ,СКЛ}, resultBuffer: Buffer|null }
const sessions = new Map();

function getSession(chatId) {
  if (!sessions.has(chatId)) {
    sessions.set(chatId, { files: {}, resultBuffer: null });
  }
  return sessions.get(chatId);
}

// ─── Константы ────────────────────────────────────────────────────────────────
const STORES = [
  { key: 'АСБ', label: 'Асбест'    },
  { key: 'КАМ', label: 'Каменская' },
  { key: 'ПОБ', label: 'Победы'    },
  { key: 'СКЛ', label: 'Склад'     },
];

// ─── Клавиатуры ───────────────────────────────────────────────────────────────
const MAIN_MENU = Markup.inlineKeyboard([
  [Markup.button.callback('📊 Сроки годности',   'menu:srok')],
  [Markup.button.callback('📦 Остатки товара',   'menu:ostatki')],
]);

const SROK_MENU = Markup.inlineKeyboard([
  [Markup.button.callback('🔄 Обновить сроки годности', 'srok:update')],
  [Markup.button.callback('📥 Скачать файл со сроками', 'srok:download')],
  [Markup.button.callback('⬅️ Главное меню',             'menu:main')],
]);

const BACK_TO_SROK = Markup.inlineKeyboard([
  [Markup.button.callback('⬅️ Назад',        'menu:srok')],
  [Markup.button.callback('🏠 Главное меню', 'menu:main')],
]);

// ─── Хелперы ──────────────────────────────────────────────────────────────────
function uploadStatus(files) {
  return STORES.map(s =>
    `${files[s.key] ? '✅' : '⏳'} ${s.label} (${s.key}.xlsx)`
  ).join('\n');
}

function detectStore(filename) {
  const upper = filename.toUpperCase();
  return STORES.find(s => upper.includes(s.key)) ?? null;
}

async function downloadFile(fileId) {
  const info = await bot.telegram.getFile(fileId);
  const url  = `https://api.telegram.org/file/bot${BOT_TOKEN}/${info.file_path}`;
  const res  = await fetch(url);
  if (!res.ok) throw new Error(`Ошибка скачивания: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// ─── Команды ──────────────────────────────────────────────────────────────────
bot.start(ctx => {
  sessions.delete(ctx.chat.id);
  ctx.reply('👋 Привет! Выберите раздел:', MAIN_MENU);
});

// ─── Главное меню ─────────────────────────────────────────────────────────────
bot.action('menu:main', async ctx => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('🏠 Главное меню — выберите раздел:', MAIN_MENU);
});

// ─── Сроки годности: подменю ──────────────────────────────────────────────────
bot.action('menu:srok', async ctx => {
  await ctx.answerCbQuery();
  const { resultBuffer } = getSession(ctx.chat.id);
  const status = resultBuffer
    ? '✅ Файл готов к скачиванию'
    : '⚠️ Файл ещё не сформирован — нажмите «Обновить»';
  await ctx.editMessageText(
    `📊 *Сроки годности*\n${status}`,
    { parse_mode: 'Markdown', ...SROK_MENU }
  );
});

// ─── Остатки товара: заглушка ─────────────────────────────────────────────────
bot.action('menu:ostatki', async ctx => {
  await ctx.answerCbQuery();
  await ctx.editMessageText(
    '📦 *Остатки товара*\n\n🚧 Раздел в разработке — скоро будет доступен.',
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard([
      [Markup.button.callback('⬅️ Главное меню', 'menu:main')],
    ])}
  );
});

// ─── Обновить: показываем статус и ждём файлы ─────────────────────────────────
bot.action('srok:update', async ctx => {
  await ctx.answerCbQuery();
  const { files } = getSession(ctx.chat.id);
  await ctx.editMessageText(
    `📤 *Загрузка файлов*\n\n` +
    `Отправьте в чат все 4 файла магазинов — в любом порядке.\n` +
    `Бот определит их автоматически по названию.\n\n` +
    uploadStatus(files),
    { parse_mode: 'Markdown', ...BACK_TO_SROK }
  );
});

// ─── Скачать файл ─────────────────────────────────────────────────────────────
bot.action('srok:download', async ctx => {
  await ctx.answerCbQuery();
  const session = getSession(ctx.chat.id);

  if (!session.resultBuffer) {
    await ctx.answerCbQuery('⚠️ Файл не сформирован. Сначала загрузите файлы магазинов.', { show_alert: true });
    return;
  }

  const date = new Date().toLocaleDateString('ru-RU').replace(/\./g, '-');
  await ctx.replyWithDocument(
    { source: session.resultBuffer, filename: `Сроки_годности_${date}.xlsx` },
    { caption: `📊 Сроки годности — ${date}` }
  );
});

// ─── Приём документов ─────────────────────────────────────────────────────────
bot.on('document', async ctx => {
  const doc = ctx.message.document;

  if (!doc.file_name.toLowerCase().endsWith('.xlsx')) {
    return ctx.reply('⚠️ Нужен файл в формате .xlsx');
  }

  const store = detectStore(doc.file_name);
  if (!store) {
    return ctx.reply(
      '❓ Не могу определить магазин по названию файла.\n' +
      'Название должно содержать: АСБ, КАМ, ПОБ или СКЛ.',
      BACK_TO_SROK
    );
  }

  const session = getSession(ctx.chat.id);
  const loadMsg = await ctx.reply(`⏳ Получаю файл *${store.label}*...`, { parse_mode: 'Markdown' });

  try {
    session.files[store.key] = await downloadFile(doc.file_id);

    const loaded = Object.keys(session.files).length;
    const allDone = loaded === 4;

    await ctx.telegram.editMessageText(
      ctx.chat.id, loadMsg.message_id, null,
      `✅ *${store.label}* загружен (${loaded}/4)\n\n${uploadStatus(session.files)}`,
      { parse_mode: 'Markdown' }
    );

    if (allDone) {
      // Все файлы есть — обрабатываем и сохраняем результат
      const procMsg = await ctx.reply('⚙️ Формирую файл со сроками годности...');
      try {
        const data = processFiles(session.files);
        session.resultBuffer = generateExcel(data);

        await ctx.telegram.editMessageText(
          ctx.chat.id, procMsg.message_id, null,
          `✅ *Готово!* Строк в файле: ${data.length}\n\nНажмите «Скачать файл со сроками» в меню.`,
          { parse_mode: 'Markdown', ...BACK_TO_SROK }
        );
      } catch (err) {
        console.error('Ошибка генерации:', err);
        await ctx.telegram.editMessageText(
          ctx.chat.id, procMsg.message_id, null,
          `❌ Ошибка при создании файла: ${err.message}`
        );
      }
    }
  } catch (err) {
    console.error('Ошибка загрузки файла:', err);
    await ctx.telegram.editMessageText(
      ctx.chat.id, loadMsg.message_id, null,
      `❌ Не удалось загрузить файл: ${err.message}`
    );
  }
});

// ─── Запуск ───────────────────────────────────────────────────────────────────
bot.launch().then(() => console.log('🤖 Бот запущен'));

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
