import 'dotenv/config';
import {
  Client, GatewayIntentBits, Events, REST, Routes, SlashCommandBuilder,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  PermissionFlagsBits, UserSelectMenuBuilder, StringSelectMenuBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle
} from 'discord.js';
import fs from 'node:fs';

const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const ADMIN_ROLE_ID = process.env.ADMIN_ROLE_ID || '';
const APPLICATION_CHANNEL_ID = process.env.APPLICATION_CHANNEL_ID || '';
const RECRUITER_ROLE_ID = process.env.RECRUITER_ROLE_ID || '';
// Роли, которым доступна кнопка «СОЗДАТЬ ВЕТКУ».
// Если не указаны, используются существующие ADMIN_ROLE_ID и RECRUITER_ROLE_ID.
const OTKAT_ROLE_1_ID = process.env.OTKAT_ROLE_1_ID || ADMIN_ROLE_ID;
const OTKAT_ROLE_2_ID = process.env.OTKAT_ROLE_2_ID || RECRUITER_ROLE_ID;
const OTKAT_ADMIN_ROLE_ID = process.env.OTKAT_ADMIN_ROLE_ID || ADMIN_ROLE_ID;
const OTKAT_CATEGORY_NAME = 'откаты';
const LOG_CHANNEL_NAME = 'logs';
const DATA_FILE = './data.json';
if (!TOKEN) throw new Error('DISCORD_TOKEN не указан в .env');
if (!GUILD_ID || !/^\d{17,20}$/.test(GUILD_ID)) throw new Error('GUILD_ID должен быть числовым Discord ID сервера.');

const defaultDb = { nextCaptId: 1, nextApplicationId: 1, activeCapt: null, activeCapts: [], activeMcls: [], nextMclId: 1, captHistory: [], mclHistory: [], logs: [], stats: {}, applications: {} };
let db = defaultDb;
function loadDb() {
  if (!fs.existsSync(DATA_FILE)) return saveDb();
  try { db = { ...defaultDb, ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) }; }
  catch (e) { console.error('Не удалось прочитать data.json:', e); db = { ...defaultDb }; saveDb(); }
  // Migration from the old single-CAPT format to multiple active CAPTs.
  if (!Array.isArray(db.activeCapts)) {
    db.activeCapts = db.activeCapt ? [db.activeCapt] : [];
  } else if (db.activeCapt) {
    const legacy = db.activeCapt;
    if (!db.activeCapts.some(c => c?.id === legacy?.id || c?.messageId === legacy?.messageId)) db.activeCapts.unshift(legacy);
  }
  db.activeCapt = null;
  if (!Array.isArray(db.activeMcls)) db.activeMcls = [];
  if (!Array.isArray(db.mclHistory)) db.mclHistory = [];
  if (!db.stats || typeof db.stats !== 'object') db.stats = {};
  if (!db.applications || typeof db.applications !== 'object') db.applications = {};
  if (!Number.isInteger(db.nextApplicationId) || db.nextApplicationId < 1) db.nextApplicationId = 1;
}
function saveDb() { fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), 'utf8'); }
loadDb();
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

function isRecruiterOrAdmin(member) {
  return isAdmin(member) || !!(RECRUITER_ROLE_ID && member?.roles?.cache?.has(RECRUITER_ROLE_ID));
}

function canCreateOtkat(member) {
  return !!member && (
    (OTKAT_ROLE_1_ID && member.roles.cache.has(OTKAT_ROLE_1_ID)) ||
    (OTKAT_ROLE_2_ID && member.roles.cache.has(OTKAT_ROLE_2_ID))
  );
}

function otkatChannelName(member) {
  const raw = member?.displayName || member?.user?.username || 'пользователь';
  const clean = String(raw)
    .toLowerCase()
    .replace(/[^a-zа-яё0-9_-]+/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 90);
  return clean || `пользователь-${member.id.slice(-6)}`;
}

function applicationPanelRows() {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('application_open').setLabel('ПОДАТЬ ЗАЯВКУ').setEmoji('📝').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('otkat_create').setLabel('СОЗДАТЬ ВЕТКУ').setEmoji('📁').setStyle(ButtonStyle.Success)
  );
  return [row];
}

async function ensureOtkatCategory(guild) {
  let category = guild.channels.cache.find(c => c.type === 4 && c.name.toLowerCase() === OTKAT_CATEGORY_NAME);
  if (!category) {
    category = await guild.channels.create({
      name: OTKAT_CATEGORY_NAME,
      type: 4
    });
  }
  return category;
}

async function createOtkatChannel(guild, member) {
  const category = await ensureOtkatCategory(guild);
  const existing = guild.channels.cache.find(c =>
    c.type === 0 &&
    c.parentId === category.id &&
    c.topic === `otkat:${member.id}`
  );
  if (existing) return { channel: existing, created: false };

  const overwrites = [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionFlagsBits.ViewChannel]
    },
    {
      id: member.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks
      ]
    },
    {
      id: client.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ManageMessages
      ]
    }
  ];

  if (OTKAT_ADMIN_ROLE_ID) {
    overwrites.push({
      id: OTKAT_ADMIN_ROLE_ID,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks
      ]
    });
  }

  const channel = await guild.channels.create({
    name: otkatChannelName(member),
    type: 0,
    parent: category.id,
    topic: `otkat:${member.id}`,
    permissionOverwrites: overwrites
  });

  await channel.send({
    content: `<@${member.id}>`,
    embeds: [
      new EmbedBuilder()
        .setTitle('📁 ОТКАТЫ')
        .setDescription('Этот канал предназначен для отправки откатов. Канал виден только тебе и администрации.')
        .setFooter({ text: `Пользователь: ${member.displayName || member.user.username}` })
    ]
  }).catch(() => {});

  return { channel, created: true };
}
function applicationPanelEmbed() {
  return new EmbedBuilder()
    .setTitle('🏠 ВСТУПЛЕНИЕ В СЕМЬЮ')
    .setDescription('Все просто, жми **ПОДАТЬ ЗАЯВКУ** и присоединяйся к нам.\n\nПосле отправки заявки, жди и мы с тобой обязательно свяжемся ну или перезвоним.')
    .setFooter({text:'Заявки в семью'});
}
function applicationButtons(record = null) {
  const review = record?.status === 'review';
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('application_take').setLabel(review ? 'В РАССМОТРЕНИИ' : 'ВЗЯТЬ В РАССМОТРЕНИЕ').setEmoji('👀').setStyle(ButtonStyle.Secondary).setDisabled(review),
    new ButtonBuilder().setCustomId('application_accept').setLabel('ПРИНЯТЬ').setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('application_reject').setLabel('ОТКЛОНИТЬ').setEmoji('❌').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('application_call').setLabel('ВЫЗВАТЬ НА ОБЗВОН').setEmoji('📞').setStyle(ButtonStyle.Primary)
  )];
}
async function setupApplicationPanel(guild) {
  if (!APPLICATION_CHANNEL_ID) return;
  const ch = await guild.channels.fetch(APPLICATION_CHANNEL_ID).catch(()=>null);
  if (!ch?.isTextBased()) { console.error('APPLICATION_CHANNEL_ID не найден или это не текстовый канал.'); return; }

  // При каждом запуске ищем существующую панель бота и обновляем её,
  // чтобы старый текст/кнопки автоматически заменялись и не создавались дубликаты.
  const messages = await ch.messages.fetch({limit:100}).catch(()=>null);
  const panels = messages
    ? [...messages.values()].filter(m =>
        m.author?.id === client.user.id &&
        m.components?.some(r => r.components?.some(c => c.customId === 'application_open' || c.customId === 'otkat_create'))
      )
    : [];

  const payload = {
    embeds: [applicationPanelEmbed().setThumbnail('attachment://application.png')],
    components: applicationPanelRows(),
    files: [{ attachment: './assets/application.png', name: 'application.png' }]
  };

  if (panels.length) {
    // Оставляем первую панель и обновляем её до актуальной версии.
    await panels[0].edit(payload).catch(e => console.error('Не удалось обновить панель заявок:', e));
    // Если по старым версиям накопились дубликаты — удаляем их.
    for (const duplicate of panels.slice(1)) {
      await duplicate.delete().catch(()=>{});
    }
    return;
  }

  await ch.send(payload).catch(e=>console.error('Не удалось создать панель заявок:',e));
}
function applicationChannelName(nick, userId) {
  const clean = String(nick || 'кандидат').toLowerCase().replace(/[^a-zа-я0-9_-]+/gi,'-').replace(/-+/g,'-').replace(/^-|-$/g,'').slice(0,45) || 'кандидат';
  return `заявка-${clean}-${userId.slice(-4)}`;
}
async function deleteApplicationResources(channel, voiceId=null) {
  if (voiceId) { const vc = await channel.guild.channels.fetch(voiceId).catch(()=>null); if (vc) await vc.delete().catch(()=>{}); }
  if (channel) await channel.delete().catch(()=>{});
}
async function createInterviewVoice(guild, appChannel, applicantId) {
  const overwrites = [
    {id:guild.roles.everyone.id, deny:[PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect]},
    {id:applicantId, allow:[PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak]},
  ];
  if (RECRUITER_ROLE_ID) overwrites.push({id:RECRUITER_ROLE_ID, allow:[PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak]});
  if (ADMIN_ROLE_ID) overwrites.push({id:ADMIN_ROLE_ID, allow:[PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak]});
  const voice = await guild.channels.create({
    name:`обзвон-${applicantId.slice(-4)}`,
    type:2,
    parent:appChannel.parentId || undefined,
    permissionOverwrites:overwrites
  });
  setTimeout(async()=>{
    const fresh=await guild.channels.fetch(voice.id).catch(()=>null);
    if (fresh && fresh.members?.size===0) await fresh.delete().catch(()=>{});
  }, 10*60*1000);
  return voice;
}

