require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const fetch = require('node-fetch');
const { processFiles, generateExcel } = require('./processor');

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error('Не задан BOT_TOKEN в переменных окружения');

const bot = new Telegraf(BOT_TOKEN);

// ─── Хранилище сессий (в памяти) ──────────────────────────────────────────────
// chatId → { files: { АСБ: Buffer, КАМ: Buffer, ПОБ: Buffer, СКЛ: Buffer }, pending: String|null }
const sessions = new Map();

const STORES = [
  { key: 'АСБ', label: '🏪 Асбест'    },
  { key: 'КАМ', label: '🏪 Каменская' },
  { key: 'ПОБ', label: '🏪 Победы'    },
  { key: 'СКЛ', label: '🏦 Склад'     },
];

function getSession(chatId) {
  if (!sessions.has(chatId)) {
    sessions.set(chatId, { files: {}, pending: null });
  }
  return sessions.get(chatId);
}

function resetSession(chatId) {
  sessions.set(chatId, { files: {}, pending: null });
}

// Сколько файлов уже загружено
function uploadedList(files) {
  return STORES.map(s => `${files[s.key] ? '✅' : '⬜'} ${s.label}`).join('\n');
}

// Клавиатура для выбора магазина
function storeKeyboard(uploadedFiles) {
  const buttons = STORES
    .filter(s => !uploadedFiles[s.key])
    .map(s => [Markup.button.callback(s.label, `store:${s.key}`)]);

  buttons.push([Markup.button.callback('🔄 Начать заново', 'restart')]);
  return Markup.inlineKeyboard(buttons);
}

// Скачиваем файл из Telegram → Buffer
async function downloadFile(fileId) {
  const fileInfo = await bot.telegram.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.file_path}`;
  const res  = await fetch(url);
  if (!res.ok) throw new Error(`Ошибка загрузки файла: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// ─── Команды ──────────────────────────────────────────────────────────────────

bot.start(ctx => {
  resetSession(ctx.chat.id);
  ctx.reply(
    '👋 Привет! Я помогу собрать файл *Сроки годности* из 4 магазинов.\n\n' +
    'Нажмите *«Начать»*, загрузите по одному файлу для каждого магазина — ' +
    'и я автоматически сформирую итоговый файл.',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('🚀 Начать', 'start_upload')]]),
    }
  );
});

bot.command('status', ctx => {
  const { files } = getSession(ctx.chat.id);
  const loaded = Object.keys(files).length;
  ctx.reply(
    `📊 *Статус загрузки:* ${loaded}/4\n\n${uploadedList(files)}`,
    { parse_mode: 'Markdown', ...storeKeyboard(files) }
  );
});

bot.command('reset', ctx => {
  resetSession(ctx.chat.id);
  ctx.reply('🔄 Сессия сброшена. Нажмите /start чтобы начать заново.');
});

// ─── Callback-кнопки ──────────────────────────────────────────────────────────

bot.action('start_upload', async ctx => {
  await ctx.answerCbQuery();
  const { files } = getSession(ctx.chat.id);
  await ctx.editMessageText(
    '📁 Загрузите файлы магазинов.\nНажмите на магазин, затем отправьте его Excel-файл:\n\n' +
    uploadedList(files),
    { parse_mode: 'Markdown', ...storeKeyboard(files) }
  );
});

bot.action('restart', async ctx => {
  await ctx.answerCbQuery();
  resetSession(ctx.chat.id);
  const { files } = getSession(ctx.chat.id);
  await ctx.editMessageText(
    '🔄 Начинаем заново.\nВыберите магазин и загрузите файл:\n\n' + uploadedList(files),
    { parse_mode: 'Markdown', ...storeKeyboard(files) }
  );
});

// Пользователь нажал кнопку магазина → запоминаем ожидание
bot.action(/^store:(.+)$/, async ctx => {
  await ctx.answerCbQuery();
  const storeKey = ctx.match[1];
  const store    = STORES.find(s => s.key === storeKey);
  if (!store) return;

  const session  = getSession(ctx.chat.id);
  session.pending = storeKey;

  await ctx.reply(
    `📤 Отправьте файл для *${store.label}*\n\n` +
    `_Ожидается .xlsx файл со страницей «Список сроков»_`,
    { parse_mode: 'Markdown' }
  );
});

