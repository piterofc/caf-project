import { randomInt, randomUUID } from 'node:crypto';
import { EmbedBuilder } from '@fluxerjs/core';

import { GIVEAWAY_PREFIX } from '../utils/loggerPrefixes.js';

const ENTRY_EMOJI = '🎉';
const MIN_DURATION_MS = 10 * 1000;
const MAX_DURATION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_WINNERS = 100;
const MAX_PUBLISH_ATTEMPTS = 3;
const STUCK_AFTER_MS = 2 * 60 * 1000; // tempo até considerar uma operação interrompida (ex.: o bot caiu no meio)
const ID_REGEX = /^\d{15,21}$/;
const REACTION_PAGE_SIZE = 100;
const MAX_REACTION_PAGES = 100; // teto de segurança (10 mil reações) para nunca ficar em loop
const MAX_SYNC_ATTEMPTS = 3;

// Giveaways cujas reações já foram conferidas desde que o bot ligou (a memória zera a cada reinício, que é o desejado)
const syncedGiveaways = new Set();
const syncAttempts = new Map();

/** Erro "esperado" (mensagem já é amigável e pode ser mostrada ao usuário). */
export class GiveawayError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GiveawayError';
  }
}

/* -------------------------------------------------------------------------- */
/* Utilitários                                                                */
/* -------------------------------------------------------------------------- */

