import { EmbedBuilder, PermissionFlags, AuditLogActionType, inviteUrl } from '@fluxerjs/core';
import { randomUUID } from 'node:crypto';

import { INVITES_PREFIX } from '../utils/loggerPrefixes.js';

const EMBED_COLOR = '#00ae86';
const ID_REGEX = /^\d{15,21}$/;
const MAX_BONUS_AMOUNT = 1_000_000_000;
const MIN_GRAPH_DAYS = 5;
const MAX_GRAPH_DAYS = 120;
const DAY_MS = 86_400_000;
const RESYNC_SKIP_MS = 60 * 1000; // não sincroniza de novo uma guild atualizada há menos que isso
const VANITY_TTL_MS = 10 * 60 * 1000;
const VANITY_MISS_TTL_MS = 60 * 1000; // sem vanity: confere de novo logo, caso seja ativado
const PRESENCE_TTL_MS = 5 * 60 * 1000;
const PRESENCE_LOOKUP_LIMIT = 300;

// Memória do tracker (zera a cada reinício, que é o desejado): o banco guarda os dados, aqui só ficam os atalhos.
const inviteStore = new Map(); // guildId -> Map<código, { uses, maxUses }> (último estado conhecido na API)
const inviteStoreUpdatedAt = new Map(); // guildId -> timestamp da última atualização do snapshot
const guildQueues = new Map(); // guildId -> Promise (uma entrada/saída por vez em cada servidor)
const guildStates = new Map(); // guildId -> { codes, stats, version } (cache das contagens)
const vanityCache = new Map(); // guildId -> { code, expiresAt }
const presenceCache = new Map(); // guildId -> Map<userId, { present, at }>

/** Erro "esperado" (mensagem já é amigável e pode ser mostrada ao usuário). */
export class InviteError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InviteError';
  }
}

/* -------------------------------------------------------------------------- */
/* Utilitários                                                                */
/* -------------------------------------------------------------------------- */

function isTextChannel(channel) {
  if (!channel) return false;
  if (typeof channel.isTextBased === 'function') return channel.isTextBased() && typeof channel.send === 'function';
  return typeof channel.send === 'function';
}

function getGuild(client, guildId) {
  return client.guilds.get(guildId) ?? null;
}

function getChannel(client, guildId, channelId) {
  const channel = getGuild(client, guildId)?.channels.get(channelId);
  return isTextChannel(channel) ? channel : null;
}

/** Membro do próprio bot na guild (o cache pode estar vazio logo após ligar). */
async function getBotMember(guild) {
  return guild.members.me ?? (await guild.members.fetchMe?.().catch(() => null)) ?? null;
}

async function botHasPermission(guild, permission) {
  const me = await getBotMember(guild);
  return Boolean(me?.permissions?.has(permission));
}

/** Só rastreamos servidores cadastrados (o bot sai dos outros) ou liberados em `sairDeServers.bypassIds`. */
async function isGuildTracked(client, database, guildId) {
  if (client.brain?.config?.sairDeServers?.bypassIds?.includes(guildId)) return true;
  const server = await database.Server.get(guildId);
  return Boolean(server) && Object.keys(server).length > 0;
}

/** Timestamp (ms) embutido em um snowflake do Fluxer. */
export function snowflakeTimestamp(id) {
  try {
    return Number((BigInt(id) >> 22n) + 1420070400000n);
  } catch {
    return 0;
  }
}

function userCreatedAt(user) {
  return user?.createdAt instanceof Date ? user.createdAt.getTime() : snowflakeTimestamp(user?.id);
}

function avatarOf(user) {
  if (!user) return '';
  const value = typeof user.avatarURL === 'function' ? user.avatarURL() : user.avatarURL;
  return value ?? '';
}

function userTag(user) {
  const discriminator = user?.discriminator;
  if (!discriminator || discriminator === '0' || discriminator === '0000') return user?.username ?? 'Desconhecido';
  return `${user.username}#${discriminator}`;
}

/** Nome exibido: apelido no servidor, senão o nome de usuário. */
function displayName(member, user = member?.user ?? member) {
  return (member?.nick ? member.nick : user?.username) ?? 'Desconhecido';
}

function toMs(value) {
  if (value instanceof Date) return value.getTime();
  const number = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(number) ? number : Date.now();
}

/** Formato <t:segundos:estilo> que o Fluxer mostra no horário de quem lê. */
function stamp(ms, style = 'R') {
  return `<t:${Math.floor(ms / 1000)}:${style}>`;
}

/** "2 horas", "3 dias"... (sem "há"/"em"). */
function humanizeDuration(ms) {
  const seconds = Math.abs(ms) / 1000;
  const units = [['ano', 'anos', 31_536_000], ['mês', 'meses', 2_592_000], ['dia', 'dias', 86_400], ['hora', 'horas', 3_600], ['minuto', 'minutos', 60]];
  for (const [singular, plural, size] of units) {
    if (seconds >= size) {
      const amount = Math.round(seconds / size);
      return `${amount} ${amount === 1 ? singular : plural}`;
    }
  }
  return 'alguns segundos';
}

/** Mesmo texto, sem permitir que alguém use @everyone/menções dentro de uma mensagem do bot. */
function safeText(value) {
  return String(value ?? '')
    .replace(/@(everyone|here)/gi, '@\u200b$1')
    .replace(/<@/g, '<@\u200b');
}

/** Executa uma tarefa por vez em cada servidor (entradas/saídas simultâneas não se atropelam). */
function withGuildQueue(guildId, task) {
  const previous = guildQueues.get(guildId) ?? Promise.resolve();
  const run = previous.then(task, task);
  const tail = run.catch(() => {});
  guildQueues.set(guildId, tail);
  tail.then(() => {
    if (guildQueues.get(guildId) === tail) guildQueues.delete(guildId);
  });
  return run;
}

/* -------------------------------------------------------------------------- */
/* Configurações do servidor                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Definição das opções (usada pelo comando `config`, pela API e pelo dashboard).
 * Os valores ficam em `Server.invites`; o que não estiver salvo usa `padrao`.
 */
export const INVITE_SETTINGS = {
  joinMessage: {
    tipo: 'texto', grupo: 'entradas', nome: 'Mensagem de entrada', limpavel: false,
    descricao: 'Mensagem enviada no canal de entradas quando alguém entra. Aceita variáveis e JSON de embed.',
    padrao: '{memberMention} **entrou**; convidado por **{inviterName}** (**{numInvites}** convites)',
  },
  joinMessageChannel: {
    tipo: 'canal', grupo: 'entradas', nome: 'Canal de entradas', limpavel: true,
    descricao: 'Canal onde a mensagem de entrada é enviada. Vazio = desativado.',
    padrao: null,
  },
  leaveMessage: {
    tipo: 'texto', grupo: 'saidas', nome: 'Mensagem de saída', limpavel: false,
    descricao: 'Mensagem enviada no canal de saídas quando alguém sai. Aceita variáveis e JSON de embed.',
    padrao: '{memberName} **saiu**; convidado por **{inviterName}**',
  },
  leaveMessageChannel: {
    tipo: 'canal', grupo: 'saidas', nome: 'Canal de saídas', limpavel: true,
    descricao: 'Canal onde a mensagem de saída é enviada. Vazio = desativado.',
    padrao: null,
  },
  leaderboardStyle: {
    tipo: 'opcao', grupo: 'ranking', nome: 'Estilo do ranking', limpavel: false,
    descricao: 'Como o ranking de convites é exibido.',
    padrao: 'normal', opcoes: ['normal', 'table', 'mentions'],
  },
  hideLeftMembersFromLeaderboard: {
    tipo: 'booleano', grupo: 'ranking', nome: 'Ocultar quem saiu do ranking', limpavel: false,
    descricao: 'Esconde do ranking quem convidou mas não está mais no servidor.',
    padrao: true,
  },
  autoSubtractFakes: {
    tipo: 'booleano', grupo: 'fakes', nome: 'Subtrair fakes automaticamente', limpavel: false,
    descricao: 'Quem entra de novo pelo mesmo convite não conta mais de uma vez.',
    padrao: true,
  },
  autoSubtractLeaves: {
    tipo: 'booleano', grupo: 'saidas', nome: 'Subtrair saídas automaticamente', limpavel: false,
    descricao: 'Quem sai em pouco tempo deixa de contar como convite.',
    padrao: true,
  },
  autoSubtractLeaveThreshold: {
    tipo: 'numero', grupo: 'saidas', nome: 'Tempo limite de saída (segundos)', limpavel: false,
    descricao: 'Saídas dentro desse tempo após a entrada são subtraídas (se a opção acima estiver ativa).',
    padrao: 600, minimo: 0, maximo: 31_536_000,
  },
};