function isAdmin(member) { return !!member && (member.permissions.has(PermissionFlagsBits.Administrator) || member.permissions.has(PermissionFlagsBits.ManageGuild) || !!(ADMIN_ROLE_ID && member.roles.cache.has(ADMIN_ROLE_ID))); }
function nowIso() { return new Date().toISOString(); }
let logChannelId = null;
const applicationSubmitLocks = new Set();
const adminSelections = new Map();
function selectionKey(kind, eventId, userId) { return `${kind}:${eventId}:${userId}`; }

async function ensureLogChannel(guild) {
  const cached = guild.channels.cache.find(c => c.isTextBased?.() && c.name === LOG_CHANNEL_NAME);
  if (cached) {
    logChannelId = cached.id;
    await cached.permissionOverwrites.edit(client.user.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true }).catch(() => {});
    if (ADMIN_ROLE_ID) await cached.permissionOverwrites.edit(ADMIN_ROLE_ID, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true }).catch(() => {});
    return cached;
  }
  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }
  ];
  if (ADMIN_ROLE_ID) {
    overwrites.push({ id: ADMIN_ROLE_ID, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
  }
  const ch = await guild.channels.create({ name: LOG_CHANNEL_NAME, type: 0, permissionOverwrites: overwrites }).catch(e => {
    console.error('Не удалось создать канал logs:', e);
    return null;
  });
  if (ch) {
    logChannelId = ch.id;
    await ch.send({ embeds: [new EmbedBuilder().setTitle('📜 ЛОГИ БОТА').setDescription('Канал логов создан. Здесь будут фиксироваться действия с CAPT, MCL и заявками.').setTimestamp()] }).catch(() => {});
  }
  return ch;
}

function addLog(action, actor, target = null, mclId = null) {
  const captId = target?.captId ?? (action.startsWith('CAPT_') ? target?.id : null);
  const resolvedMclId = mclId ?? target?.mclId ?? (action.startsWith('MCL_') ? target?.id : null);
  const entry = { mclId: resolvedMclId, captId, action, actorId: actor?.id ?? null, actorName: actor?.displayName || actor?.user?.username || actor?.username || 'Unknown', targetId: target?.id ?? null, targetName: target?.name ?? null, timestamp: nowIso() };
  db.logs.push(entry);
  if (db.logs.length > 10000) db.logs = db.logs.slice(-10000);
  saveDb();
  sendDiscordLog(entry).catch(() => {});
}

async function sendDiscordLog(entry) {
  if (!client.isReady() || !GUILD_ID) return;
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) return;
  const ch = (logChannelId && await guild.channels.fetch(logChannelId).catch(() => null)) || await ensureLogChannel(guild);
  if (!ch?.isTextBased?.()) return;
  const target = entry.targetId ? `<@${entry.targetId}>` : '—';
  const embed = new EmbedBuilder()
    .setTitle('📌 Действие бота')
    .addFields(
      { name: 'Действие', value: `\`${entry.action}\``, inline: true },
      { name: 'Кто', value: entry.actorId ? `<@${entry.actorId}>` : entry.actorName || 'Unknown', inline: true },
      { name: 'Объект', value: target, inline: true }
    )
    .setTimestamp(new Date(entry.timestamp));
  if (entry.targetName) embed.addFields({ name: 'Ник/название', value: String(entry.targetName).slice(0, 1024), inline: false });
  await ch.send({ embeds: [embed] });
}
function bumpStat(id, name, key, amount = 1) {
  if (!id) return;
  if (!db.stats[id]) db.stats[id] = { name: name || 'Игрок', joined: 0, main: 0, reserve: 0, promoted: 0, declined: 0, removed: 0 };
  if (name) db.stats[id].name = name;
  db.stats[id][key] = (db.stats[id][key] || 0) + amount;
}
function parseTime(value) { return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : null; }
function mclClosed(m) { return !!m.closed; }
function mclStatus(m) { return m.closed ? '🔒 Набор закрыт' : '🟢 Набор открыт'; }
function mclEmbed(m) {
  const players = m.participants || [], reserves = m.reserves || [];
  const list = players.length ? players.map((p,i)=>`**${i+1}.** <@${p.id}>`).join('\n') : 'Пока никто не записался.';
  const reserveList = reserves.length ? reserves.map((p,i)=>`**${i+1}.** <@${p.id}>`).join('\n') : 'Замена пока пустая.';
  let d = `🕐 **Начало:** ${m.time}\n${mclStatus(m)}\n👥 **Основной состав:** ${players.length}/${m.slots}\n🔄 **Замена:** ${reserves.length}\n` + (m.reminderMinutes ? `🔔 **Напоминание:** за ${m.reminderMinutes} мин.\n` : '') + `\n**ОСНОВНОЙ СОСТАВ:**\n${list}\n\n**🔄 ЗАМЕНА:**\n${reserveList}`;
  if (d.length > 4096) d = d.slice(0, 4070) + '\n… список продолжается.';
  return new EmbedBuilder().setTitle(`🎮 MCL #${m.id}`).setDescription(d).setFooter({ text: `Создал: ${m.createdBy}` });
}
function mclRows(m) {
  const main = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('mcl_plus').setLabel('Я ИДУ').setEmoji('➕').setStyle(ButtonStyle.Success).setDisabled(m.closed),
    new ButtonBuilder().setCustomId('mcl_minus').setLabel('НЕ ИДУ').setEmoji('➖').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('mcl_list').setLabel('СОСТАВ').setEmoji('📋').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('mcl_stats').setLabel('СТАТИСТИКА').setEmoji('📊').setStyle(ButtonStyle.Secondary)
  );
  const admin = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('mcl_manage').setLabel('УПРАВЛЕНИЕ').setEmoji('⚙️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('mcl_all').setLabel('ВСЕ MCL').setEmoji('📚').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('mcl_logs').setLabel('ЛОГИ').setEmoji('📜').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('mcl_finish').setLabel('ЗАВЕРШИТЬ MCL').setEmoji('🏁').setStyle(ButtonStyle.Secondary)
  );
  return [main, admin];
}
async function safeEditMclMessage(interaction, m) {
  if (!m?.messageId) return;
  const ch = await client.channels.fetch(m.channelId).catch(()=>null);
  const message = ch?.isTextBased() ? await ch.messages.fetch(m.messageId).catch(()=>null) : null;
  if (message) await message.edit({ embeds:[mclEmbed(m)], components:mclRows(m) }).catch(()=>{});
}
function mclManageRows(m) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('mcl_toggle').setLabel(m.closed ? 'ОТКРЫТЬ НАБОР' : 'ЗАКРЫТЬ НАБОР').setEmoji(m.closed ? '🔓' : '🔒').setStyle(m.closed ? ButtonStyle.Success : ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('mcl_reminder').setLabel(m.reminderMinutes ? `НАПОМИНАНИЕ: ${m.reminderMinutes} МИН` : 'НАПОМИНАНИЕ: ВЫКЛ').setEmoji('🔔').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('mcl_finish').setLabel('ЗАВЕРШИТЬ MCL').setEmoji('🏁').setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('mcl_manage_player').setLabel('УПРАВЛЕНИЕ ИГРОКАМИ').setEmoji('👤').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('mcl_all').setLabel('ВСЕ АКТИВНЫЕ MCL').setEmoji('📚').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('mcl_stats').setLabel('СТАТИСТИКА').setEmoji('📊').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('mcl_delete').setLabel('УДАЛИТЬ').setEmoji('🗑️').setStyle(ButtonStyle.Danger)
    ),
    new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('mcl_back').setLabel('НАЗАД').setEmoji('↩️').setStyle(ButtonStyle.Secondary))
  ];
}
function playerManageRows(m) {
  const menu = new UserSelectMenuBuilder().setCustomId('mcl_select_player').setPlaceholder('Выбери игрока для управления').setMinValues(1).setMaxValues(1);
  return [new ActionRowBuilder().addComponents(menu), new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('mcl_p_main').setLabel('В ОСНОВНОЙ').setEmoji('⬆️').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('mcl_p_reserve').setLabel('В ЗАМЕНУ').setEmoji('🔄').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('mcl_p_remove').setLabel('УДАЛИТЬ').setEmoji('🗑️').setStyle(ButtonStyle.Danger)
  ), new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('mcl_manage').setLabel('НАЗАД').setEmoji('↩️').setStyle(ButtonStyle.Secondary))];
}
function findSelectedId(interaction) { return interaction.message?.interaction?.user?.id ? null : null; }
function activeMclsEmbed() {
  const ms = db.activeMcls || [];
  const text = ms.length ? ms.map(m=>`**#${m.id}** — 🕐 ${m.time} — ${mclStatus(m)} — 👥 ${m.participants.length}/${m.slots} — 🔄 ${m.reserves.length}`).join('\n') : 'Активных MCL нет.';
  return new EmbedBuilder().setTitle('📚 АКТИВНЫЕ MCL').setDescription(text.slice(0,4096));
}
function statsEmbed() {
  const arr = Object.entries(db.stats || {}).map(([id,s])=>({id,...s})).sort((a,b)=>(b.main+b.reserve+b.promoted)-(a.main+a.reserve+a.promoted)).slice(0,20);
  const text = arr.length ? arr.map((s,i)=>`**${i+1}.** <@${s.id}> — участий: **${s.joined}**, основной: **${s.main}**, замена: **${s.reserve}**, переведён: **${s.promoted}**, отказов: **${s.declined}`).join('\n') : 'Статистика пока пустая.';
  return new EmbedBuilder().setTitle('📊 СТАТИСТИКА ИГРОКОВ').setDescription(text.slice(0,4096));
}
function allMclButtonRows() { return [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('mcl_all_close').setLabel('ЗАКРЫТЬ').setStyle(ButtonStyle.Secondary))]; }