function isBlank(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

function asPositiveInteger(value, fallback = 1) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function toTimestamp(value, label) {
  const timestamp = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new GiveawayError(`${label} inválida.`);
  return timestamp;
}

function normalizeText(value, fallback, maxLength) {
  return String(value ?? fallback ?? '').trim().slice(0, maxLength);
}

/** Valida um ID (cargo, usuário, canal). Retorna a string do ID, ou null se vazio. */
function normalizeId(value, label) {
  if (isBlank(value)) return null;
  const id = String(value).trim();
  if (!ID_REGEX.test(id)) throw new GiveawayError(`${label} inválido. Use o ID numérico ou uma menção.`);
  return id;
}

/** Evita que o prêmio/título digitado por alguém vire um @everyone/menção dentro de uma mensagem do bot. */
function safeText(value) {
  return String(value ?? '')
    .replace(/@(everyone|here)/gi, '@\u200b$1')
    .replace(/<@/g, '<@\u200b');
}

export function shortId(id) {
  return String(id ?? '').slice(0, 8);
}

function shuffle(items) {
  const array = [...items];
  for (let index = array.length - 1; index > 0; index -= 1) {
    const other = randomInt(index + 1);
    [array[index], array[other]] = [array[other], array[index]];
  }
  return array;
}

function memberHasRole(member, roleId) {
  const roleIds = member?.roles?.roleIds;
  if (Array.isArray(roleIds)) return roleIds.includes(roleId);
  return Boolean(member?.roles?.cache?.has?.(roleId));
}

function isTextChannel(channel) {
  if (!channel) return false;
  if (typeof channel.isTextBased === 'function') return channel.isTextBased() && typeof channel.send === 'function';
  return typeof channel.send === 'function';
}

function getChannel(client, guildId, channelId) {
  const channel = client.guilds.cache.get(guildId)?.channels.cache.get(channelId);
  return isTextChannel(channel) ? channel : null;
}

async function fetchMessage(channel, messageId) {
  if (!channel || !messageId) return null;
  return channel.messages.fetch(messageId).catch(() => null);
}

/* -------------------------------------------------------------------------- */
/* Validação / normalização                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Valida os dados de um novo giveaway e calcula as datas.
 * `defaults` serve para modelos (templates): só valem para o que não foi informado.
 */
export function normalizeGiveaway(input, defaults = {}) {
  const now = Date.now();

  if (!isBlank(input.duration) && !isBlank(input.endAt)) {
    throw new GiveawayError('Informe duração ou data de encerramento, não as duas.');
  }

  // Início: sem data (ou data no passado) significa "agora"
  const requestedStart = isBlank(input.startAt) ? now : toTimestamp(input.startAt, 'Data de início');
  const startAt = Math.max(requestedStart, now);

  // Fim: data explícita ou início + duração
  let endAt;
  if (!isBlank(input.endAt)) {
    endAt = toTimestamp(input.endAt, 'Data de encerramento');
  } else {
    const rawDuration = isBlank(input.duration) ? defaults.duration ?? 3600 : input.duration;
    const seconds = Number(rawDuration);
    if (!Number.isFinite(seconds) || seconds <= 0) throw new GiveawayError('Duração inválida.');
    endAt = startAt + Math.round(seconds * 1000);
  }

  if (endAt <= now) throw new GiveawayError('A data de encerramento precisa estar no futuro.');
  if (endAt <= startAt) throw new GiveawayError('A data de encerramento precisa ocorrer depois do início.');
  const durationMs = endAt - startAt;
  if (durationMs < MIN_DURATION_MS) throw new GiveawayError('A duração mínima de um giveaway é 10 segundos.');
  if (durationMs > MAX_DURATION_MS) throw new GiveawayError('A duração máxima de um giveaway é 30 dias.');

  const rawWinners = isBlank(input.winners) ? defaults.winners ?? 1 : input.winners;
  const winners = Number(rawWinners);
  if (!Number.isInteger(winners) || winners < 1 || winners > MAX_WINNERS) {
    throw new GiveawayError(`O número de ganhadores deve ser um inteiro entre 1 e ${MAX_WINNERS}.`);
  }

  const prize = normalizeText(isBlank(input.prize) ? defaults.prize : input.prize, '', 256);
  if (!prize) throw new GiveawayError('Informe o prêmio do giveaway.');

  return {
    title: normalizeText(isBlank(input.title) ? defaults.title : input.title, 'Giveaway', 256) || 'Giveaway',
    prize,
    description: normalizeText(
      isBlank(input.description) ? defaults.description : input.description,
      'Participe reagindo com 🎉!',
      4000,
    ) || 'Participe reagindo com 🎉!',
    winners,
    duration: Math.round(durationMs / 1000),
    startAt,
    endAt,
    roleId: normalizeId(isBlank(input.roleId) ? defaults.roleId : input.roleId, 'ID de cargo'),
    hostId: normalizeId(isBlank(input.hostId) ? defaults.hostId : input.hostId, 'ID do organizador'),
  };
}

/** Limpa um modelo vindo de fora (importação) deixando só os campos conhecidos. */
export function sanitizeTemplate(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new GiveawayError('O modelo precisa ser um objeto JSON.');
  }

  const template = {};
  if (!isBlank(raw.title)) template.title = normalizeText(raw.title, '', 256);
  if (!isBlank(raw.prize)) template.prize = normalizeText(raw.prize, '', 256);
  if (!isBlank(raw.description)) template.description = normalizeText(raw.description, '', 4000);
  if (!isBlank(raw.winners)) {
    const winners = Number(raw.winners);
    if (!Number.isInteger(winners) || winners < 1 || winners > MAX_WINNERS) {
      throw new GiveawayError(`winners deve ser um inteiro entre 1 e ${MAX_WINNERS}.`);
    }
    template.winners = winners;
  }
  if (!isBlank(raw.duration)) {
    const duration = Number(raw.duration);
    if (!Number.isFinite(duration) || duration * 1000 < MIN_DURATION_MS || duration * 1000 > MAX_DURATION_MS) {
      throw new GiveawayError('duration deve ser um número de segundos entre 10 e 2592000 (30 dias).');
    }
    template.duration = Math.round(duration);
  }
  if (!isBlank(raw.roleId)) template.roleId = normalizeId(raw.roleId, 'roleId');

  if (!Object.keys(template).length) throw new GiveawayError('O modelo não tem nenhum campo válido.');
  return template;
}

/* -------------------------------------------------------------------------- */
/* Embed e mensagens                                                          */
/* -------------------------------------------------------------------------- */

const STATUS_COLORS = {
  ended: '#6b7280',
  cancelled: '#c0392b',
  failed: '#c0392b',
};