/** Variáveis aceitas nas mensagens de entrada/saída (para o `config` e para o dashboard). */
export const INVITE_TEMPLATE_VARIABLES = [
  ['{inviteCode}', 'Código do convite usado'],
  ['{memberId}', 'ID de quem entrou/saiu'],
  ['{memberName}', 'Apelido ou nome de usuário de quem entrou/saiu'],
  ['{memberFullName}', 'usuario#0000 de quem entrou/saiu'],
  ['{memberMention}', 'Menção de quem entrou/saiu'],
  ['{memberImage}', 'URL do avatar de quem entrou/saiu'],
  ['{numJoins}', 'Quantas vezes o membro já entrou no servidor'],
  ['{inviterId}', 'ID de quem convidou'],
  ['{inviterName}', 'Apelido ou nome de usuário de quem convidou'],
  ['{inviterFullName}', 'usuario#0000 de quem convidou'],
  ['{inviterMention}', 'Menção de quem convidou'],
  ['{inviterImage}', 'URL do avatar de quem convidou'],
  ['{numInvites}', 'Total de convites de quem convidou'],
  ['{numRegularInvites}', 'Convites regulares de quem convidou'],
  ['{numBonusInvites}', 'Convites bônus de quem convidou'],
  ['{numFakeInvites}', 'Convites fake de quem convidou'],
  ['{numLeaveInvites}', 'Convites perdidos por saída de quem convidou'],
  ['{memberCount}', 'Quantidade de membros do servidor'],
  ['{channelMention}', 'Menção do canal do convite'],
  ['{channelName}', 'Nome do canal do convite'],
  ['{memberCreated:date|duration|timeAgo|calendar}', 'Data de criação da conta'],
  ['{firstJoin:date|duration|timeAgo|calendar}', 'Primeira vez que o membro entrou'],
  ['{previousJoin:date|duration|timeAgo|calendar}', 'Entrada anterior do membro'],
  ['{joinedAt:date|duration|timeAgo|calendar}', 'Momento da entrada'],
];

const TRUE_VALUES = new Set(['true', 'on', 'yes', 'sim', 's', 'y', 'ativar', 'ligar', 'verdadeiro', '1']);
const FALSE_VALUES = new Set(['false', 'off', 'no', 'nao', 'não', 'n', 'desativar', 'desligar', 'falso', '0']);
const CLEAR_VALUES = new Set(['none', 'nenhum', 'nenhuma', 'vazio', 'null', '-']);

function hasOwn(object, key) {
  return Object.hasOwn(object, key);
}

/** Descobre a chave de uma opção ignorando maiúsculas (ex.: "joinmessagechannel"). */
export function findSettingKey(text) {
  const wanted = String(text ?? '').toLowerCase();
  return Object.keys(INVITE_SETTINGS).find((key) => key.toLowerCase() === wanted) ?? null;
}

/**
 * Converte o valor digitado (comando) ou enviado (dashboard) no tipo da opção.
 * Retorna `{ reset: true }` para "voltar ao padrão", `null` para limpar, ou o valor convertido.
 */
export function coerceSetting(key, raw) {
  if (!hasOwn(INVITE_SETTINGS, key)) throw new InviteError(`Opção desconhecida: \`${key}\`.`);
  const setting = INVITE_SETTINGS[key];

  if (raw === null) {
    if (!setting.limpavel) throw new InviteError(`A opção \`${key}\` não pode ser limpa. Use \`padrao\` para restaurar o valor padrão.`);
    return null;
  }

  if (typeof raw === 'string') {
    const texto = raw.trim().toLowerCase();
    if (['padrao', 'padrão', 'default'].includes(texto)) return { reset: true };
    if (CLEAR_VALUES.has(texto) && setting.tipo !== 'texto') {
      if (!setting.limpavel) throw new InviteError(`A opção \`${key}\` não pode ser limpa. Use \`padrao\` para restaurar o valor padrão.`);
      return null;
    }
  }

  switch (setting.tipo) {
    case 'booleano': {
      if (typeof raw === 'boolean') return raw;
      const texto = String(raw).trim().toLowerCase();
      if (TRUE_VALUES.has(texto)) return true;
      if (FALSE_VALUES.has(texto)) return false;
      throw new InviteError('Valor inválido. Use `sim` ou `não`.');
    }
    case 'numero': {
      const numero = typeof raw === 'number' ? raw : Number(String(raw).trim().replace(',', '.'));
      if (!Number.isInteger(numero)) throw new InviteError('Valor inválido. Informe um número inteiro.');
      if (numero < setting.minimo || numero > setting.maximo) {
        throw new InviteError(`O valor precisa estar entre ${setting.minimo} e ${setting.maximo}.`);
      }
      return numero;
    }
    case 'opcao': {
      const texto = String(raw).trim().toLowerCase();
      if (!setting.opcoes.includes(texto)) throw new InviteError(`Valor inválido. Opções: ${setting.opcoes.map((o) => `\`${o}\``).join(', ')}.`);
      return texto;
    }
    case 'canal': {
      const texto = String(raw).trim();
      const id = texto.match(/^<#(\d{15,21})>$/)?.[1] ?? (ID_REGEX.test(texto) ? texto : null);
      if (!id) throw new InviteError('Canal inválido. Use uma menção de canal (#canal) ou o ID do canal.');
      return id;
    }
    case 'texto': {
      if (typeof raw !== 'string' || !raw.trim()) throw new InviteError('O texto não pode ficar vazio.');
      if (raw.length > 4000) throw new InviteError('O texto pode ter no máximo 4000 caracteres.');
      return raw;
    }
    default:
      throw new InviteError(`Tipo de opção desconhecido: ${setting.tipo}.`);
  }
}

/** Configurações do servidor: o que foi salvo por cima dos padrões. */
export async function getInviteSettings(database, guildId) {
  const padroes = Object.fromEntries(Object.entries(INVITE_SETTINGS).map(([key, setting]) => [key, setting.padrao]));
  const salvas = await database.Server.getInvitesConfig(guildId);
  const settings = { ...padroes };
  for (const key of Object.keys(padroes)) {
    if (salvas?.[key] !== undefined) settings[key] = salvas[key];
  }
  return settings;
}

/** Texto amigável de um valor de opção (para o comando `config`). */
export function describeSettingValue(key, value) {
  if (value === null || value === undefined) return 'não definido';
  switch (INVITE_SETTINGS[key]?.tipo) {
    case 'canal': return `<#${value}>`;
    case 'booleano': return value ? 'ativado' : 'desativado';
    case 'numero': return `${value}s`;
    default: return String(value);
  }
}

/** Confere se o bot consegue enviar mensagens (com embed) no canal escolhido para entradas/saídas. */
export function validateMessageChannel(client, guildId, channelId) {
  const guild = getGuild(client, guildId);
  const channel = guild?.channels.get(channelId);
  if (!isTextChannel(channel)) throw new InviteError('O canal precisa ser um canal de texto deste servidor.');

  const me = guild.members.me;
  const permissions = me?.permissionsIn?.(channel);
  if (permissions) {
    if (!permissions.has(PermissionFlags.ViewChannel)) throw new InviteError('Não consigo ver esse canal.');
    if (!permissions.has(PermissionFlags.SendMessages)) throw new InviteError('Não consigo enviar mensagens nesse canal.');
    if (!permissions.has(PermissionFlags.EmbedLinks)) throw new InviteError('Não consigo enviar embeds nesse canal.');
  }
}

/**
 * Atualiza uma ou mais opções do servidor (usado pelo comando `config` e pela API do dashboard).
 * `patch` = { opção: valor } (valor `null` limpa; "padrao" restaura). Valida tudo antes de gravar qualquer coisa.
 * Retorna { changed: { opção: valor }, settings, messages }.
 */
export async function updateInviteSettings(client, database, guildId, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length) {
    throw new InviteError('Nenhuma configuração foi informada.');
  }

  const before = await getInviteSettings(database, guildId);
  const toSave = {};
  const toReset = [];

  for (const [key, raw] of Object.entries(patch)) {
    const value = coerceSetting(key, raw);
    if (value?.reset) {
      toReset.push(key);
      continue;
    }
    if (value !== null && INVITE_SETTINGS[key].tipo === 'canal') validateMessageChannel(client, guildId, value);
    toSave[key] = value;
  }

  if (Object.keys(toSave).length) {
    const response = await database.Server.setInvitesConfig(guildId, toSave);
    if (!response?.success) throw new InviteError(response?.message || 'Não consegui salvar: este servidor não está cadastrado.');
  }
  if (toReset.length) {
    const response = await database.Server.resetInvitesConfig(guildId, toReset);
    if (!response?.success) throw new InviteError(response?.message || 'Não consegui salvar: este servidor não está cadastrado.');
  }

  const settings = await getInviteSettings(database, guildId);
  const changed = {};
  const messages = [];
  for (const key of [...Object.keys(toSave), ...toReset]) {
    if (settings[key] === before[key]) continue;
    changed[key] = settings[key];
    const effect = await applySettingEffects(client, database, guildId, key, settings[key]);
    if (effect) messages.push(effect);
  }

  return { changed, settings, messages };
}