// ─── Обработка входящего документа ────────────────────────────────────────────

bot.on('document', async ctx => {
  const session = getSession(ctx.chat.id);
  const doc     = ctx.message.document;

  // Проверяем тип файла
  if (!doc.file_name.endsWith('.xlsx')) {
    return ctx.reply('⚠️ Пожалуйста, отправьте файл в формате .xlsx');
  }

  // Определяем для какого магазина файл
  let storeKey = session.pending;

  // Если pending не задан — пробуем угадать по имени файла
  if (!storeKey) {
    const name = doc.file_name.toUpperCase();
    const found = STORES.find(s => name.includes(s.key));
    if (found) {
      storeKey = found.key;
    } else {
      return ctx.reply(
        '❓ Не знаю для какого магазина этот файл.\n' +
        'Нажмите кнопку магазина, потом отправьте файл:',
        storeKeyboard(session.files)
      );
    }
  }

  const store = STORES.find(s => s.key === storeKey);
  session.pending = null;

  // Скачиваем файл
  const loadingMsg = await ctx.reply(`⏳ Загружаю файл для *${store.label}*...`, { parse_mode: 'Markdown' });

  try {
    const buffer = await downloadFile(doc.file_id);
    session.files[storeKey] = buffer;

    const loaded = Object.keys(session.files).length;

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      loadingMsg.message_id,
      null,
      `✅ Файл *${store.label}* загружен! (${loaded}/4)\n\n${uploadedList(session.files)}`,
      { parse_mode: 'Markdown' }
    );

    // Если все 4 файла загружены — запускаем обработку
    if (loaded === 4) {
      await buildAndSend(ctx, session);
    } else {
      // Предлагаем загрузить следующий
      await ctx.reply(
        `📁 Осталось загрузить: ${4 - loaded} файла.\nВыберите следующий магазин:`,
        storeKeyboard(session.files)
      );
    }
  } catch (err) {
    console.error('Ошибка при обработке файла:', err);
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      loadingMsg.message_id,
      null,
      `❌ Ошибка при обработке файла: ${err.message}`
    );
  }
});

// ─── Генерация и отправка итогового файла ─────────────────────────────────────

async function buildAndSend(ctx, session) {
  const processingMsg = await ctx.reply('⚙️ Все файлы получены! Формирую итоговый файл...');

  try {
    const data   = processFiles(session.files);
    const buffer = generateExcel(data);

    const now      = new Date();
    const dateStr  = now.toLocaleDateString('ru-RU').replace(/\./g, '-');
    const filename = `Сроки_годности_${dateStr}.xlsx`;

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      processingMsg.message_id,
      null,
      `✅ Готово! Строк в файле: *${data.length}*\nОтправляю...`,
      { parse_mode: 'Markdown' }
    );

    await ctx.replyWithDocument(
      { source: buffer, filename },
      {
        caption:
          `📊 *Сроки годности* — ${dateStr}\n\n` +
          `Итого позиций: *${data.length}*\n` +
          Object.entries(session.files)
            .map(([k]) => `${STORES.find(s => s.key === k).label} ✅`)
            .join('\n'),
        parse_mode: 'Markdown',
      }
    );

    // Сбрасываем сессию для новой итерации
    resetSession(ctx.chat.id);

    await ctx.reply(
      '🔄 Хотите сформировать новый файл?',
      Markup.inlineKeyboard([[Markup.button.callback('🚀 Начать снова', 'start_upload')]])
    );
  } catch (err) {
    console.error('Ошибка при генерации файла:', err);
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      processingMsg.message_id,
      null,
      `❌ Ошибка при создании файла: ${err.message}\n\nПопробуйте ещё раз или проверьте формат файлов.`
    );
  }
}

// ─── Запуск ───────────────────────────────────────────────────────────────────

bot.launch().then(() => {
  console.log('🤖 Бот запущен');
});

// Graceful shutdown для Railway
process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