function captStatus(c) { return c.closed ? '🔒 Набор закрыт' : '🟢 Набор открыт'; }
function captEmbed(c) {
  const players=c.participants||[], reserves=c.reserves||[];
  const list=players.length?players.map((p,i)=>`**${i+1}.** <@${p.id}>`).join('\n'):'Пока никто не записался.';
  const reserveList=reserves.length?reserves.map((p,i)=>`**${i+1}.** <@${p.id}>`).join('\n'):'Замена пока пустая.';
  let d=`🕐 **Начало:** ${c.time}\n${captStatus(c)}\n👥 **Основной состав:** ${players.length}/${c.slots}\n🔄 **Замена:** ${reserves.length}\n`+(c.reminderMinutes?`🔔 **Напоминание:** за ${c.reminderMinutes} мин.\n`:'')+`\n**ОСНОВНОЙ СОСТАВ:**\n${list}\n\n**🔄 ЗАМЕНА:**\n${reserveList}`;
  if(d.length>4096)d=d.slice(0,4070)+'\n… список продолжается.';
  return new EmbedBuilder().setTitle('🏆 CAPT').setDescription(d).setFooter({text:`Создал: ${c.createdBy}`});
}
function captRows(c) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('capt_plus').setLabel('Я ИДУ').setEmoji('➕').setStyle(ButtonStyle.Success).setDisabled(c.closed),
      new ButtonBuilder().setCustomId('capt_minus').setLabel('НЕ ИДУ').setEmoji('➖').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('capt_list').setLabel('СОСТАВ').setEmoji('📋').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('capt_stats').setLabel('СТАТИСТИКА').setEmoji('📊').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('capt_delete').setLabel('УДАЛИТЬ').setEmoji('🗑️').setStyle(ButtonStyle.Danger)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('capt_manage').setLabel('УПРАВЛЕНИЕ').setEmoji('⚙️').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('capt_logs').setLabel('ЛОГИ').setEmoji('📜').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('capt_finish').setLabel('ЗАВЕРШИТЬ CAPT').setEmoji('🏁').setStyle(ButtonStyle.Secondary)
    )
  ];
}
async function safeEditCaptMessage(c) {
  if(!c?.messageId)return;
  const ch=await client.channels.fetch(c.channelId).catch(()=>null);
  const message=ch?.isTextBased()?await ch.messages.fetch(c.messageId).catch(()=>null):null;
  if(message)await message.edit({embeds:[captEmbed(c)],components:captRows(c)}).catch(()=>{});
}
function captManageRows(c) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('capt_toggle').setLabel(c.closed?'ОТКРЫТЬ НАБОР':'ЗАКРЫТЬ НАБОР').setEmoji(c.closed?'🔓':'🔒').setStyle(c.closed?ButtonStyle.Success:ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('capt_reminder').setLabel(c.reminderMinutes?`НАПОМИНАНИЕ: ${c.reminderMinutes} МИН`:'НАПОМИНАНИЕ: ВЫКЛ').setEmoji('🔔').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('capt_finish').setLabel('ЗАВЕРШИТЬ CAPT').setEmoji('🏁').setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('capt_manage_player').setLabel('УПРАВЛЕНИЕ ИГРОКАМИ').setEmoji('👤').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('capt_stats').setLabel('СТАТИСТИКА').setEmoji('📊').setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('capt_back').setLabel('НАЗАД').setEmoji('↩️').setStyle(ButtonStyle.Secondary))
  ];
}
function captPlayerManageRows(c) {
  return [new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId('capt_select_player').setPlaceholder('Выбери игрока для управления').setMinValues(1).setMaxValues(1)),new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('capt_p_main').setLabel('В ОСНОВНОЙ').setEmoji('⬆️').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('capt_p_reserve').setLabel('В ЗАМЕНУ').setEmoji('🔄').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('capt_p_remove').setLabel('УДАЛИТЬ').setEmoji('🗑️').setStyle(ButtonStyle.Danger)
  ),new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('capt_manage').setLabel('НАЗАД').setEmoji('↩️').setStyle(ButtonStyle.Secondary))];
}
async function sendCaptReminder(c) {
  if(!c?.reminderMinutes||c.reminderSent)return;
  const [h,min]=c.time.split(':').map(Number), now=new Date(), target=new Date(now); target.setHours(h,min,0,0);
  const diff=target-now;
  if(diff<=c.reminderMinutes*60000&&diff>-60000){c.reminderSent=true;saveDb();const ch=await client.channels.fetch(c.channelId).catch(()=>null);if(ch?.isTextBased())await ch.send(`🔔 **CAPT через ~${c.reminderMinutes} мин.**\n${c.participants.map(p=>`<@${p.id}>`).join(' ')||'Основной состав пуст.'}`).catch(()=>{});await safeEditCaptMessage(c);}
}