/**
 * Efeitos de mudar algumas opções (igual ao que a referência faz ao salvar): ligar "subtrair fakes/saídas"
 * já aplica no histórico; desligar devolve o que foi subtraído. Retorna uma mensagem para o comando mostrar.
 */
async function applySettingEffects(client, database, guildId, key, value) {
  if (key === 'autoSubtractFakes') {
    if (value) {
      const total = await subtractFakes(client, database, guildId);
      return total ? 'Convites fake removidos!' : 'Nenhum convite fake encontrado.';
    }
    await setInvalidationForAll(database, guildId, 'fake', null);
    return null;
  }
  if (key === 'autoSubtractLeaves') {
    if (value) {
      await subtractLeaves(client, database, guildId);
      return 'Saídas removidas!';
    }
    await setInvalidationForAll(database, guildId, 'leave', null);
    return null;
  }
  if (key === 'autoSubtractLeaveThreshold') {
    await subtractLeaves(client, database, guildId);
    return 'Saídas removidas!';
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Mensagens de entrada/saída (templates)                                     */
/* -------------------------------------------------------------------------- */

/** Converte JSON de embed (formato Discord/Fluxer) em EmbedBuilder. Retorna null se vazio/inválido. */
function embedFromJson(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  try {
    const embed = new EmbedBuilder();
    if (typeof data.title === 'string' && data.title) embed.setTitle(data.title.slice(0, 256));
    if (typeof data.description === 'string' && data.description) embed.setDescription(data.description.slice(0, 4096));
    if (typeof data.url === 'string' && /^https?:\/\//.test(data.url)) embed.setURL(data.url);
    if (data.color !== undefined && data.color !== null) embed.setColor(data.color);
    if (data.timestamp) embed.setTimestamp(new Date(data.timestamp));
    if (data.footer?.text) embed.setFooter({ text: String(data.footer.text).slice(0, 2048), iconURL: data.footer.icon_url ?? data.footer.iconURL });
    if (data.author?.name) embed.setAuthor({ name: String(data.author.name).slice(0, 256), url: data.author.url, iconURL: data.author.icon_url ?? data.author.iconURL });
    const thumbnail = typeof data.thumbnail === 'string' ? data.thumbnail : data.thumbnail?.url;
    if (thumbnail) embed.setThumbnail(thumbnail);
    const image = typeof data.image === 'string' ? data.image : data.image?.url;
    if (image) embed.setImage(image);
    const fields = (Array.isArray(data.fields) ? data.fields : [])
      .filter((field) => field?.name && field?.value)
      .slice(0, 25)
      .map((field) => ({ name: String(field.name).slice(0, 256), value: String(field.value).slice(0, 1024), inline: Boolean(field.inline) }));
    if (fields.length) embed.addFields(...fields);

    const built = embed.data ?? {};
    return built.title || built.description || built.fields?.length || built.image || built.author ? embed : null;
  } catch {
    return null;
  }
}

function fillDatePlaceholder(text, name, value) {
  if (typeof value === 'string') {
    return ['date', 'duration', 'timeAgo', 'calendar'].reduce((acc, format) => acc.split(`{${name}:${format}}`).join(value), text);
  }
  return text
    .split(`{${name}:date}`).join(stamp(value, 'F'))
    .split(`{${name}:duration}`).join(humanizeDuration(value - Date.now()))
    .split(`{${name}:timeAgo}`).join(stamp(value, 'R'))
    .split(`{${name}:calendar}`).join(stamp(value, 'f'));
}

/** Troca as variáveis do texto. Se o resultado for um JSON de embed, devolve um EmbedBuilder; senão, o texto. */
function fillTemplate(template, strings, dates) {
  let text = template;
  for (const [key, value] of Object.entries(strings)) text = text.split(`{${key}}`).join(String(value ?? ''));
  for (const [key, value] of Object.entries(dates)) text = fillDatePlaceholder(text, key, value);

  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const embed = embedFromJson(JSON.parse(trimmed));
      if (embed) return embed;
    } catch {
      // não é JSON: segue como texto
    }
  }
  return text;
}

/**
 * Monta a mensagem de entrada/saída.
 * @param member   GuildMember / PartialGuildMember / { user }
 * @param inviter  { user, nick? }
 * @param invite   { code, channel: { id, name } }
 */
export async function fillJoinLeaveTemplate(database, template, guild, member, counts, { invite, inviter }) {
  const memberUser = member.user ?? member;
  const inviterUser = inviter.user ?? inviter;
  const memberRow = await database.InviteMembers.get(guild.id, memberUser.id);
  const joins = [...(memberRow?.joins ?? [])].sort((a, b) => a.createdAt - b.createdAt);

  // Os nomes entram dentro de um possível JSON: escapa aspas e barras
  const jsonSafe = (text) => JSON.stringify(String(text)).slice(1, -1);
  const channel = invite.channel ?? { id: '', name: '' };

  return fillTemplate(
    template,
    {
      inviteCode: invite.code,
      memberId: memberUser.id,
      memberName: jsonSafe(displayName(member, memberUser)),
      memberFullName: jsonSafe(userTag(memberUser)),
      memberMention: `<@${memberUser.id}>`,
      memberImage: avatarOf(memberUser),
      numJoins: joins.length,
      inviterId: inviterUser.id,
      inviterName: jsonSafe(displayName(inviter, inviterUser)),
      inviterFullName: jsonSafe(userTag(inviterUser)),
      inviterMention: `<@${inviterUser.id}>`,
      inviterImage: avatarOf(inviterUser),
      numInvites: counts.total,
      numRegularInvites: counts.regular,
      numBonusInvites: counts.custom,
      numFakeInvites: counts.fake,
      numLeaveInvites: counts.leave,
      memberCount: guild.memberCount ?? 0,
      channelMention: `<#${channel.id}>`,
      channelName: channel.name ?? '',
    },
    {
      memberCreated: userCreatedAt(memberUser),
      firstJoin: joins.length ? joins[0].createdAt : 'nunca',
      previousJoin: joins.length > 1 ? joins[joins.length - 2].createdAt : 'nunca',
      joinedAt: member.joinedAt ? toMs(member.joinedAt) : Date.now(),
    },
  );
}

/** Prévia de uma mensagem com dados de exemplo (usada pelo `config` e pelo dashboard). */
export async function previewTemplate(database, guild, template, { member, inviter } = {}) {
  const sampleUser = (id, username) => ({ id, username, discriminator: '0001', avatarURL: null, createdAt: new Date(Date.now() - 200 * DAY_MS) });
  return fillJoinLeaveTemplate(
    database,
    template,
    guild,
    member ?? { user: sampleUser('100000000000000001', 'NovoMembro'), nick: null, joinedAt: new Date() },
    { total: 42, regular: 40, custom: 5, fake: -2, leave: -1 },
    {
      invite: { code: 'abc123', channel: { id: '100000000000000099', name: 'geral' } },
      inviter: inviter ?? { user: sampleUser('100000000000000002', 'Convidador'), nick: null },
    },
  );
}

/** Envia o resultado de um template (texto ou embed). Se o bot perdeu a permissão, desativa o canal. */
async function sendTemplate(client, database, guildId, key, channel, message) {
  if (!message) return;
  const payload = typeof message === 'string' ? { content: message.slice(0, 2000) } : { embeds: [message] };
  if (payload.content === '') return;
  try {
    await channel.send(payload);
  } catch (error) {
    if (error?.statusCode === 403) {
      console.warn(INVITES_PREFIX, `Sem permissão para enviar em ${channel.id} (${guildId}); desativando ${key}.`);
      await database.Server.setInvitesConfig(guildId, { [key]: null }).catch(() => {});
    } else {
      console.warn(INVITES_PREFIX, `Falha ao enviar mensagem em ${channel.id}:`, error?.message);
    }
  }
}

/** Valida o canal configurado para entradas/saídas; se estiver inválido, limpa a opção. */
async function resolveMessageChannel(client, database, guild, key, channelId) {
  if (!channelId) return null;
  try {
    validateMessageChannel(client, guild.id, channelId);
    return getChannel(client, guild.id, channelId);
  } catch (error) {
    console.warn(INVITES_PREFIX, `Canal de ${key} inválido em ${guild.id} (${error.message}); desativando a opção.`);
    await database.Server.setInvitesConfig(guild.id, { [key]: null }).catch(() => {});
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Cache de contagens                                                         */
/* -------------------------------------------------------------------------- */

// Contar convites exige olhar todos os registros do servidor. Para não repetir isso a cada comando,
// montamos um resumo em memória uma vez e o mantemos atualizado a cada entrada/saída.
// `version` sobe a cada mudança: se ela mudar enquanto o resumo está sendo montado, montamos de novo.

function getState(guildId) {
  let state = guildStates.get(guildId);
  if (!state) {
    state = { codes: null, stats: null, hidden: null, version: 0 };
    guildStates.set(guildId, state);
  }
  return state;
}

/** Descarta o resumo (ele será refeito na próxima consulta). Use depois de mudanças em massa. */
function invalidateCounts(guildId) {
  const state = getState(guildId);
  state.codes = null;
  state.stats = null;
  state.hidden = null;
  state.version += 1;
}

async function ensureState(database, guildId) {
  const state = getState(guildId);

  while (!state.stats) {
    const version = state.version;
    const [codes, members] = await Promise.all([database.InviteCodes.list(guildId), database.InviteMembers.list(guildId)]);

    const codeMap = new Map(codes.map((code) => [code.code, code]));
    const stats = new Map(); // inviterId -> { fake, leave, custom, name }
    const hidden = new Set();
    const entry = (id) => {
      if (!stats.has(id)) stats.set(id, { fake: 0, leave: 0, custom: 0, name: null });
      return stats.get(id);
    };

    for (const member of members) {
      if (member.hideFromLeaderboard) hidden.add(member.userId);

      for (const join of member.joins) {
        if (!join.invalidatedReason || join.cleared) continue;
        const inviterId = codeMap.get(join.code)?.inviterId;
        if (!inviterId) continue;
        if (join.invalidatedReason === 'fake') entry(inviterId).fake -= 1;
        else entry(inviterId).leave -= 1;
      }

      const custom = member.bonus.filter((bonus) => !bonus.cleared).reduce((sum, bonus) => sum + Number(bonus.amount), 0);
      if (custom !== 0) {
        const item = entry(member.userId);
        item.custom += custom;
        item.name = member.name ?? item.name;
      }
    }

    if (state.version === version) {
      state.codes = codeMap;
      state.stats = stats;
      state.hidden = hidden;
    }
  }

  return state;
}

function regularOf(state, userId) {
  let total = 0;
  for (const code of state.codes.values()) {
    if (code.inviterId === userId && code.uses > code.clearedAmount) total += code.uses - code.clearedAmount;
  }
  return total;
}

function countsOf(state, userId) {
  const stats = state.stats.get(userId);
  const regular = regularOf(state, userId);
  const custom = stats?.custom ?? 0;
  const fake = stats?.fake ?? 0;
  const leave = stats?.leave ?? 0;
  return { regular, custom, fake, leave, total: regular + custom + fake + leave };
}

/** Guarda no resumo (se ele existir) o registro de um código que acabou de ser gravado. */
function rememberCode(guildId, row) {
  const state = getState(guildId);
  state.version += 1;
  state.codes?.set(row.code, row);
}

/** Reflete no resumo uma entrada que mudou de "invalidada por X" para "invalidada por Y" (null = válida). */
function rememberInvalidation(guildId, join, from, to) {
  const state = getState(guildId);
  state.version += 1;
  if (!state.stats || join.cleared) return;

  const inviterId = state.codes.get(join.code)?.inviterId;
  if (!inviterId) return;
  if (!state.stats.has(inviterId)) state.stats.set(inviterId, { fake: 0, leave: 0, custom: 0, name: null });
  const item = state.stats.get(inviterId);
  if (from === 'fake') item.fake += 1;
  if (from === 'leave') item.leave += 1;
  if (to === 'fake') item.fake -= 1;
  if (to === 'leave') item.leave -= 1;
}

/** { regular, custom, fake, leave, total } de um membro. `fake` e `leave` são negativos (o que foi subtraído). */
export async function getInviteCounts(database, guildId, userId) {
  const state = await ensureState(database, guildId);
  return countsOf(state, userId);
}

/* -------------------------------------------------------------------------- */
/* Ranking                                                                    */
/* -------------------------------------------------------------------------- */

/** Ranking completo (sem filtros de exibição), ordenado do maior para o menor. */
export async function generateLeaderboard(client, database, guildId) {
  const state = await ensureState(database, guildId);

  const ids = new Set(state.stats.keys());
  const names = new Map();
  for (const code of state.codes.values()) {
    if (!code.inviterId) continue;
    ids.add(code.inviterId);
    names.set(code.inviterId, code.inviterName ?? names.get(code.inviterId));
  }

  const entries = [];
  for (const id of ids) {
    const counts = countsOf(state, id);
    if (counts.total <= 0) continue;
    entries.push({
      id,
      name: client.users.get(id)?.username ?? state.stats.get(id)?.name ?? names.get(id) ?? id,
      total: counts.total,
      regular: counts.regular,
      custom: counts.custom,
      fakes: counts.fake,
      leaves: counts.leave,
    });
  }

  return entries.sort((a, b) => (b.total - a.total) || a.name.localeCompare(b.name));
}

/**
 * Quem não está mais no servidor sai do ranking. O cache de membros pode estar incompleto,
 * então quem não está nele é conferido na API (com cache de 5 minutos).
 */
async function filterPresentMembers(guild, entries) {
  let guildCache = presenceCache.get(guild.id);
  if (!guildCache) {
    guildCache = new Map();
    presenceCache.set(guild.id, guildCache);
  }

  const now = Date.now();
  const toLookup = [];
  for (const entry of entries) {
    if (guild.members.has(entry.id)) continue;
    const cached = guildCache.get(entry.id);
    if (cached && now - cached.at < PRESENCE_TTL_MS) continue;
    if (toLookup.length < PRESENCE_LOOKUP_LIMIT) toLookup.push(entry.id);
  }

  const queue = [...toLookup];
  const worker = async () => {
    for (let id = queue.shift(); id; id = queue.shift()) {
      const member = await guild.fetchMember(id).catch(() => null);
      guildCache.set(id, { present: Boolean(member), at: Date.now() });
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, toLookup.length) }, worker));

  return entries.filter((entry) => {
    if (guild.members.has(entry.id)) return true;
    const cached = guildCache.get(entry.id);
    return cached ? cached.present : true; // além do limite de consultas, considera que está no servidor
  });
}

/** Ranking como o comando exibe: sem quem foi ocultado e (conforme a configuração) sem quem saiu do servidor. */
export async function getLeaderboard(client, database, guildId) {
  const guild = getGuild(client, guildId);
  const settings = await getInviteSettings(database, guildId);
  const state = await ensureState(database, guildId);

  let entries = (await generateLeaderboard(client, database, guildId)).filter((entry) => !state.hidden.has(entry.id));
  if (settings.hideLeftMembersFromLeaderboard && guild) entries = await filterPresentMembers(guild, entries);
  return { entries, style: settings.leaderboardStyle };
}

/* -------------------------------------------------------------------------- */
/* Consultas de um membro                                                     */
/* -------------------------------------------------------------------------- */

/** Códigos de convite de um membro, do mais usado para o menos usado. */
export async function getMemberCodes(database, guildId, userId) {
  const state = await ensureState(database, guildId);
  return [...state.codes.values()].filter((code) => code.inviterId === userId).sort((a, b) => b.uses - a.uses);
}

/**
 * Tudo que o comando `info` mostra de um membro: contagens, zerados, entradas dele, códigos, bônus e convidados.
 */
export async function getMemberInfo(database, guildId, userId) {
  const state = await ensureState(database, guildId);
  const members = await database.InviteMembers.list(guildId);
  const own = members.find((member) => member.userId === userId) ?? null;

  const codes = [...state.codes.values()].filter((code) => code.inviterId === userId).sort((a, b) => b.uses - a.uses);
  const clearedRegular = codes.reduce((sum, code) => sum + code.clearedAmount, 0);
  const bonus = [...(own?.bonus ?? [])].sort((a, b) => b.createdAt - a.createdAt);
  const clearedBonus = bonus.filter((item) => item.cleared).reduce((sum, item) => sum + Number(item.amount), 0);

  // Quem este membro convidou (e continua valendo), do mais recente para o mais antigo
  const invited = [];
  for (const member of members) {
    const valid = member.joins.filter((join) => !join.invalidatedReason && state.codes.get(join.code)?.inviterId === userId);
    if (valid.length) invited.push({ userId: member.userId, createdAt: Math.max(...valid.map((join) => join.createdAt)) });
  }
  invited.sort((a, b) => b.createdAt - a.createdAt);

  const joins = [...(own?.joins ?? [])]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 100)
    .map((join) => ({ ...join, inviterId: state.codes.get(join.code)?.inviterId ?? null }));

  return {
    counts: countsOf(state, userId),
    clearedRegular,
    clearedBonus,
    totalJoins: own?.joins.length ?? 0,
    joins,
    codes,
    bonus: bonus.filter((item) => !item.cleared),
    allBonus: bonus,
    invited,
  };
}