function buildEmbed(giveaway, status = giveaway.status) {
  const finished = ['ended', 'cancelled', 'failed'].includes(status);
  const participation = {
    ended: 'Encerrado',
    cancelled: 'Cancelado',
    failed: 'Cancelado',
    scheduled: 'Em breve',
  }[status] ?? `Reaja com ${ENTRY_EMOJI}`;

  const embed = new EmbedBuilder()
    .setTitle(`🎁 ${giveaway.title}`)
    .setDescription(giveaway.description)
    .setColor(STATUS_COLORS[status] ?? '#9b59b6')
    .addFields(
      { name: 'Prêmio', value: giveaway.prize || 'Não informado', inline: false },
      { name: 'Ganhadores', value: String(giveaway.winners), inline: true },
      { name: 'Participação', value: participation, inline: true },
    )
    .setFooter({ text: `ID: ${shortId(giveaway.id)}` });

  if (giveaway.roleId) {
    embed.addFields({ name: 'Cargo elegível', value: `<@&${giveaway.roleId}>`, inline: true });
  }
  if (giveaway.hostId) {
    embed.addFields({ name: 'Organizador', value: `<@${giveaway.hostId}>`, inline: true });
  }

  if (status === 'scheduled') {
    embed.addFields({ name: 'Início', value: `<t:${Math.floor(giveaway.startAt / 1000)}:F>`, inline: false });
  } else if (!finished) {
    const endSeconds = Math.floor(giveaway.endAt / 1000);
    embed.addFields({ name: 'Encerra', value: `<t:${endSeconds}:R> (<t:${endSeconds}:F>)`, inline: false });
  }

  if (status === 'ended') {
    embed.addFields({ name: 'Participantes', value: String(giveaway.entrantCount ?? giveaway.entrants?.length ?? 0), inline: true });
    embed.addFields({
      name: 'Resultado',
      value: giveaway.winnerIds?.length ? giveaway.winnerIds.map((id) => `<@${id}>`).join(', ') : 'Sem ganhadores',
      inline: false,
    });
  }

  return embed;
}

function winnerAnnouncement(winnerIds, prize, prefix = '🎉') {
  const mentions = winnerIds.map((id) => `<@${id}>`).join(', ');
  if (winnerIds.length === 1) {
    return `${prefix} Parabéns ${mentions}! Você ganhou **${safeText(prize)}**.`;
  }
  return `${prefix} Parabéns ${mentions}! Vocês ganharam **${safeText(prize)}**.`;
}

/* -------------------------------------------------------------------------- */
/* Elegibilidade e sorteio                                                    */
/* -------------------------------------------------------------------------- */

/** Erros de "membro não existe" não devem ser confundidos com falhas de rede/API. */
function isUnknownMemberError(error) {
  const text = `${error?.status ?? ''} ${error?.statusCode ?? ''} ${error?.code ?? ''} ${error?.message ?? ''}`;
  return /404|unknown|not found|não encontrad/i.test(text);
}

/**
 * Confere se o usuário ainda pode ganhar: continua no servidor e (se exigido) tem o cargo.
 * Em caso de falha da API que não seja "membro inexistente", dá o benefício da dúvida.
 */
async function isEligible(client, giveaway, userId, { checkMembership = true } = {}) {
  if (!giveaway.roleId && !checkMembership) return true;

  const guild = client.guilds.cache.get(giveaway.guildId);
  if (!guild) return true;

  let member;
  try {
    member = await guild.fetchMember(userId);
  } catch (error) {
    if (isUnknownMemberError(error)) return false;
    console.warn(GIVEAWAY_PREFIX, `Não consegui verificar o membro ${userId}; considerando elegível.`, error?.message);
    return true;
  }

  if (!member) return false;
  if (giveaway.roleId && !memberHasRole(member, giveaway.roleId)) return false;
  return true;
}

/** Sorteia (embaralhamento justo) e só aceita quem ainda é elegível, parando assim que completar a quantidade. */
async function drawWinners(client, giveaway, pool, count) {
  const winners = [];
  for (const userId of shuffle(new Set(pool))) {
    if (winners.length >= count) break;
    if (await isEligible(client, giveaway, userId)) winners.push(userId);
  }
  return winners;
}

/* -------------------------------------------------------------------------- */
/* Busca                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Encontra um giveaway DESTE servidor pelo ID completo, pelo começo do ID (ex.: os 8 primeiros
 * caracteres mostrados no embed) ou pelo ID da mensagem. Retorna null se não existir.
 */