function countPlayerEntries(userId) {
  const capts = [...(db.activeCapts || []), ...(db.captHistory || [])];
  const mcls = [...(db.activeMcls || []), ...(db.mclHistory || [])];
  const all = [...capts, ...mcls];
  let main = 0, reserve = 0, total = 0;
  for (const event of all) {
    const p = (event.participants || []).some(x => x.id === userId);
    const r = (event.reserves || []).some(x => x.id === userId);
    if (p) { main++; total++; }
    else if (r) { reserve++; total++; }
  }
  return { main, reserve, total, events: all.length };
}
function profileEmbed(user, member) {
  const s = db.stats?.[user.id] || {};
  const c = countPlayerEntries(user.id);
  const name = member?.displayName || user.globalName || user.username;
  return new EmbedBuilder()
    .setTitle(`👤 ПРОФИЛЬ — ${name}`)
    .setThumbnail(user.displayAvatarURL({ size: 256 }))
    .addFields(
      { name: 'Discord', value: `<@${user.id}>`, inline: true },
      { name: 'Участий', value: String(s.joined || c.total || 0), inline: true },
      { name: 'Основной состав', value: String(s.main || c.main || 0), inline: true },
      { name: 'Замена', value: String(s.reserve || c.reserve || 0), inline: true },
      { name: 'Переведён в основной', value: String(s.promoted || 0), inline: true },
      { name: 'Выходов', value: String(s.declined || 0), inline: true },
      { name: 'Всего событий', value: String(c.events), inline: true }
    )
    .setFooter({ text: `ID: ${user.id}` })
    .setTimestamp();
}

async function registerCommands() {
  const rest = new REST({version:'10'}).setToken(TOKEN);
  const commands = [
    new SlashCommandBuilder().setName('capt').setDescription('Создать капт').addStringOption(o=>o.setName('время').setDescription('HH:MM').setRequired(true)).addIntegerOption(o=>o.setName('количество').setDescription('Количество слотов').setMinValue(1).setMaxValue(100).setRequired(true)),
    new SlashCommandBuilder().setName('mcl').setDescription('Создать MCL').addStringOption(o=>o.setName('время').setDescription('HH:MM').setRequired(true)).addIntegerOption(o=>o.setName('количество').setDescription('Основной состав').setMinValue(1).setMaxValue(100).setRequired(true)),
    new SlashCommandBuilder().setName('profile').setDescription('Показать профиль игрока').addUserOption(o=>o.setName('игрок').setDescription('Игрок').setRequired(false))
  ].map(x=>x.toJSON());
  await rest.put(Routes.applicationGuildCommands(client.user.id,GUILD_ID),{body:commands});
}

client.once(Events.ClientReady, async()=>{ console.log(`✅ Бот запущен: ${client.user.tag}`); try { await registerCommands(); } catch(e){console.error(e);} try { const guild=await client.guilds.fetch(GUILD_ID); await ensureLogChannel(guild); await setupApplicationPanel(guild); } catch(e){console.error('Ошибка инициализации сервера:',e);} });

async function sendReminder(m) {
  if (!m.reminderMinutes || m.reminderSent) return;
  const [h,min] = m.time.split(':').map(Number);
  const now = new Date();
  const target = new Date(now); target.setHours(h,min,0,0);
  const diff = target.getTime()-now.getTime();
  if (diff <= m.reminderMinutes*60000 && diff > -60000) {
    m.reminderSent = true; saveDb();
    const ch = await client.channels.fetch(m.channelId).catch(()=>null);
    if (ch?.isTextBased()) await ch.send(`🔔 **MCL #${m.id} через ~${m.reminderMinutes} мин.**\n${m.participants.map(p=>`<@${p.id}>`).join(' ') || 'Основной состав пуст.'}`).catch(()=>{});
    await safeEditMclMessage({channel:ch},m);
  }
}
setInterval(()=>Promise.all((db.activeMcls||[]).map(sendReminder)).catch(()=>{}),30000);
setInterval(()=>Promise.all((db.activeCapts||[]).map(sendCaptReminder)).catch(()=>{}),30000);