/* -------------------------------------------------------------------------- */
/* Operações administrativas                                                  */
/* -------------------------------------------------------------------------- */

/** Atualiza todos os membros do servidor com uma função que devolve as entradas novas (ou null se nada muda). */
async function rewriteJoins(database, guildId, rewrite) {
  const members = await database.InviteMembers.list(guildId);
  let changed = 0;
  for (const member of members) {
    await database.InviteMembers.mutate(guildId, member.userId, (current) => {
      const result = rewrite(current.joins);
      if (!result) return null;
      changed += result.changed;
      return { joins: result.joins };
    });
  }
  invalidateCounts(guildId);
  return changed;
}

/** Todas as entradas com a invalidação `reason` passam a ter `newReason`. */
async function setInvalidationForAll(database, guildId, reason, newReason) {
  return rewriteJoins(database, guildId, (joins) => {
    if (!joins.some((join) => join.invalidatedReason === reason)) return null;
    let changed = 0;
    const next = joins.map((join) => {
      if (join.invalidatedReason !== reason) return join;
      changed += 1;
      return { ...join, invalidatedReason: newReason };
    });
    return { joins: next, changed };
  });
}

/**
 * Subtrai os fakes: de todas as entradas de um mesmo membro pelo mesmo código, só a mais recente vale.
 * Retorna quantas entradas passaram a ser fake.
 */