export async function findGiveaway(database, guildId, reference) {
  const query = String(reference ?? '').trim().toLowerCase();
  if (!query) return null;

  const items = await database.Giveaways.list(guildId);
  const exact = items.find((item) => item.id.toLowerCase() === query || item.messageId === query);
  if (exact) return exact;

  if (query.length < 4) return null;
  const matches = items.filter((item) => item.id.toLowerCase().startsWith(query));
  if (matches.length > 1) throw new GiveawayError('Esse começo de ID corresponde a mais de um giveaway. Informe mais caracteres.');
  return matches[0] ?? null;
}

async function findRunningByMessage(database, messageId) {
  const all = await database.Giveaways.getAll();
  return Object.values(all).find((item) => item?.messageId === messageId && item.status === 'running') ?? null;
}

/* -------------------------------------------------------------------------- */
/* Ciclo de vida                                                              */
/* -------------------------------------------------------------------------- */

export async function publishGiveaway(client, database, id) {
  // "Reserva" o giveaway para ninguém mais publicar ao mesmo tempo (evita mensagem duplicada)
  let previousStatus;
  const claimed = await database.Giveaways.mutate(id, (giveaway) => {
    if (!['scheduled', 'pending'].includes(giveaway.status)) return null;
    previousStatus = giveaway.status;
    return { status: 'publishing', statusChangedAt: Date.now() };
  });
  if (!claimed) return database.Giveaways.get(id);

  try {
    const channel = getChannel(client, claimed.guildId, claimed.channelId);
    if (!channel) throw new GiveawayError('Canal do giveaway não encontrado ou sem permissão para enviar mensagens.');

    const message = await channel.send({ embeds: [buildEmbed(claimed, 'running')] });
    try {
      await message.react(ENTRY_EMOJI);
    } catch (error) {
      console.warn(GIVEAWAY_PREFIX, `Não consegui adicionar a reação inicial no giveaway ${shortId(id)}:`, error?.message);
    }

    const published = await database.Giveaways.update(id, {
      status: 'running',
      messageId: message.id,
      startedAt: Date.now(),
    });
    syncedGiveaways.add(id); // publicado com o bot ligado: nenhuma reação foi perdida
    return published;
  } catch (error) {
    const attempts = (claimed.publishAttempts ?? 0) + 1;
    await database.Giveaways.update(id, {
      status: attempts >= MAX_PUBLISH_ATTEMPTS ? 'failed' : previousStatus,
      publishAttempts: attempts,
      lastError: String(error?.message ?? error).slice(0, 300),
    });
    throw error;
  }
}

export async function createGiveaway(client, database, input) {
  if (!input.guildId || !input.channelId) throw new GiveawayError('Servidor e canal são obrigatórios.');
  if (!getChannel(client, input.guildId, input.channelId)) {
    throw new GiveawayError('Canal não encontrado neste servidor ou não permite mensagens.');
  }

  const normalized = normalizeGiveaway(input, input.defaults ?? {});
  const scheduled = normalized.startAt > Date.now() + 1000;

  const giveaway = await database.Giveaways.save({
    id: randomUUID(),
    guildId: input.guildId,
    channelId: input.channelId,
    ...normalized,
    status: scheduled ? 'scheduled' : 'pending',
    createdAt: Date.now(),
    creatorId: input.creatorId || null,
    winnerIds: [],
    entrants: [],
  });

  if (scheduled) return giveaway;

  try {
    return await publishGiveaway(client, database, giveaway.id);
  } catch (error) {
    // Não deixa um giveaway "fantasma" no banco se a publicação falhou
    await database.Giveaways.delete(giveaway.id);
    throw new GiveawayError(`Não consegui publicar o giveaway no canal: ${error.message}`);
  }
}

export async function registerGiveawayEntry(client, database, payload) {
  if (!payload?.messageId || !payload?.userId) return false;
  if (payload.emoji?.name !== ENTRY_EMOJI) return false;
  if (payload.user?.bot || payload.userId === client.user?.id) return false;

  const giveaway = await findRunningByMessage(database, payload.messageId);
  if (!giveaway || Date.now() > giveaway.endAt) return false;

  // Só quem tem o cargo exigido entra (a verificação final acontece de novo no sorteio)
  if (giveaway.roleId && !(await isEligible(client, giveaway, payload.userId, { checkMembership: false }))) {
    return false;
  }

  const updated = await database.Giveaways.mutate(giveaway.id, (current) => {
    const entrants = current.entrants ?? [];
    if (current.status !== 'running' || Date.now() > current.endAt) return null;
    if (entrants.includes(payload.userId)) return null;
    return { entrants: [...entrants, payload.userId], entrantsRev: (current.entrantsRev ?? 0) + 1 };
  });
  return Boolean(updated);
}