client.on(Events.InteractionCreate, async interaction=>{
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName==='capt') {
        if (!isAdmin(interaction.member)) return interaction.reply({content:'❌ Создавать CAPT может только администратор.',flags:64});
        const time=parseTime(interaction.options.getString('время')), slots=interaction.options.getInteger('количество');
        if(!time)return interaction.reply({content:'❌ Время должно быть HH:MM.',flags:64});
        const c={id:db.nextCaptId++,guildId:interaction.guildId,channelId:interaction.channelId,messageId:null,time,slots,createdBy:interaction.user.id,createdAt:nowIso(),participants:[],reserves:[],closed:false,reminderMinutes:0,reminderSent:false};
        db.activeCapts.push(c);saveDb();
        try {
          const msg=await interaction.channel.send({embeds:[captEmbed(c)],components:captRows(c)});
          c.messageId=msg.id; saveDb();
        } catch (e) {
          db.activeCapts=db.activeCapts.filter(x=>x.id!==c.id); saveDb(); throw e;
        }
        addLog('CAPT_CREATE',interaction.member,c);
        return interaction.reply({content:`✅ CAPT #${c.id} создан. Сейчас активно CAPT: **${db.activeCapts.length}**.`,flags:64});
      }
      if (interaction.commandName==='mcl') {
        if (!isAdmin(interaction.member)) return interaction.reply({content:'❌ Создавать MCL может только администратор.',flags:64});
        const time=parseTime(interaction.options.getString('время')), slots=interaction.options.getInteger('количество');
        if (!time) return interaction.reply({content:'❌ Время должно быть HH:MM.',flags:64});
        const m={id:db.nextMclId++,guildId:interaction.guildId,channelId:interaction.channelId,messageId:null,time,slots,createdBy:interaction.user.id,createdAt:nowIso(),participants:[],reserves:[],closed:false,reminderMinutes:0,reminderSent:false};
        db.activeMcls.push(m); saveDb();
        try {
          const msg=await interaction.channel.send({embeds:[mclEmbed(m)],components:mclRows(m)});
          m.messageId=msg.id; saveDb();
        } catch (e) {
          db.activeMcls=db.activeMcls.filter(x=>x.id!==m.id); saveDb(); throw e;
        }
        addLog('MCL_CREATE',interaction.member,null,m.id);
        return interaction.reply({content:`✅ MCL #${m.id} создан. Сейчас активно MCL: **${db.activeMcls.length}**.`,flags:64});
      }
      if (interaction.commandName==='profile') {
        const user = interaction.options.getUser('игрок') || interaction.user;
        const member = await interaction.guild.members.fetch(user.id).catch(()=>null);
        return interaction.reply({embeds:[profileEmbed(user, member)],flags:64});
      }
    }
    if (interaction.isButton() && interaction.customId === 'otkat_create') {
      if (!canCreateOtkat(interaction.member)) {
        return interaction.reply({
          content: '❌ Кнопка «СОЗДАТЬ ВЕТКУ» доступна только участникам с одной из настроенных ролей.',
          flags: 64
        });
      }

      await interaction.deferReply({ flags: 64 });
      try {
        const result = await createOtkatChannel(interaction.guild, interaction.member);
        addLog(result.created ? 'OTKAT_CREATE' : 'OTKAT_EXISTS', interaction.member, {
          id: interaction.user.id,
          name: interaction.member.displayName || interaction.user.username
        });
        return interaction.editReply({
          content: result.created
            ? `✅ Ветка создана: <#${result.channel.id}>`
            : `ℹ️ У тебя уже есть ветка: <#${result.channel.id}>`
        });
      } catch (e) {
        console.error('Ошибка создания ветки откатов:', e);
        return interaction.editReply({
          content: '❌ Не удалось создать ветку. Проверь, что у бота есть права **Управление каналами** и он стоит выше нужной роли.'
        });
      }
    }
    if (interaction.isButton() && interaction.customId === 'application_open') {
      const pending = db.applications[interaction.user.id];
      if (pending?.status === 'pending' || pending?.status === 'review') {
        const ch = await interaction.guild.channels.fetch(pending.channelId).catch(()=>null);
        if (ch) return interaction.reply({content:`⚠️ У тебя уже есть заявка на рассмотрении: <#${ch.id}>`,flags:64});
        delete db.applications[interaction.user.id]; saveDb();
      }
      const modal = new ModalBuilder().setCustomId('application_modal').setTitle('Заявка в семью');
      const nick = new TextInputBuilder().setCustomId('app_nick').setLabel('Твой ник').setPlaceholder('Kageshisa').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100);
      const past = new TextInputBuilder().setCustomId('app_past').setLabel('Где играл раньше?').setPlaceholder('Overtake, Lacosta, Fear').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000);
      const proofs = new TextInputBuilder().setCustomId('app_proofs').setLabel('Откаты (Арена + капты если есть)').setPlaceholder('Ссылки на YouTube').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1500);
      const age = new TextInputBuilder().setCustomId('app_age').setLabel('Возраст').setPlaceholder('8 лет').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(3);
      modal.addComponents(
        new ActionRowBuilder().addComponents(nick),
        new ActionRowBuilder().addComponents(past),
        new ActionRowBuilder().addComponents(proofs),
        new ActionRowBuilder().addComponents(age)
      );
      return interaction.showModal(modal);
    }
    if (interaction.isModalSubmit() && interaction.customId === 'application_modal') {
      await interaction.deferReply({flags:64});
      const guild=interaction.guild;
      if (!APPLICATION_CHANNEL_ID || !RECRUITER_ROLE_ID) return interaction.editReply({content:'❌ В .env не указаны APPLICATION_CHANNEL_ID и RECRUITER_ROLE_ID.'});
      const userId = interaction.user.id;
      if (applicationSubmitLocks.has(userId)) return interaction.editReply({content:'⏳ Заявка уже обрабатывается. Подожди немного.'});
      applicationSubmitLocks.add(userId);
      try {
        const existingRecord = db.applications[userId];
        if (existingRecord?.status === 'pending' || existingRecord?.status === 'review') {
          const existingChannel = await guild.channels.fetch(existingRecord.channelId).catch(()=>null);
          if (existingChannel) return interaction.editReply({content:`⚠️ У тебя уже есть заявка на рассмотрении: <#${existingChannel.id}>`});
          delete db.applications[userId];
          saveDb();
        }
        const channels = await guild.channels.fetch();
        const existing = channels.find(c => c.topic === `family-application:${userId}`);
        if (existing) {
          db.applications[userId] = { ...existingRecord, number: existingRecord.number || db.nextApplicationId++, status: existingRecord.status || 'pending', channelId:existing.id, updatedAt:nowIso() };
          saveDb();
          return interaction.editReply({content:`⚠️ У тебя уже есть заявка на рассмотрении: <#${existing.id}>`});
        }
        const nick=interaction.fields.getTextInputValue('app_nick').trim();
        const past=interaction.fields.getTextInputValue('app_past').trim();
        const proofs=interaction.fields.getTextInputValue('app_proofs').trim();
        const age=interaction.fields.getTextInputValue('app_age').trim();
        if (!nick || !past || !proofs || !age) return interaction.editReply({content:'❌ Заполни все поля заявки.'});
        const overwrites=[
          {id:guild.roles.everyone.id,deny:[PermissionFlagsBits.ViewChannel]},
          {id:userId,allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.ReadMessageHistory]},
          {id:RECRUITER_ROLE_ID,allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.ReadMessageHistory]},
        ];
        if (ADMIN_ROLE_ID) overwrites.push({id:ADMIN_ROLE_ID,allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.ReadMessageHistory]});
        const app=await guild.channels.create({name:applicationChannelName(nick,userId),type:0,topic:`family-application:${userId}`,permissionOverwrites:overwrites});
        db.applications[userId] = { number: db.nextApplicationId++, status:'pending', channelId:app.id, nick, createdAt:nowIso(), updatedAt:nowIso() };
        saveDb();
        const embed=new EmbedBuilder().setTitle(`📋 ЗАЯВКА В СЕМЬЮ #${db.applications[userId].number}`).setDescription(`**Кандидат:** <@${userId}>\n**Ник:** ${nick}\n**Возраст:** ${age}\n\n**Где играл раньше?**\n${past}\n\n**Откаты (Арена + капты):**\n${proofs}`).setThumbnail('attachment://application.png').setFooter({text:`Заявка #${db.applications[userId].number} • ID кандидата: ${userId}`});
        try {
          await app.send({content:`<@${userId}> <@&${RECRUITER_ROLE_ID}>`,embeds:[embed],components:applicationButtons(db.applications[userId]),files:[{attachment:'./assets/application.png',name:'application.png'}]});
        } catch (e) {
          delete db.applications[userId]; saveDb(); await app.delete().catch(()=>{}); throw e;
        }
        addLog('APPLICATION_CREATE',interaction.member,{id:userId,name:nick});
        return interaction.editReply({content:`✅ Заявка отправлена! Твой канал: <#${app.id}>`});
      } catch (e) {
        console.error('Ошибка создания заявки:', e);
        return interaction.editReply({content:'❌ Не удалось создать заявку. Проверь права бота и попробуй ещё раз.'}).catch(()=>{});
      } finally {
        applicationSubmitLocks.delete(userId);
      }
    }
    if (interaction.isButton() && ['application_take','application_accept','application_reject','application_call'].includes(interaction.customId)) {
      if (!isRecruiterOrAdmin(interaction.member)) return interaction.reply({content:'❌ Только рекрутеры и администраторы могут работать с заявками.',flags:64});
      const channel=interaction.channel;
      const match=channel?.topic?.match(/^family-application:(\d+)$/);
      if (!match) return interaction.reply({content:'❌ Это не канал заявки.',flags:64});
      const applicantId=match[1];
      if (interaction.customId==='application_take') {
        await interaction.deferReply({flags:64});
        const record=db.applications[applicantId];
        if (!record || !['pending','review'].includes(record.status)) return interaction.editReply({content:'⚠️ Эта заявка уже обработана или не найдена.'});
        if (record.status === 'review') return interaction.editReply({content:`👀 Заявку уже взял в рассмотрение <@${record.handledBy}>.`});
        record.status='review';
        record.handledBy=interaction.user.id;
        record.updatedAt=nowIso();
        saveDb();
        addLog('APPLICATION_TAKE',interaction.member,{id:applicantId,name:record.nick || null});
        const msg=interaction.message;
        const embed=msg.embeds?.[0] ? EmbedBuilder.from(msg.embeds[0]).setFooter({text:`Заявка #${record.number || '?'} • Взял: ${interaction.member?.displayName || interaction.user.username}`}) : null;
        if (embed) await msg.edit({embeds:[embed],components:applicationButtons(record)}).catch(()=>{});
        return interaction.editReply({content:'👀 Заявка взята в рассмотрение.'});
      }
      if (interaction.customId==='application_call') {
        await interaction.deferReply({flags:64});
        const record=db.applications[applicantId];
        const existingVoice=(record?.voiceChannelId && await interaction.guild.channels.fetch(record.voiceChannelId).catch(()=>null)) || interaction.guild.channels.cache.find(c=>c.type===2 && c.name===`обзвон-${applicantId.slice(-4)}`);
        if (existingVoice) return interaction.editReply({content:`📞 Обзвон уже создан: <#${existingVoice.id}>`});
        const voice=await createInterviewVoice(interaction.guild,channel,applicantId);
        if (record) { record.voiceChannelId=voice.id; record.updatedAt=nowIso(); saveDb(); }
        addLog('APPLICATION_CALL',interaction.member,{id:applicantId});
        return interaction.editReply({content:`📞 Создан приватный голосовой канал: <#${voice.id}>`});
      }
      await interaction.deferReply({flags:64});
      const record=db.applications[applicantId];
      const voice=(record?.voiceChannelId && await interaction.guild.channels.fetch(record.voiceChannelId).catch(()=>null)) || interaction.guild.channels.cache.find(c=>c.type===2 && c.name===`обзвон-${applicantId.slice(-4)}`);
      const accepted=interaction.customId==='application_accept';
      if (record?.status && !['pending','review'].includes(record.status)) return interaction.editReply({content:'⚠️ Эта заявка уже обработана.'});
      if (record) { record.status=accepted?'accepted':'rejected'; record.updatedAt=nowIso(); record.handledBy=interaction.user.id; saveDb(); }
      addLog(accepted?'APPLICATION_ACCEPT':'APPLICATION_REJECT',interaction.member,{id:applicantId,name:record?.nick || null});
      const user=await interaction.client.users.fetch(applicantId).catch(()=>null);
      if(user) await user.send(accepted?'✅ Твоя заявка в семью принята!':'❌ Твоя заявка в семью отклонена.').catch(()=>{});
      if (voice) await voice.delete().catch(()=>{});
      await channel.delete().catch(()=>{});
      return;
    }
    if (!interaction.isButton() && !interaction.isUserSelectMenu()) return;
    if (interaction.customId.startsWith('capt_')) {
      const c=(db.activeCapts||[]).find(x=>x.messageId===interaction.message.id);
      if(!c)return interaction.reply({content:'❌ Этот CAPT больше не активен.',flags:64});
      await interaction.deferReply({flags:64});
      const adminOnly=['capt_manage','capt_toggle','capt_reminder','capt_finish','capt_manage_player','capt_select_player','capt_p_main','capt_p_reserve','capt_p_remove','capt_logs','capt_delete'];
      if(adminOnly.includes(interaction.customId)&&!isAdmin(interaction.member))return interaction.editReply({content:'❌ Эта кнопка доступна только администраторам.'});
      if(interaction.customId==='capt_plus'){
        if(c.closed)return interaction.editReply({content:'🔒 Набор уже закрыт.'});
        if(c.participants.some(p=>p.id===interaction.user.id)||c.reserves.some(p=>p.id===interaction.user.id))return interaction.editReply({content:'⚠️ Ты уже записан на этот CAPT.'});
        const p={id:interaction.user.id,name:interaction.member?.displayName||interaction.user.username,joinedAt:nowIso()};bumpStat(p.id,p.name,'joined');
        if(c.participants.length<c.slots){c.participants.push(p);bumpStat(p.id,p.name,'main');addLog('CAPT_PLUS',interaction.member,c);saveDb();await safeEditCaptMessage(c);return interaction.editReply({content:`✅ Ты в основном составе: ${c.participants.length}/${c.slots}.`});}
        c.reserves.push(p);bumpStat(p.id,p.name,'reserve');addLog('CAPT_PLUS_RESERVE',interaction.member,c);saveDb();await safeEditCaptMessage(c);return interaction.editReply({content:`🔄 Места заполнены. Ты **№${c.reserves.length}** в очереди замены.`});
      }
      if(interaction.customId==='capt_minus'){
        const idx=c.participants.findIndex(p=>p.id===interaction.user.id);
        if(idx!==-1){const [removed]=c.participants.splice(idx,1);bumpStat(removed.id,removed.name,'declined');const promoted=c.reserves.shift();if(promoted){c.participants.push(promoted);bumpStat(promoted.id,promoted.name,'promoted');}addLog('CAPT_MINUS',interaction.member,c);if(promoted)addLog('CAPT_PROMOTE',interaction.member,promoted,c.id);saveDb();await safeEditCaptMessage(c);return interaction.editReply({content:promoted?`✅ Ты вышел. 🔄 <@${promoted.id}> автоматически занял место.`:'✅ Ты вышел из основного состава.'});}
        const ri=c.reserves.findIndex(p=>p.id===interaction.user.id);if(ri!==-1){const [removed]=c.reserves.splice(ri,1);bumpStat(removed.id,removed.name,'declined');addLog('CAPT_MINUS_RESERVE',interaction.member,c);saveDb();await safeEditCaptMessage(c);return interaction.editReply({content:'✅ Ты вышел из очереди замены.'});}return interaction.editReply({content:'ℹ️ Ты не записан на этот CAPT.'});
      }
      if(interaction.customId==='capt_list')return interaction.editReply({embeds:[captEmbed(c)]});
      if(interaction.customId==='capt_stats')return interaction.editReply({embeds:[statsEmbed()]});
      if(interaction.customId==='capt_manage')return interaction.editReply({content:`⚙️ **УПРАВЛЕНИЕ CAPT**\n\nОсновной: ${c.participants.length}/${c.slots}\nЗамена: ${c.reserves.length}\nСтатус: ${captStatus(c)}`,components:captManageRows(c)});
      if(interaction.customId==='capt_back')return interaction.editReply({embeds:[captEmbed(c)],components:captRows(c)});
      if(interaction.customId==='capt_toggle'){c.closed=!c.closed;saveDb();addLog(c.closed?'CAPT_CLOSE':'CAPT_OPEN',interaction.member,c);await safeEditCaptMessage(c);return interaction.editReply({content:c.closed?'🔒 Набор закрыт.':'🔓 Набор открыт.',components:captManageRows(c)});}
      if(interaction.customId==='capt_reminder'){const opts=[0,60,30,15,5],i=opts.indexOf(c.reminderMinutes||0);c.reminderMinutes=opts[(i+1)%opts.length];c.reminderSent=false;saveDb();return interaction.editReply({content:c.reminderMinutes?`🔔 Напоминание установлено за **${c.reminderMinutes} мин.**`:'🔕 Напоминания выключены.',components:captManageRows(c)});}
      if(interaction.customId==='capt_finish'){for(const key of adminSelections.keys())if(key.startsWith(`capt:${c.id}:`))adminSelections.delete(key);db.activeCapts=db.activeCapts.filter(x=>x.id!==c.id);db.captHistory.push({...c,status:'finished',finishedAt:nowIso()});addLog('CAPT_FINISH',interaction.member,c);saveDb();await interaction.message.edit({embeds:[captEmbed({...c,closed:true})],components:[]}).catch(()=>{});return interaction.editReply({content:`🏁 CAPT #${c.id} завершён. Он сохранён в истории. Активных CAPT: **${db.activeCapts.length}**.`});}
      if(interaction.customId==='capt_manage_player')return interaction.editReply({content:'👤 **УПРАВЛЕНИЕ ИГРОКАМИ CAPT**\nВыбери игрока, затем действие.',components:captPlayerManageRows(c)});
      if(interaction.isUserSelectMenu()&&interaction.customId==='capt_select_player'){adminSelections.set(selectionKey('capt', c.id, interaction.user.id), interaction.values[0]);return interaction.editReply({content:`👤 Выбран игрок <@${interaction.values[0]}>.`,components:captPlayerManageRows(c)});}
      if(['capt_p_main','capt_p_reserve','capt_p_remove'].includes(interaction.customId)){
        const key=selectionKey('capt', c.id, interaction.user.id);const id=adminSelections.get(key);if(!id)return interaction.editReply({content:'⚠️ Сначала выбери игрока.',components:captPlayerManageRows(c)});
        let p=c.participants.find(x=>x.id===id),ri=c.reserves.findIndex(x=>x.id===id);
        if(interaction.customId==='capt_p_remove'){if(p)c.participants=c.participants.filter(x=>x.id!==id);else if(ri!==-1)c.reserves.splice(ri,1);else return interaction.editReply({content:'Игрок не найден.'});}
        if(interaction.customId==='capt_p_main'){if(p)return interaction.editReply({content:'Игрок уже в основном составе.'});if(ri===-1)return interaction.editReply({content:'Игрок не найден.'});p=c.reserves.splice(ri,1)[0];if(c.participants.length>=c.slots){c.reserves.unshift(p);return interaction.editReply({content:'❌ Основной состав уже заполнен.'});}c.participants.push(p);bumpStat(p.id,p.name,'promoted');}
        if(interaction.customId==='capt_p_reserve'){if(ri!==-1)return interaction.editReply({content:'Игрок уже в замене.'});if(!p)return interaction.editReply({content:'Игрок не найден.'});c.participants=c.participants.filter(x=>x.id!==id);c.reserves.push(p);}
        adminSelections.delete(selectionKey('capt', c.id, interaction.user.id));saveDb();await safeEditCaptMessage(c);return interaction.editReply({content:'✅ Состав обновлён.',components:captManageRows(c)});
      }
      if(interaction.customId==='capt_logs'){const rows=db.logs.filter(x=>x.captId===c.id).slice(-100).reverse();return interaction.editReply({embeds:[new EmbedBuilder().setTitle('📜 ЛОГИ CAPT').setDescription((rows.length?rows.map(x=>`${new Date(x.timestamp).toLocaleString('ru-RU')} ${x.action} — **${x.actorName}**`).join('\n'):'Логов пока нет.').slice(0,4000))]});}
      if(interaction.customId==='capt_delete'){for(const key of adminSelections.keys())if(key.startsWith(`capt:${c.id}:`))adminSelections.delete(key);db.activeCapts=db.activeCapts.filter(x=>x.id!==c.id);db.captHistory.push({...c,status:'deleted',deletedAt:nowIso()});addLog('CAPT_DELETE',interaction.member,c);saveDb();await interaction.message.delete().catch(()=>{});return interaction.editReply({content:`🗑️ CAPT #${c.id} удалён. Активных CAPT: **${db.activeCapts.length}**.`});}
      return;
    }

    if (!interaction.customId.startsWith('mcl_')) return;
    const m=(db.activeMcls||[]).find(x=>x.messageId===interaction.message.id);
    if (!m && interaction.customId!=='mcl_all') return interaction.reply({content:'❌ Этот MCL больше не активен.',flags:64});
    if (interaction.customId==='mcl_all') return interaction.reply({embeds:[activeMclsEmbed()],components:allMclButtonRows(),flags:64});
    if (interaction.customId==='mcl_all_close') return interaction.update({components:[]});
    await interaction.deferReply({flags:64});
    const adminOnly = ['mcl_manage','mcl_toggle','mcl_reminder','mcl_finish','mcl_manage_player','mcl_select_player','mcl_p_main','mcl_p_reserve','mcl_p_remove','mcl_logs','mcl_delete'];
    if (adminOnly.includes(interaction.customId) && !isAdmin(interaction.member)) return interaction.editReply({content:'❌ Эта кнопка доступна только администраторам.'});

    if (interaction.customId==='mcl_plus') {
      if (m.closed) return interaction.editReply({content:'🔒 Набор уже закрыт.'});
      if (m.participants.some(p=>p.id===interaction.user.id)||m.reserves.some(p=>p.id===interaction.user.id)) return interaction.editReply({content:'⚠️ Ты уже записан на этот MCL.'});
      const p={id:interaction.user.id,name:interaction.member?.displayName||interaction.user.username,joinedAt:nowIso()}; bumpStat(p.id,p.name,'joined');
      if(m.participants.length<m.slots){m.participants.push(p);bumpStat(p.id,p.name,'main');addLog('MCL_PLUS',interaction.member,null,m.id);saveDb();await safeEditMclMessage(interaction,m);return interaction.editReply({content:`✅ Ты в основном составе: ${m.participants.length}/${m.slots}.`});}
      m.reserves.push(p);bumpStat(p.id,p.name,'reserve');addLog('MCL_PLUS_RESERVE',interaction.member,null,m.id);saveDb();await safeEditMclMessage(interaction,m);return interaction.editReply({content:`🔄 Места заполнены. Ты **№${m.reserves.length}** в очереди замены.`});
    }
    if (interaction.customId==='mcl_minus') {
      const idx=m.participants.findIndex(p=>p.id===interaction.user.id);
      if(idx!==-1){const [removed]=m.participants.splice(idx,1);bumpStat(removed.id,removed.name,'declined');let promoted=m.reserves.shift();if(promoted){m.participants.push(promoted);bumpStat(promoted.id,promoted.name,'promoted');}addLog('MCL_MINUS',interaction.member,null,m.id);if(promoted)addLog('MCL_PROMOTE',interaction.member,promoted,m.id);saveDb();await safeEditMclMessage(interaction,m);return interaction.editReply({content:promoted?`✅ Ты вышел. 🔄 <@${promoted.id}> автоматически занял место из замены.`:'✅ Ты вышел из основного состава.'});}
      const ri=m.reserves.findIndex(p=>p.id===interaction.user.id);if(ri!==-1){const [removed]=m.reserves.splice(ri,1);bumpStat(removed.id,removed.name,'declined');addLog('MCL_MINUS_RESERVE',interaction.member,null,m.id);saveDb();await safeEditMclMessage(interaction,m);return interaction.editReply({content:'✅ Ты вышел из очереди замены.'});}
      return interaction.editReply({content:'ℹ️ Ты не записан на этот MCL.'});
    }
    if(interaction.customId==='mcl_list') return interaction.editReply({embeds:[mclEmbed(m)]});
    if(interaction.customId==='mcl_stats') return interaction.editReply({embeds:[statsEmbed()]});
    if(interaction.customId==='mcl_all') return interaction.editReply({embeds:[activeMclsEmbed()],components:allMclButtonRows()});
    if(interaction.customId==='mcl_manage') return interaction.editReply({content:`⚙️ **УПРАВЛЕНИЕ MCL #${m.id}**\n\nОсновной: ${m.participants.length}/${m.slots}\nЗамена: ${m.reserves.length}\nСтатус: ${mclStatus(m)}`,components:mclManageRows(m)});
    if(interaction.customId==='mcl_back') return interaction.editReply({embeds:[mclEmbed(m)],components:mclRows(m)});
    if(interaction.customId==='mcl_toggle'){m.closed=!m.closed;saveDb();addLog(m.closed?'MCL_CLOSE':'MCL_OPEN',interaction.member,null,m.id);await safeEditMclMessage(interaction,m);return interaction.editReply({content:m.closed?'🔒 Набор закрыт.':'🔓 Набор открыт.',components:mclManageRows(m)});}
    if(interaction.customId==='mcl_reminder'){const opts=[0,60,30,15,5];const i=opts.indexOf(m.reminderMinutes||0);m.reminderMinutes=opts[(i+1)%opts.length];m.reminderSent=false;saveDb();return interaction.editReply({content:m.reminderMinutes?`🔔 Напоминание установлено за **${m.reminderMinutes} мин.**`:'🔕 Напоминания выключены.',components:mclManageRows(m)});}
    if(interaction.customId==='mcl_finish'){for(const key of adminSelections.keys())if(key.startsWith(`mcl:${m.id}:`))adminSelections.delete(key);db.activeMcls=db.activeMcls.filter(x=>x.id!==m.id);db.mclHistory.push({...m,status:'finished',finishedAt:nowIso()});addLog('MCL_FINISH',interaction.member,null,m.id);saveDb();await interaction.message.edit({embeds:[mclEmbed({...m,closed:true})],components:[]}).catch(()=>{});return interaction.editReply({content:`🏁 MCL #${m.id} завершён. Он сохранён в истории.`});}
    if(interaction.customId==='mcl_manage_player') return interaction.editReply({content:`👤 **УПРАВЛЕНИЕ ИГРОКАМИ MCL #${m.id}**\nВыбери игрока, затем действие.`,components:playerManageRows(m)});
    if(interaction.isUserSelectMenu() && interaction.customId==='mcl_select_player'){adminSelections.set(selectionKey('mcl', m.id, interaction.user.id), interaction.values[0]);return interaction.editReply({content:`👤 Выбран игрок <@${interaction.values[0]}>. Теперь нажми действие ниже.`,components:playerManageRows(m)});}
    if(['mcl_p_main','mcl_p_reserve','mcl_p_remove'].includes(interaction.customId)){
      const key=selectionKey('mcl', m.id, interaction.user.id);const id=adminSelections.get(key);if(!id)return interaction.editReply({content:'⚠️ Сначала выбери игрока.',components:playerManageRows(m)});
      let p=m.participants.find(x=>x.id===id), ri=m.reserves.findIndex(x=>x.id===id);
      if(interaction.customId==='mcl_p_remove'){if(p){m.participants=m.participants.filter(x=>x.id!==id);}else if(ri!==-1)m.reserves.splice(ri,1);else return interaction.editReply({content:'Игрок не найден.'});}
      if(interaction.customId==='mcl_p_main'){if(p)return interaction.editReply({content:'Игрок уже в основном составе.'});if(ri===-1)return interaction.editReply({content:'Игрок не найден.'});p=m.reserves.splice(ri,1)[0];if(m.participants.length>=m.slots){m.reserves.unshift(p);return interaction.editReply({content:'❌ Основной состав уже заполнен.'});}m.participants.push(p);bumpStat(p.id,p.name,'promoted');}
      if(interaction.customId==='mcl_p_reserve'){if(ri!==-1)return interaction.editReply({content:'Игрок уже в замене.'});if(!p)return interaction.editReply({content:'Игрок не найден.'});m.participants=m.participants.filter(x=>x.id!==id);m.reserves.push(p);}
      adminSelections.delete(selectionKey('mcl', m.id, interaction.user.id));saveDb();await safeEditMclMessage(interaction,m);return interaction.editReply({content:'✅ Состав обновлён.',components:mclManageRows(m)});
    }
    if(interaction.customId==='mcl_logs'){const rows=db.logs.filter(x=>x.mclId===m.id).slice(-100).reverse();return interaction.editReply({embeds:[new EmbedBuilder().setTitle(`📜 ЛОГИ MCL #${m.id}`).setDescription((rows.length?rows.map(x=>`[2m${new Date(x.timestamp).toLocaleString('ru-RU')}[0m ${x.action} — **${x.actorName}**`).join('\n'):'Логов пока нет.').slice(0,4000))]});}
    if(interaction.customId==='mcl_delete'){for(const key of adminSelections.keys())if(key.startsWith(`mcl:${m.id}:`))adminSelections.delete(key);db.activeMcls=db.activeMcls.filter(x=>x.id!==m.id);db.mclHistory.push({...m,status:'deleted',deletedAt:nowIso()});addLog('MCL_DELETE',interaction.member,null,m.id);saveDb();await interaction.message.delete().catch(()=>{});return interaction.editReply({content:`🗑️ MCL #${m.id} удалён.`});}
  } catch(e) { console.error('Interaction error:',e); try { if(interaction.isButton()||interaction.isUserSelectMenu()){if(interaction.deferred&&!interaction.replied) await interaction.editReply({content:'❌ Произошла ошибка. Проверь консоль бота.'});else if(!interaction.replied) await interaction.reply({content:'❌ Произошла ошибка. Проверь консоль бота.',flags:64});}}catch{} }
});
client.on('error',e=>console.error('Discord client error:',e));
process.on('unhandledRejection',e=>console.error('Unhandled promise rejection:',e));
client.login(TOKEN);