export async function subtractFakes(client, database, guildId) {
  return rewriteJoins(database, guildId, (joins) => {
    const latest = new Map(); // código -> posição da entrada mais recente
    joins.forEach((join, index) => {
      const current = latest.get(join.code);
      if (current === undefined || join.createdAt >= joins[current].createdAt) latest.set(join.code, index);
    });

    let changed = 0;
    const next = joins.map((join, index) => {
      if (latest.get(join.code) === index || join.invalidatedReason === 'fake') return join;
      changed += 1;
      return { ...join, invalidatedReason: 'fake' };
    });
    return changed ? { joins: next, changed } : null;
  });
}

/** Recalcula quais saídas contam como "perdidas" conforme o tempo limite configurado. */
export async function subtractLeaves(client, database, guildId) {
  const { autoSubtractLeaveThreshold: threshold } = await getInviteSettings(database, guildId);

  return rewriteJoins(database, guildId, (joins) => {
    let changed = 0;
    const next = joins.map((join) => {
      if (join.invalidatedReason && join.invalidatedReason !== 'leave') return join;
      const lost = Boolean(join.leftAt) && Math.trunc((join.leftAt - join.createdAt) / 1000) <= threshold;
      const reason = lost ? 'leave' : null;
      if (reason === (join.invalidatedReason ?? null)) return join;
      changed += 1;
      return { ...join, invalidatedReason: reason };
    });
    return changed ? { joins: next, changed } : null;
  });
}

/** Adiciona (ou remove, se negativo) convites bônus. Retorna o novo total do membro. */
export async function addBonusInvites(database, guildId, user, creatorId, amount, reason) {
  if (!Number.isInteger(amount) || amount === 0) throw new InviteError('A quantidade precisa ser um número inteiro diferente de zero.');
  if (Math.abs(amount) > MAX_BONUS_AMOUNT) throw new InviteError('O número informado é grande demais.');

  const text = String(reason ?? '').trim().slice(0, 300);
  await database.InviteMembers.mutate(guildId, user.id, (current) => ({
    name: user.username ?? current.name,
    bonus: [...current.bonus, { id: randomUUID().slice(0, 8), amount, reason: text || null, creatorId, createdAt: Date.now(), cleared: false }],
  }));

  invalidateCounts(guildId);
  return (await getInviteCounts(database, guildId, user.id)).total;
}

/**
 * Zera os convites de um membro (ou de todos, se `userId` for null).
 * Sem `clearBonus` os convites bônus são mantidos (igual à referência).
 */
export async function clearInvites(database, guildId, userId, { clearBonus = false } = {}) {
  const codes = await database.InviteCodes.list(guildId);
  const targetCodes = new Set(codes.filter((code) => !userId || code.inviterId === userId).map((code) => code.code));

  for (const code of targetCodes) {
    await database.InviteCodes.mutate(guildId, code, (current) => ({ clearedAmount: current.uses }));
  }

  const members = await database.InviteMembers.list(guildId);
  for (const member of members) {
    const isTarget = !userId || member.userId === userId;
    await database.InviteMembers.mutate(guildId, member.userId, (current) => ({
      joins: current.joins.map((join) => (targetCodes.has(join.code) ? { ...join, cleared: true } : join)),
      bonus: isTarget ? current.bonus.map((bonus) => ({ ...bonus, cleared: clearBonus })) : current.bonus,
    }));
  }

  invalidateCounts(guildId);
}

/** Desfaz o `clearInvites`: convites, entradas e bônus voltam a contar. */
export async function restoreInvites(database, guildId, userId) {
  const codes = await database.InviteCodes.list(guildId);
  const targetCodes = new Set(codes.filter((code) => !userId || code.inviterId === userId).map((code) => code.code));

  for (const code of targetCodes) {
    await database.InviteCodes.mutate(guildId, code, () => ({ clearedAmount: 0 }));
  }

  const members = await database.InviteMembers.list(guildId);
  for (const member of members) {
    const isTarget = !userId || member.userId === userId;
    await database.InviteMembers.mutate(guildId, member.userId, (current) => ({
      joins: current.joins.map((join) => (targetCodes.has(join.code) ? { ...join, cleared: false } : join)),
      bonus: isTarget ? current.bonus.map((bonus) => ({ ...bonus, cleared: false })) : current.bonus,
    }));
  }

  invalidateCounts(guildId);
}

/** Esconde (ou mostra) um membro no ranking. */
export async function setMemberHidden(database, guildId, user, hidden) {
  await database.InviteMembers.mutate(guildId, user.id, (current) => ({
    name: user.username ?? current.name,
    hideFromLeaderboard: Boolean(hidden),
  }));
  invalidateCounts(guildId);
}

/** Dá um nome a um código de convite (null remove o nome). */
export async function setInviteCodeName(database, guildId, code, name) {
  const text = name === null ? null : String(name).trim().slice(0, 100);
  if (name !== null && !text) throw new InviteError('O nome não pode ficar vazio.');

  const updated = await database.InviteCodes.mutate(guildId, code, () => ({ name: text }));
  if (!updated) throw new InviteError('Esse código de convite não pertence a este servidor (ou ainda não foi registrado).');
  rememberCode(guildId, updated);
  return updated;
}

/** Link completo de um código de convite, na base de convites da instância do bot. */
export function inviteLink(client, code) {
  try {
    return inviteUrl(client.instance.endpoints.invite, code);
  } catch {
    return code;
  }
}

/* -------------------------------------------------------------------------- */
/* Tracker: descobre qual convite foi usado                                   */
/* -------------------------------------------------------------------------- */

const JOIN_MESSAGES = {
  joinUnknownInviter: (userId) => `Não consegui descobrir como <@${userId}> entrou no servidor.`,
  joinVanityUrl: (userId) => `<@${userId}> entrou no servidor usando o link personalizado (vanity).`,
  joinServerWidget: () => 'O usuário entrou usando o widget do servidor.',
  leaveUnknownInviter: (tag) => `${tag} saiu do servidor, mas não consegui descobrir quem o convidou.`,
};

/** Convite do Fluxer.js -> formato interno (equivalente ao ChannelInvite da referência). */
function normalizeInvite(invite, guildId) {
  return {
    code: invite.code,
    guildId: guildId ?? invite.guildSnapshot?.id ?? null,
    channel: invite.channelSnapshot ? { id: invite.channelSnapshot.id, name: invite.channelSnapshot.name ?? null } : null,
    inviter: invite.inviter ?? null,
    uses: invite.uses ?? 0,
    maxUses: invite.maxUses ?? 0,
    maxAge: invite.maxAge ?? 0,
    temporary: Boolean(invite.temporary),
    createdAt: invite.createdAt ? toMs(invite.createdAt) : null,
    vanity: false,
  };
}

function storeFrom(invs) {
  return new Map(invs.map((inv) => [inv.code, { uses: inv.uses, maxUses: inv.maxUses }]));
}

/** Busca os convites ativos do servidor. Retorna null se falhar (nesse caso o snapshot anterior é mantido). */
async function fetchInvites(guild) {
  try {
    const invites = await guild.fetchInvites();
    return [...(invites.values?.() ?? invites)].map((invite) => normalizeInvite(invite, guild.id));
  } catch (error) {
    console.error(INVITES_PREFIX, `Falha ao buscar os convites de ${guild.id}:`, error?.message ?? error);
    return null;
  }
}

/** Quais códigos foram usados entre dois snapshots. */
function compareInvites(oldStore, newStore) {
  const used = [];
  for (const [code, current] of newStore) {
    const previous = oldStore.get(code);
    // Convites novos e sem uso são ignorados
    if (current.uses !== 0 && (!previous || previous.uses < current.uses)) used.push(code);
  }

  // Só olha o "máximo de usos" se nenhum outro foi encontrado: um convite que sumiu da lista na última vaga
  if (!used.length) {
    for (const [code, previous] of oldStore) {
      if (!newStore.has(code) && previous.uses === previous.maxUses - 1) used.push(code);
    }
  }
  return used;
}