export async function removeGiveawayEntry(client, database, payload) {
  if (!payload?.messageId || !payload?.userId) return false;
  if (payload.emoji?.name !== ENTRY_EMOJI) return false;

  const giveaway = await findRunningByMessage(database, payload.messageId);
  if (!giveaway) return false;

  const updated = await database.Giveaways.mutate(giveaway.id, (current) => {
    const entrants = current.entrants ?? [];
    if (current.status !== 'running' || !entrants.includes(payload.userId)) return null;
    return { entrants: entrants.filter((userId) => userId !== payload.userId), entrantsRev: (current.entrantsRev ?? 0) + 1 };
  });
  return Boolean(updated);
}

/** Valida e monta somente o que mudou numa edição. */
function buildChanges(patch) {
  const changes = {};
  const has = (key) => patch[key] !== undefined;

  for (const [field, maxLength, label] of [['title', 256, 'título'], ['prize', 256, 'prêmio'], ['description', 4000, 'descrição']]) {
    if (!has(field)) continue;
    const value = normalizeText(patch[field], '', maxLength);
    if (!value && field !== 'description') throw new GiveawayError(`O ${label} não pode ficar vazio.`);
    changes[field] = value || 'Participe reagindo com 🎉!';
  }

  if (has('winners')) {
    const winners = Number(patch.winners);
    if (!Number.isInteger(winners) || winners < 1 || winners > MAX_WINNERS) {
      throw new GiveawayError(`O número de ganhadores deve ser um inteiro entre 1 e ${MAX_WINNERS}.`);
    }
    changes.winners = winners;
  }

  if (has('roleId')) changes.roleId = normalizeId(patch.roleId, 'ID de cargo');
  if (has('hostId')) changes.hostId = normalizeId(patch.hostId, 'ID do organizador');

  return changes;
}

export async function editGiveaway(client, database, id, patch) {
  const current = await database.Giveaways.get(id);
  if (!current) throw new GiveawayError('Giveaway não encontrado.');
  if (['ended', 'cancelled', 'failed'].includes(current.status)) {
    throw new GiveawayError('Giveaways finalizados ou cancelados não podem ser editados.');
  }
  if (['publishing', 'ending'].includes(current.status)) {
    throw new GiveawayError('Este giveaway está sendo processado agora. Tente novamente em instantes.');
  }
  if (!patch || typeof patch !== 'object') throw new GiveawayError('Nenhuma alteração foi informada.');
  if (patch.channelId !== undefined) {
    throw new GiveawayError('O canal do giveaway não pode ser alterado. Cancele e crie outro no canal desejado.');
  }
  if (['duration', 'endAt', 'startAt'].some((key) => patch[key] !== undefined)) {
    throw new GiveawayError('A duração e as datas do giveaway não podem ser editadas.');
  }

  const changes = buildChanges(patch);
  if (!Object.keys(changes).length) throw new GiveawayError('Nenhuma alteração informada.');

  const updated = await database.Giveaways.mutate(id, (giveaway) => {
    if (!['scheduled', 'pending', 'running'].includes(giveaway.status)) return null;
    return { ...changes, updatedAt: Date.now() };
  });

  if (!updated) {
    throw new GiveawayError('O giveaway mudou de estado durante a edição. Tente novamente.');
  }

  if (updated.status === 'running' && updated.messageId) {
    const channel = getChannel(client, updated.guildId, updated.channelId);
    const message = await fetchMessage(channel, updated.messageId);
    await message?.edit({ embeds: [buildEmbed(updated, 'running')] }).catch((error) => {
      console.warn(GIVEAWAY_PREFIX, `Não consegui atualizar a mensagem do giveaway ${shortId(id)}:`, error?.message);
    });
  }

  return updated;
}