/** Convites criados e usados entre dois snapshots só aparecem no registro de auditoria. */
async function findCodesFromAuditLog(guild, newStore, lastUpdate) {
  if (lastUpdate === undefined) return [];
  if (!(await botHasPermission(guild, PermissionFlags.ViewAuditLog))) return [];

  let logs;
  try {
    logs = await guild.fetchAuditLogs({ limit: 50, actionType: AuditLogActionType.InviteCreate });
  } catch {
    return [];
  }
  if (!logs?.entries?.length) return [];

  const users = new Map((logs.users ?? []).map((user) => [user.id, user]));
  const created = [];
  for (const entry of logs.entries) {
    try {
      const after = {};
      for (const change of entry.changes ?? []) after[change.key] = change.newValue ?? change.oldValue;

      const code = after.code ?? entry.targetId;
      const createdAt = snowflakeTimestamp(entry.id);
      if (!code || createdAt <= lastUpdate || newStore.has(code)) continue;

      const channelId = after.channel_id ?? after.channelId ?? entry.options?.channel_id ?? null;
      created.push({
        code,
        guildId: guild.id,
        channel: channelId ? { id: channelId, name: guild.channels.get(channelId)?.name ?? null } : null,
        inviter: entry.userId ? users.get(entry.userId) ?? { id: entry.userId, username: 'Desconhecido' } : null,
        uses: Number(after.uses ?? 0) + 1,
        maxUses: Number(after.max_uses ?? after.maxUses ?? 0),
        maxAge: Number(after.max_age ?? after.maxAge ?? 0),
        temporary: Boolean(after.temporary),
        createdAt,
        vanity: false,
      });
    } catch (error) {
      console.warn(INVITES_PREFIX, 'Entrada do registro de auditoria ignorada:', error?.message ?? error);
    }
  }
  return created;
}

async function getVanityCode(guild) {
  const cached = vanityCache.get(guild.id);
  if (cached && cached.expiresAt > Date.now()) return cached.code;

  let code = null;
  try {
    code = (await guild.fetchVanityURL())?.code ?? null;
  } catch {
    code = guild.vanityURLCode ?? null;
  }
  vanityCache.set(guild.id, { code, expiresAt: Date.now() + (code ? VANITY_TTL_MS : VANITY_MISS_TTL_MS) });
  return code;
}

function codeRowFrom(guildId, inv) {
  return {
    guildId,
    code: inv.code,
    channelId: inv.channel?.id ?? null,
    channelName: inv.channel?.name ?? null,
    inviterId: inv.inviter?.id ?? null,
    inviterName: inv.inviter?.username ?? null,
    name: null,
    uses: inv.uses ?? 0,
    maxUses: inv.maxUses ?? 0,
    maxAge: inv.maxAge ?? 0,
    temporary: Boolean(inv.temporary),
    createdAt: inv.createdAt ?? Date.now(),
    clearedAmount: 0,
    isVanity: Boolean(inv.vanity),
    isWidget: !inv.inviter && !inv.vanity,
  };
}

/** Grava os convites; de um código que já existe só o número de usos é atualizado (igual à referência). */
async function saveInviteCodes(database, guildId, invs) {
  for (const inv of invs) {
    const state = getState(guildId);
    const existing = state.codes?.get(inv.code) ?? (await database.InviteCodes.get(guildId, inv.code));

    let row;
    if (!existing) row = await database.InviteCodes.save(codeRowFrom(guildId, inv));
    else if (existing.uses !== inv.uses) row = await database.InviteCodes.update(guildId, inv.code, { uses: inv.uses });
    else row = existing;

    if (row) rememberCode(guildId, row);
  }
}

/** Códigos que sumiram da lista (último uso): só soma 1 no banco. */
async function incrementCodeUses(database, guildId, codes) {
  for (const code of codes) {
    const row = await database.InviteCodes.mutate(guildId, code, (current) => ({ uses: current.uses + 1 }));
    if (row) rememberCode(guildId, row);
  }
}

/** Atualiza o snapshot de convites de um servidor (ao ligar, ao entrar em um servidor novo ou quando ele volta). */
export async function syncGuildInvites(client, database, guild, { force = true } = {}) {
  if (!force && Date.now() - (inviteStoreUpdatedAt.get(guild.id) ?? 0) < RESYNC_SKIP_MS) return;
  if (!(await isGuildTracked(client, database, guild.id))) return;

  try {
    await withGuildQueue(guild.id, async () => {
      if (!(await botHasPermission(guild, PermissionFlags.ManageGuild))) {
        console.warn(INVITES_PREFIX, `O bot não tem "Gerenciar Servidor" em ${guild.name ?? guild.id}; não vou conseguir ver os convites.`);
        return;
      }

      const invs = await fetchInvites(guild);
      if (!invs) return; // falhou: mantém o snapshot anterior

      inviteStore.set(guild.id, storeFrom(invs));
      inviteStoreUpdatedAt.set(guild.id, Date.now());
      await saveInviteCodes(database, guild.id, invs);
    });
  } catch (error) {
    console.error(INVITES_PREFIX, `Erro ao sincronizar os convites de ${guild.id}:`, error);
  }
}

/** Chamado quando o bot liga: carrega os usos conhecidos e confere os convites de cada servidor. */
export async function initializeInvites(client, database) {
  const todas = [...client.guilds.values()].sort((a, b) => (b.memberCount ?? 0) - (a.memberCount ?? 0));
  const guilds = [];
  for (const guild of todas) {
    if (await isGuildTracked(client, database, guild.id)) guilds.push(guild);
  }
  if (!guilds.length) return;

  console.info(INVITES_PREFIX, `Sincronizando os convites de ${guilds.length} servidor(es)...`);

  // Primeiro o que o banco já sabe (usos de antes do bot ligar); depois a API atualiza
  for (const guild of guilds) {
    if (inviteStore.has(guild.id)) continue;
    const codes = await database.InviteCodes.list(guild.id);
    inviteStore.set(guild.id, new Map(codes.map((code) => [code.code, { uses: code.uses, maxUses: code.maxUses }])));
  }

  const queue = [...guilds];
  const parallel = client.brain?.config?.inviteConfig?.guildsInParallel ?? 5;
  const worker = async () => {
    for (let guild = queue.shift(); guild; guild = queue.shift()) {
      await syncGuildInvites(client, database, guild);
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, guilds.length) }, worker));
  console.success(INVITES_PREFIX, 'Convites sincronizados.');
}

/** Alguém criou um convite: registra o código no banco (o snapshot do tracker não é alterado). */
export async function handleInviteCreate(client, database, invite) {
  const guildId = invite?.guildSnapshot?.id;
  if (!guildId || !(await isGuildTracked(client, database, guildId))) return;
  try {
    await saveInviteCodes(database, guildId, [normalizeInvite(invite, guildId)]);
  } catch (error) {
    console.error(INVITES_PREFIX, `Erro ao registrar o convite ${invite.code}:`, error);
  }
}

/* -------------------------------------------------------------------------- */
/* Entrada e saída de membros                                                 */
/* -------------------------------------------------------------------------- */

/** Compara a lista de entradas antes/depois de uma mudança e reflete no resumo o que passou a ser (ou deixou de ser) fake/saída. */
function rememberInvalidationChanges(guildId, before, after) {
  const previous = new Map(before.map((join) => [join.id, join]));
  for (const join of after) {
    const old = previous.get(join.id);
    if (old && (old.invalidatedReason ?? null) !== (join.invalidatedReason ?? null)) {
      rememberInvalidation(guildId, join, old.invalidatedReason ?? null, join.invalidatedReason ?? null);
    }
  }
}

export function handleMemberJoin(client, database, member) {
  const guild = member.guild;
  return withGuildQueue(guild.id, () => processMemberJoin(client, database, guild, member)).catch((error) => {
    console.error(INVITES_PREFIX, `Erro ao processar a entrada de ${member.id} em ${guild.id}:`, error);
  });
}

export function handleMemberLeave(client, database, member) {
  const guild = member.guild;
  return withGuildQueue(guild.id, () => processMemberLeave(client, database, guild, member)).catch((error) => {
    console.error(INVITES_PREFIX, `Erro ao processar a saída de ${member.id} em ${guild.id}:`, error);
  });
}

async function processMemberJoin(client, database, guild, member) {
  const user = member.user;
  if (!user || user.bot) return;
  if (!(await isGuildTracked(client, database, guild.id))) return;

  if (!(await botHasPermission(guild, PermissionFlags.ManageGuild))) {
    console.warn(INVITES_PREFIX, `O bot não tem "Gerenciar Servidor" em ${guild.id}; entrada de ${user.id} não registrada.`);
    return;
  }

  const sets = await getInviteSettings(database, guild.id);

  let invs = await fetchInvites(guild);
  if (!invs) return; // sem dados confiáveis: mantém o snapshot antigo

  const lastUpdate = inviteStoreUpdatedAt.get(guild.id);
  const newStore = storeFrom(invs);
  const oldStore = inviteStore.get(guild.id);
  inviteStore.set(guild.id, newStore);
  inviteStoreUpdatedAt.set(guild.id, Date.now());

  if (!oldStore) {
    // Sem base de comparação não dá para saber qual convite foi usado nesta entrada
    console.warn(INVITES_PREFIX, `Sem snapshot de convites em ${guild.id} ao adicionar ${user.id}.`);
    await saveInviteCodes(database, guild.id, invs);
    return;
  }

  let inviteCodesUsed = compareInvites(oldStore, newStore);

  if (!inviteCodesUsed.length) {
    const created = await findCodesFromAuditLog(guild, newStore, lastUpdate);
    if (created.length) {
      inviteCodesUsed = created.map((inv) => inv.code);
      invs = invs.concat(created);
    }
  }

  let isVanity = false;
  if (!inviteCodesUsed.length) {
    const vanityCode = await getVanityCode(guild);
    if (vanityCode) {
      isVanity = true;
      inviteCodesUsed.push(vanityCode);
      invs.push({ code: vanityCode, guildId: guild.id, channel: null, inviter: null, uses: 0, maxUses: 0, maxAge: 0, temporary: false, createdAt: null, vanity: true });
    }
  }

  if (!inviteCodesUsed.length) {
    console.warn(INVITES_PREFIX, `Nenhum convite usado encontrado: servidor ${guild.id}, membro ${user.id}.`);
  }
  const exactMatchCode = inviteCodesUsed.length === 1 ? inviteCodesUsed[0] : null;

  // Códigos usados e todos os novos vão para o banco; um código que sumiu da lista só soma 1 uso
  const vanished = [];
  const toSave = inviteCodesUsed
    .map((code) => {
      const inv = invs.find((item) => item.code === code);
      if (!inv) vanished.push(code);
      return inv;
    })
    .filter(Boolean)
    .concat(invs.filter((inv) => !oldStore.has(inv.code)));

  await incrementCodeUses(database, guild.id, vanished);
  await saveInviteCodes(database, guild.id, [...new Map(toSave.map((inv) => [inv.code, inv])).values()]);

  const invite = toSave.find((inv) => inv.code === exactMatchCode) ?? null;
  const applyFakes = Boolean(invite) && !isVanity && sets.autoSubtractFakes;

  // Registra a entrada e aplica as regras de saída/fake no histórico deste membro (tudo de uma vez)
  let before = [];
  let after = [];
  await database.InviteMembers.mutate(guild.id, user.id, (current) => {
    before = current.joins;
    let joins = [...current.joins];
    let changed = false;

    const entry = exactMatchCode
      ? { id: randomUUID().slice(0, 8), code: exactMatchCode, createdAt: toMs(member.joinedAt ?? Date.now()), leftAt: null, invalidatedReason: null, cleared: false }
      : null;
    if (entry) {
      joins.push(entry);
      changed = true;
    }

    // Quem voltou deixa de ter a saída anterior descontada
    if (sets.autoSubtractLeaves && joins.some((join) => join.invalidatedReason === 'leave')) {
      joins = joins.map((join) => (join.invalidatedReason === 'leave' ? { ...join, invalidatedReason: null } : join));
      changed = true;
    }

    // Entradas anteriores pelo mesmo caminho viram fake: só a mais recente vale
    if (applyFakes && joins.some((join) => join.id !== entry?.id && !join.invalidatedReason)) {
      joins = joins.map((join) => (join.id !== entry?.id && !join.invalidatedReason ? { ...join, invalidatedReason: 'fake' } : join));
      changed = true;
    }

    after = joins;
    return changed ? { name: user.username ?? current.name, joins } : null;
  });
  rememberInvalidationChanges(guild.id, before, after);

  const joinChannel = await resolveMessageChannel(client, database, guild, 'joinMessageChannel', sets.joinMessageChannel);

  // Não achamos o convite / entrou pelo vanity
  if (!invite) {
    if (joinChannel) await sendTemplate(client, database, guild.id, 'joinMessageChannel', joinChannel, JOIN_MESSAGES.joinUnknownInviter(user.id));
    return;
  }
  if (isVanity) {
    if (joinChannel) await sendTemplate(client, database, guild.id, 'joinMessageChannel', joinChannel, JOIN_MESSAGES.joinVanityUrl(user.id));
    return;
  }

  // Convites criados pelo bot (`invites criar`) aparecem na API como "do bot": o crédito é de quem o banco registrou
  let inviterUser = invite.inviter;
  const stored = await database.InviteCodes.get(guild.id, exactMatchCode);
  if (stored?.inviterId && stored.inviterId !== inviterUser?.id) {
    inviterUser = guild.members.get(stored.inviterId)?.user
      ?? (await client.users.fetch(stored.inviterId).catch(() => null))
      ?? inviterUser;
  }

  if (!inviterUser) {
    if (joinChannel) await sendTemplate(client, database, guild.id, 'joinMessageChannel', joinChannel, JOIN_MESSAGES.joinServerWidget());
    return;
  }

  if (!joinChannel || !sets.joinMessage) return;

  const counts = await getInviteCounts(database, guild.id, inviterUser.id);
  const inviter = guild.members.get(inviterUser.id) ?? (await guild.fetchMember(inviterUser.id).catch(() => null)) ?? { user: inviterUser };
  const message = await fillJoinLeaveTemplate(database, sets.joinMessage, guild, member, counts, {
    invite: { code: exactMatchCode, channel: invite.channel ?? (stored?.channelId ? { id: stored.channelId, name: stored.channelName } : null) },
    inviter,
  });
  await sendTemplate(client, database, guild.id, 'joinMessageChannel', joinChannel, message);
}

async function processMemberLeave(client, database, guild, member) {
  const user = member.user;
  if (!user || user.bot) return;
  if (!(await isGuildTracked(client, database, guild.id))) return;

  const sets = await getInviteSettings(database, guild.id);

  // Entrada mais recente deste membro (e o código usado nela)
  const row = await database.InviteMembers.get(guild.id, user.id);
  let join = null;
  let code = null;
  for (const candidate of [...(row?.joins ?? [])].sort((a, b) => b.createdAt - a.createdAt)) {
    code = await database.InviteCodes.get(guild.id, candidate.code);
    if (code) {
      join = candidate;
      break;
    }
  }

  // Marca a saída e, se foi rápida o bastante, desconta o convite
  let before = [];
  let after = [];
  if (join) {
    const elapsed = Math.trunc((Date.now() - join.createdAt) / 1000);
    await database.InviteMembers.mutate(guild.id, user.id, (current) => {
      before = current.joins;
      after = current.joins.map((item) => {
        if (item.id !== join.id) return item;
        const next = { ...item, leftAt: item.leftAt ?? Date.now() };
        if (sets.autoSubtractLeaves && code.inviterId && !item.invalidatedReason && elapsed < Number(sets.autoSubtractLeaveThreshold)) {
          next.invalidatedReason = 'leave';
        }
        return next;
      });
      return { name: user.username ?? current.name, joins: after };
    });
    rememberInvalidationChanges(guild.id, before, after);
  }

  const leaveChannel = await resolveMessageChannel(client, database, guild, 'leaveMessageChannel', sets.leaveMessageChannel);

  // Sem entrada conhecida (ou entrada pelo vanity/widget, sem quem convidou)
  if (!join || !code?.inviterId) {
    if (leaveChannel) await sendTemplate(client, database, guild.id, 'leaveMessageChannel', leaveChannel, JOIN_MESSAGES.leaveUnknownInviter(userTag(user)));
    return;
  }

  if (!leaveChannel || !sets.leaveMessage) return;

  const counts = await getInviteCounts(database, guild.id, code.inviterId);
  const inviter = guild.members.get(code.inviterId)
    ?? (await guild.fetchMember(code.inviterId).catch(() => null))
    ?? { user: client.users.get(code.inviterId) ?? { id: code.inviterId, username: code.inviterName ?? 'Desconhecido', discriminator: null, avatarURL: null } };
  const channel = guild.channels.get(code.channelId);
  const message = await fillJoinLeaveTemplate(database, sets.leaveMessage, guild, member, counts, {
    invite: { code: code.code, channel: { id: code.channelId, name: channel?.name ?? code.channelName } },
    inviter,
  });
  await sendTemplate(client, database, guild.id, 'leaveMessageChannel', leaveChannel, message);
}

/* -------------------------------------------------------------------------- */
/* Códigos de convite                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Cria um código de convite com nome. O crédito das entradas por ele fica com quem executou o comando
 * (e não com o bot, que é quem a API registra como criador).
 */