async function announceEnd(client, giveaway) {
  const channel = getChannel(client, giveaway.guildId, giveaway.channelId);
  if (!channel) {
    console.warn(GIVEAWAY_PREFIX, `Canal do giveaway ${shortId(giveaway.id)} não está mais disponível; resultado não anunciado.`);
    return;
  }

  const message = await fetchMessage(channel, giveaway.messageId);
  await message?.edit({ embeds: [buildEmbed(giveaway, 'ended')] }).catch((error) => {
    console.warn(GIVEAWAY_PREFIX, `Não consegui atualizar a mensagem do giveaway ${shortId(giveaway.id)}:`, error?.message);
  });

  const text = giveaway.winnerIds.length
    ? winnerAnnouncement(giveaway.winnerIds, giveaway.prize)
    : '😕 O giveaway terminou sem participantes elegíveis.';
  await channel.send(text).catch((error) => {
    console.warn(GIVEAWAY_PREFIX, `Não consegui anunciar o resultado do giveaway ${shortId(giveaway.id)}:`, error?.message);
  });
}

export async function endGiveaway(client, database, id) {
  const claimed = await database.Giveaways.mutate(id, (giveaway) => {
    if (giveaway.status !== 'running') return null;
    return { status: 'ending', statusChangedAt: Date.now() };
  });

  if (!claimed) {
    const giveaway = await database.Giveaways.get(id);
    if (!giveaway) throw new GiveawayError('Giveaway não encontrado.');
    if (giveaway.status === 'ended') return giveaway;
    if (giveaway.status === 'ending') throw new GiveawayError('Este giveaway já está sendo encerrado.');
    throw new GiveawayError(
      ['scheduled', 'pending'].includes(giveaway.status)
        ? 'Este giveaway ainda não começou. Use cancelar para removê-lo.'
        : `Este giveaway não pode ser encerrado (status: ${giveaway.status}).`,
    );
  }

  try {
    const entrants = claimed.entrants ?? [];
    const winnerIds = await drawWinners(client, claimed, entrants, claimed.winners);
    const ended = await database.Giveaways.update(id, {
      status: 'ended',
      endedAt: Date.now(),
      winnerIds,
      entrantCount: entrants.length,
    });
    await announceEnd(client, ended);
    return ended;
  } catch (error) {
    await database.Giveaways.update(id, { status: 'running' });
    throw error;
  }
}

export async function rerollGiveaway(client, database, id, amount = 1) {
  const giveaway = await database.Giveaways.get(id);
  if (!giveaway) throw new GiveawayError('Giveaway não encontrado.');
  if (giveaway.status !== 'ended') throw new GiveawayError('Apenas giveaways encerrados podem ter novo sorteio.');

  const count = asPositiveInteger(amount, 0);
  if (!count || count > MAX_WINNERS) throw new GiveawayError(`A quantidade deve ser um inteiro entre 1 e ${MAX_WINNERS}.`);

  const previous = giveaway.winnerIds ?? [];
  const pool = (giveaway.entrants ?? []).filter((userId) => !previous.includes(userId));
  const winners = await drawWinners(client, giveaway, pool, count);
  if (!winners.length) return [];

  const updated = await database.Giveaways.mutate(id, (current) => {
    const already = current.winnerIds ?? [];
    return {
      winnerIds: [...already, ...winners.filter((userId) => !already.includes(userId))],
      rerolledAt: Date.now(),
    };
  });

  const channel = getChannel(client, giveaway.guildId, giveaway.channelId);
  if (channel) {
    const message = await fetchMessage(channel, giveaway.messageId);
    await message?.edit({ embeds: [buildEmbed(updated, 'ended')] }).catch(() => {});
    await channel.send(
      winners.length === 1
        ? `🔄 Novo ganhador: <@${winners[0]}>! Você ganhou **${safeText(giveaway.prize)}**.`
        : `🔄 Novos ganhadores: ${winners.map((winner) => `<@${winner}>`).join(', ')}! Vocês ganharam **${safeText(giveaway.prize)}**.`,
    ).catch((error) => {
      console.warn(GIVEAWAY_PREFIX, `Não consegui anunciar o reroll do giveaway ${shortId(id)}:`, error?.message);
    });
  }

  return winners;
}

export async function cancelGiveaway(client, database, id) {
  const cancelled = await database.Giveaways.mutate(id, (giveaway) => {
    if (!['scheduled', 'pending', 'running'].includes(giveaway.status)) return null;
    return { status: 'cancelled', cancelledAt: Date.now() };
  });

  if (!cancelled) {
    const giveaway = await database.Giveaways.get(id);
    if (!giveaway) throw new GiveawayError('Giveaway não encontrado.');
    throw new GiveawayError(
      giveaway.status === 'cancelled'
        ? 'Este giveaway já foi cancelado.'
        : 'Este giveaway não pode mais ser cancelado (já foi encerrado ou está sendo processado).',
    );
  }

  if (cancelled.messageId) {
    const channel = getChannel(client, cancelled.guildId, cancelled.channelId);
    const message = await fetchMessage(channel, cancelled.messageId);
    await message?.edit({ embeds: [buildEmbed(cancelled, 'cancelled')] }).catch(() => {});
  }
  return cancelled;
}

/* -------------------------------------------------------------------------- */
/* Recuperação de participantes (reações feitas/removidas com o bot offline)  */
/* -------------------------------------------------------------------------- */

/** Lista TODOS os usuários (não-bots) que reagiram com 🎉. Se qualquer página falhar, lança erro: nunca devolve lista parcial. */
async function fetchReactorIds(client, message) {
  const ids = new Set();
  let after;

  for (let page = 0; page < MAX_REACTION_PAGES; page += 1) {
    const options = { limit: REACTION_PAGE_SIZE, ...(after ? { after } : {}) };
    let users;
    let hasMore;
    let nextAfter;

    if (typeof message.fetchReactionUsersPage === 'function') {
      ({ users, hasMore, nextAfter } = await message.fetchReactionUsersPage(ENTRY_EMOJI, options));
    } else if (typeof message.fetchReactionUsers === 'function') {
      users = await message.fetchReactionUsers(ENTRY_EMOJI, options);
      hasMore = users.length >= REACTION_PAGE_SIZE;
      nextAfter = users.at(-1)?.id ?? null;
    } else {
      throw new Error('Esta versão do SDK não consegue listar quem reagiu.');
    }

    for (const user of users) {
      if (user.bot || user.id === client.user?.id) continue;
      ids.add(user.id);
    }

    if (!hasMore || !nextAfter) return ids;
    if (nextAfter === after) throw new Error('A paginação de reações não avançou.');
    after = nextAfter;
  }

  throw new Error('Reações demais para sincronizar.');
}

/**
 * Atualiza a lista de participantes com o que realmente está reagido na mensagem.
 * REGRA: só vale para giveaway ainda em andamento. Se o prazo já passou (ou passar durante a conferência),
 * a lista NÃO é alterada, pois não há como saber se a reação foi feita antes ou depois do fim.
 *
 * Retorna { done, reason?, added, removed }. `done: false` significa "tente de novo depois".
 * Erros da API são lançados e nada é gravado (nunca aplicamos lista parcial).
 */
export async function syncGiveawayEntrants(client, database, id) {
  for (let attempt = 0; attempt < MAX_SYNC_ATTEMPTS; attempt += 1) {
    const giveaway = await database.Giveaways.get(id);
    if (!giveaway || giveaway.status !== 'running' || !giveaway.messageId) {
      return { done: true, reason: 'not-running', added: 0, removed: 0 };
    }
    if (Date.now() >= giveaway.endAt) return { done: true, reason: 'expired', added: 0, removed: 0 };

    const channel = getChannel(client, giveaway.guildId, giveaway.channelId);
    if (!channel) return { done: false, reason: 'channel-unavailable', added: 0, removed: 0 };

    const message = await fetchMessage(channel, giveaway.messageId);
    if (!message) return { done: true, reason: 'message-unavailable', added: 0, removed: 0 };

    const reactorIds = await fetchReactorIds(client, message);
    const stored = new Set(giveaway.entrants ?? []);

    // Quem reagiu e ainda não estava na lista só entra se atender ao cargo exigido
    const toAdd = [];
    for (const userId of reactorIds) {
      if (stored.has(userId)) continue;
      if (await isEligible(client, giveaway, userId, { checkMembership: false })) toAdd.push(userId);
    }
    const toRemove = new Set([...stored].filter((userId) => !reactorIds.has(userId)));

    let outcome = 'applied';
    const updated = await database.Giveaways.mutate(id, (current) => {
      // O prazo venceu durante a conferência: não dá para garantir que as reações são anteriores ao fim
      if (current.status !== 'running' || Date.now() >= current.endAt) {
        outcome = 'expired';
        return null;
      }
      // Alguém reagiu/removeu ao vivo enquanto conferíamos: refaz com dados novos
      if ((current.entrantsRev ?? 0) !== (giveaway.entrantsRev ?? 0)) {
        outcome = 'retry';
        return null;
      }
      if (!toAdd.length && !toRemove.size) {
        outcome = 'unchanged';
        return null;
      }
      const kept = (current.entrants ?? []).filter((userId) => !toRemove.has(userId));
      return { entrants: [...kept, ...toAdd], entrantsRev: (current.entrantsRev ?? 0) + 1, syncedAt: Date.now() };
    });

    if (outcome === 'retry') continue;
    if (outcome === 'expired') return { done: true, reason: 'expired', added: 0, removed: 0 };
    if (!updated) return { done: true, reason: 'unchanged', added: 0, removed: 0 };
    return { done: true, reason: 'applied', added: toAdd.length, removed: toRemove.size };
  }

  return { done: false, reason: 'busy', added: 0, removed: 0 };
}