export async function createInviteCode(client, database, { guild, channel, creator, name, maxUses = 0, expires = false, temporary = false }) {
  const label = String(name ?? '').trim();
  if (!label) throw new InviteError('Informe o nome do convite.');
  if (label.length > 100) throw new InviteError('O nome do convite pode ter no máximo 100 caracteres.');
  if (!isTextChannel(channel) || channel.guildId !== guild.id) throw new InviteError('O canal precisa ser um canal de texto deste servidor.');
  if (!Number.isInteger(maxUses) || maxUses < 0 || maxUses > 100) throw new InviteError('O número máximo de usos deve ser um inteiro entre 0 e 100 (0 = ilimitado).');

  const me = await getBotMember(guild);
  if (me && !me.permissionsIn(channel).has(PermissionFlags.CreateInstantInvite)) {
    throw new InviteError('Não tenho a permissão **Criar Convite** nesse canal.');
  }

  const maxAge = expires ? 24 * 60 * 60 : 0; // quando expira, dura 24h
  let invite;
  try {
    invite = await channel.createInvite({ maxAge, maxUses, temporary, unique: true });
  } catch (error) {
    throw new InviteError(`Não consegui criar o convite: ${error?.message ?? 'erro desconhecido'}`);
  }

  const row = {
    ...codeRowFrom(guild.id, { ...normalizeInvite(invite, guild.id), inviter: creator, channel: { id: channel.id, name: channel.name ?? null }, maxAge, maxUses, temporary, uses: 0 }),
    name: label,
  };
  await database.InviteCodes.save(row);
  rememberCode(guild.id, row);
  return { code: row.code, link: inviteLink(client, row.code), row };
}

/**
 * Códigos ativos de um membro (os que ainda não expiraram). Códigos que existem no servidor mas ainda
 * não estavam no banco (nunca foram usados) são registrados agora.
 */
export async function listActiveMemberCodes(client, database, guild, userId) {
  const invites = await guild.fetchInvites().catch(() => []);
  const active = [...(invites.values?.() ?? invites)]
    .map((invite) => normalizeInvite(invite, guild.id))
    .filter((inv) => inv.inviter?.id === userId);
  await saveInviteCodes(database, guild.id, active);

  const now = Date.now();
  const valid = (await getMemberCodes(database, guild.id, userId)).filter((code) => code.maxAge === 0 || code.createdAt + code.maxAge * 1000 > now);
  const permanent = valid.filter((code) => code.maxAge === 0);
  return {
    permanent,
    temporary: valid.filter((code) => code.maxAge > 0),
    recommended: permanent.reduce((best, code) => (!best || code.uses > best.uses ? code : best), null),
  };
}

/* -------------------------------------------------------------------------- */
/* Gráfico e exportação                                                       */
/* -------------------------------------------------------------------------- */

let chartReady = null;

/** O gráfico usa bibliotecas pesadas: só são carregadas quando alguém pede um gráfico. */
async function loadChartLibraries() {
  if (!chartReady) {
    chartReady = (async () => {
      const [{ createCanvas, GlobalFonts }, { Chart, registerables }, { createRequire }] = await Promise.all([
        import('@napi-rs/canvas'),
        import('chart.js'),
        import('node:module'),
      ]);
      Chart.register(...registerables);
      // A fonte vem embutida (@fontsource/roboto) para funcionar em servidores sem fontes instaladas
      GlobalFonts.registerFromPath(createRequire(import.meta.url).resolve('@fontsource/roboto/files/roboto-latin-700-normal.woff'), 'InvitesChartFont');
      return { createCanvas, Chart };
    })().catch((error) => {
      chartReady = null;
      throw new InviteError(`Não consegui carregar o gerador de gráficos (${error.code ?? error.message}). Confira se as dependências foram instaladas.`);
    });
  }
  return chartReady;
}

async function renderChart(labels, datasets) {
  const { createCanvas, Chart } = await loadChartLibraries();
  const canvas = createCanvas(1000, 400);
  const font = { family: 'InvitesChartFont', weight: 'bold' };

  const whiteBackground = {
    id: 'whiteBackground',
    beforeDraw(chart) {
      chart.ctx.save();
      chart.ctx.fillStyle = 'white';
      chart.ctx.fillRect(0, 0, chart.width, chart.height);
      chart.ctx.restore();
    },
  };

  // Mostra o valor no primeiro/último ponto e onde o valor muda
  const valueLabels = {
    id: 'valueLabels',
    afterDatasetsDraw(chart) {
      chart.data.datasets.forEach((dataset, datasetIndex) => {
        const meta = chart.getDatasetMeta(datasetIndex);
        chart.ctx.save();
        chart.ctx.font = `bold 12px InvitesChartFont`;
        chart.ctx.fillStyle = dataset.borderColor;
        chart.ctx.textAlign = 'center';
        chart.ctx.textBaseline = 'bottom';
        dataset.data.forEach((value, index, data) => {
          const show = index === 0 || index === data.length - 1 || (value !== 0 && (value !== data[index - 1] || value !== data[index + 1]));
          if (show) chart.ctx.fillText(String(value), meta.data[index].x, meta.data[index].y - 6);
        });
        chart.ctx.restore();
      });
    },
  };

  const chart = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: false,
      animation: false,
      devicePixelRatio: 1,
      layout: { padding: { top: 24, right: 32 } },
      plugins: { legend: { display: false } },
      scales: {
        y: { beginAtZero: true, ticks: { precision: 0, maxTicksLimit: 5, color: 'black', font } },
        x: { ticks: { color: 'black', font, maxRotation: 45, autoSkip: true } },
      },
    },
    plugins: [whiteBackground, valueLabels],
  });

  const buffer = canvas.toBuffer('image/png');
  chart.destroy();
  return buffer;
}

export const GRAPH_TYPES = ['joins', 'leaves', 'joinsAndLeaves'];

/**
 * Gráfico de entradas e/ou saídas por dia. `from`/`to` em ms; os dias são calculados no fuso configurado.
 * Retorna { buffer (PNG), title, description }.
 */
export async function renderInviteGraph(client, database, guildId, { type, from, to }) {
  if (!GRAPH_TYPES.includes(type)) throw new InviteError(`Tipo de gráfico inválido. Opções: ${GRAPH_TYPES.map((t) => `\`${t}\``).join(', ')}.`);

  const days = Math.floor((to - from) / DAY_MS);
  if (days < MIN_GRAPH_DAYS) throw new InviteError(`Você precisa selecionar pelo menos ${MIN_GRAPH_DAYS} dias.`);
  if (days > MAX_GRAPH_DAYS) throw new InviteError(`Você pode selecionar no máximo ${MAX_GRAPH_DAYS} dias.`);

  const timeZone = client.brain?.config?.inviteConfig?.timezone ?? 'America/Sao_Paulo';
  const formatter = new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const dayKey = (ms) => formatter.format(new Date(ms));

  // Um grupo por dia. Passo de 6h para nunca pular um dia por causa do fuso.
  const keys = [];
  for (let t = from; t <= to; t += 6 * 3_600_000) {
    const key = dayKey(t);
    if (!keys.includes(key)) keys.push(key);
  }
  if (!keys.includes(dayKey(to))) keys.push(dayKey(to));

  const members = await database.InviteMembers.list(guildId);
  const countByDay = (timestamps) => {
    const counts = new Map(keys.map((key) => [key, 0]));
    for (const ts of timestamps) {
      const key = dayKey(ts);
      if (counts.has(key)) counts.set(key, counts.get(key) + 1);
    }
    return keys.map((key) => counts.get(key));
  };
  const joins = members.flatMap((member) => member.joins.map((join) => join.createdAt));
  const leaves = members.flatMap((member) => member.joins.filter((join) => join.leftAt).map((join) => join.leftAt));

  const series = [];
  let title;
  let description;
  if (type === 'joinsAndLeaves') {
    title = 'Entradas e saídas de usuários';
    description = 'Este gráfico mostra a quantidade de usuários que entram (azul) e saem (vermelho) do servidor.';
    series.push(countByDay(joins), countByDay(leaves));
  } else if (type === 'joins') {
    title = 'Entrada de usuários';
    description = 'Este gráfico mostra a quantidade de usuários que entram no servidor.';
    series.push(countByDay(joins));
  } else {
    title = 'Saída de usuários';
    description = 'Este gráfico mostra a quantidade de usuários que saem do servidor.';
    series.push(countByDay(leaves));
  }

  const colors = ['blue', 'red'];
  const buffer = await renderChart(
    keys.map((key) => key.split('-').reverse().join('.')),
    series.map((data, index) => ({ label: 'Dados', data, borderColor: colors[index], backgroundColor: colors[index], pointRadius: 1, borderWidth: 2, fill: false })),
  );
  return { buffer, title, description };
}

/** Ranking completo em CSV (para o comando de exportação). */
export async function buildLeaderboardCsv(client, database, guildId) {
  const escape = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  let csv = 'Id,Name,Total Invites,Regular,Custom,Fake,Leaves\n';
  for (const entry of await generateLeaderboard(client, database, guildId)) {
    csv += `${entry.id},${escape(entry.name)},${entry.total},${entry.regular},${entry.custom},${entry.fakes},${entry.leaves}\n`;
  }
  return csv;
}

export { EMBED_COLOR, safeText, stamp, humanizeDuration, userTag, userCreatedAt };