/** Confere as reações de um giveaway uma única vez por sessão (com poucas tentativas se a API falhar). */
async function syncOnce(client, database, giveaway) {
  if (syncedGiveaways.has(giveaway.id)) return;
  const attempts = syncAttempts.get(giveaway.id) ?? 0;
  if (attempts >= MAX_SYNC_ATTEMPTS) return;

  try {
    const result = await syncGiveawayEntrants(client, database, giveaway.id);
    if (result.done) {
      syncedGiveaways.add(giveaway.id);
      if (result.added || result.removed) {
        console.info(GIVEAWAY_PREFIX, `Participantes do giveaway ${shortId(giveaway.id)} atualizados após a volta do bot: +${result.added} / -${result.removed}.`);
      }
    } else {
      syncAttempts.set(giveaway.id, attempts + 1);
    }
  } catch (error) {
    syncAttempts.set(giveaway.id, attempts + 1);
    console.warn(GIVEAWAY_PREFIX, `Não consegui conferir as reações do giveaway ${shortId(giveaway.id)} (tentativa ${attempts + 1}/${MAX_SYNC_ATTEMPTS}):`, error?.message);
  }
}

/* -------------------------------------------------------------------------- */
/* Rotina periódica                                                           */
/* -------------------------------------------------------------------------- */

let processing = false;

/** Publica os agendados que chegaram na hora, encerra os que venceram e destrava operações interrompidas. */
export async function processGiveaways(client, database) {
  if (processing) return; // a rodada anterior ainda não terminou
  processing = true;

  try {
    const all = Object.values(await database.Giveaways.getAll());
    const now = Date.now();

    for (const giveaway of all) {
      try {
        // Logo após ligar, o Ready pode vir antes de todos os servidores estarem no cache: espera chegarem
        const guildLoaded = client.guilds.cache.has(giveaway.guildId);

        if (['scheduled', 'pending'].includes(giveaway.status) && giveaway.startAt <= now) {
          if (guildLoaded) await publishGiveaway(client, database, giveaway.id);
        } else if (giveaway.status === 'running') {
          if (!guildLoaded) continue;
          if (giveaway.endAt <= now) {
            // Venceu (talvez com o bot offline): encerra com a lista salva, SEM reconferir as reações
            await endGiveaway(client, database, giveaway.id);
          } else {
            await syncOnce(client, database, giveaway);
          }
        } else if (['publishing', 'ending'].includes(giveaway.status)
          && now - (giveaway.statusChangedAt ?? 0) > STUCK_AFTER_MS) {
          // O bot caiu no meio da operação: volta ao estado anterior para tentar de novo
          await database.Giveaways.update(giveaway.id, { status: giveaway.status === 'ending' ? 'running' : 'pending' });
        }
      } catch (error) {
        console.error(GIVEAWAY_PREFIX, `Falha ao processar ${shortId(giveaway.id)}:`, error);
      }
    }
  } finally {
    processing = false;
  }
}

export { ENTRY_EMOJI, buildEmbed };
