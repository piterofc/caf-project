import { PermissionFlags } from '@fluxerjs/core';

const MENTION_REGEX = /^<@!?(\d{15,21})>$/;
const ID_REGEX = /^(\d{15,21})$/;
const DURATION_REGEX = /^(?:\d+[smhdw])+$/i;

const DEFAULT_MAX_MUTES = 5;
const DEFAULT_REASON = 'Sem motivo fornecido';
const MAX_REASON_LENGTH = 512; // limite do motivo do timeout na API do Fluxer
const MAX_DURATION_MS = 365 * 24 * 60 * 60 * 1000; // a API recusa timeouts acima de ~365 dias
const PROMPT_TIME_MS = 30_000; // tempo que o bot espera a resposta do autor
const SKIP_EMOJI = '❌';
const CONFIRM_EMOJI = '✅';

// Configuração por servidor: `moderation.muteConfirm` (true/false).
// Quando ausente, vale true: o bot sempre pede confirmação antes de aplicar o mute.

const UNIT_MS = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
};

/**
 * Modos do comando, configurados por servidor em `moderation.muteMode`:
 * - padrao:            mute <alvos> <duração> [motivo]
 * - perguntar_motivo:  mute <alvos> <duração>   -> o bot pergunta o motivo depois
 * - perguntar_tempo:   mute <alvos> [motivo]    -> o bot pergunta a duração depois
 */
const MODES = {
  PADRAO: 'padrao',
  PERGUNTAR_MOTIVO: 'perguntar_motivo',
  PERGUNTAR_TEMPO: 'perguntar_tempo',
};

const USAGE = {
  [MODES.PADRAO]: 'mute [@usuário|ID]... [duração] <motivo>',
  [MODES.PERGUNTAR_MOTIVO]: 'mute [@usuário|ID]... [duração]',
  [MODES.PERGUNTAR_TEMPO]: 'mute [@usuário|ID]... <motivo>',
};

/**
 * Converte "30s", "10m", "2h", "7d", "1w" ou combinações como "1h30m" em milissegundos.
 * Retorna null se o formato for inválido.
 */
function parseDuration(token) {
  if (!token || !DURATION_REGEX.test(token)) return null;

  let total = 0;
  for (const [, amount, unit] of token.matchAll(/(\d+)([smhdw])/gi)) {
    total += Number(amount) * UNIT_MS[unit.toLowerCase()];
  }
  return total;
}

/** Converte milissegundos em texto legível, ex.: 5400000 -> "1h 30m". */
function formatDuration(ms) {
  const units = [['d', UNIT_MS.d], ['h', UNIT_MS.h], ['m', UNIT_MS.m], ['s', UNIT_MS.s]];
  const parts = [];
  let rest = ms;

  for (const [label, size] of units) {
    const qty = Math.floor(rest / size);
    if (qty > 0) {
      parts.push(`${qty}${label}`);
      rest -= qty * size;
    }
  }
  return parts.join(' ') || '0s';
}

/** Valida uma duração digitada pelo autor. */
function validateDuration(content) {
  const ms = parseDuration(content.trim());
  if (ms === null || ms <= 0) {
    return { ok: false, error: 'Duração inválida. Use algo como `30s`, `10m`, `2h`, `1d`, `1w` ou `1h30m`.' };
  }
  if (ms > MAX_DURATION_MS) {
    return { ok: false, error: 'A duração máxima do mute é de 365 dias.' };
  }
  return { ok: true, value: ms };
}

/** Valida um motivo digitado pelo autor. */
function validateReason(content) {
  const text = content.trim();
  if (!text) return { ok: false, error: 'O motivo não pode ficar vazio.' };
  return { ok: true, value: text };
}

/**
 * Lê os argumentos da esquerda para a direita.
 * Enquanto o token for menção ou ID, é alvo. O resto depende do modo:
 * - padrao / perguntar_motivo: o primeiro token depois dos alvos é a duração, o resto é o motivo.
 * - perguntar_tempo: tudo depois dos alvos é motivo (não tenta interpretar duração).
 * `duracaoMs` e `motivo` ficam null quando não foram informados no comando.
 */
function parseArgs(args, modo) {
  const ids = [];
  let i = 0;

  for (; i < args.length; i++) {
    const match = args[i].match(MENTION_REGEX) || args[i].match(ID_REGEX);
    if (!match) break;
    ids.push(match[1]);
  }

  const rest = args.slice(i);
  const base = { ids: [...new Set(ids)] }; // remove duplicados

  if (modo === MODES.PERGUNTAR_TEMPO) {
    return { ...base, duracaoMs: null, motivo: rest.join(' ').trim() || null };
  }

  const duracaoMs = parseDuration(rest[0]);
  const motivoTokens = duracaoMs !== null ? rest.slice(1) : rest;

  return { ...base, duracaoMs, motivo: motivoTokens.join(' ').trim() || null };
}

/**
 * Maior posição de cargo do membro (maior número = mais alto).
 * Sem cargos (ou cache vazio) retorna 0.
 */
function getHighestRolePosition(member) {
  const roles = member?.roles?.cache;
  if (!roles) return 0;
  return [...roles.values()].reduce((max, role) => Math.max(max, role.position ?? 0), 0);
}

/**
 * Faz uma pergunta ao autor do comando e espera, por até PROMPT_TIME_MS:
 * - uma mensagem dele no mesmo canal que passe na validação -> { type: 'answer', value }
 * - uma reação com SKIP_EMOJI na pergunta                    -> { type: 'skip' }
 * - nada                                                      -> { type: 'timeout' }
 * - falha ao enviar a pergunta                                -> { type: 'error' }
 * Respostas inválidas recebem um aviso e a espera continua.
 */
async function askAuthor({ message, promptText, validate }) {
  let channel;
  let prompt;
  try {
    channel = message.channel ?? (await message.resolveChannel());
    prompt = await message.reply(promptText);
  } catch {
    return { type: 'error' }; // não conseguiu enviar a pergunta
  }

  return new Promise((resolve) => {
    let settled = false;

    const messageCollector = channel.createMessageCollector({
      filter: (m) => m.author.id === message.author.id,
      time: PROMPT_TIME_MS,
    });

    const reactionCollector = prompt.createReactionCollector({
      filter: (reaction, user) => user.id === message.author.id && reaction.emoji.name === SKIP_EMOJI,
      time: PROMPT_TIME_MS,
      max: 1,
    });

    const finish = (result) => {
      if (settled) return;
      settled = true;
      messageCollector.stop('user');
      reactionCollector.stop('user');
      resolve(result);
    };

    messageCollector.on('collect', async (m) => {
      const result = validate(m.content ?? '');
      if (result.ok) return finish({ type: 'answer', value: result.value });
      await m.reply(result.error).catch(() => {});
    });

    reactionCollector.on('collect', () => finish({ type: 'skip' }));

    // Se algum coletor terminar por tempo, a pergunta expirou
    messageCollector.on('end', () => finish({ type: 'timeout' }));
    reactionCollector.on('end', () => finish({ type: 'timeout' }));

    // Adiciona a reação para o autor só clicar (se falhar, ele ainda pode digitar ou reagir manualmente)
    prompt.react(SKIP_EMOJI).catch(() => {});
  });
}

/**
 * Pede confirmação final ao autor, reagindo com CONFIRM_EMOJI / SKIP_EMOJI na mensagem do bot.
 * Só reações do autor do comando contam. Retorna 'confirm', 'cancel', 'timeout' ou 'error' (falha ao enviar a pergunta).
 */
async function confirmAuthor({ message, promptText }) {
  let prompt;
  try {
    prompt = await message.reply(promptText);
  } catch {
    return 'error'; // não conseguiu enviar a pergunta
  }

  return new Promise((resolve) => {
    let settled = false;

    const collector = prompt.createReactionCollector({
      filter: (reaction, user) =>
        user.id === message.author.id &&
        (reaction.emoji.name === CONFIRM_EMOJI || reaction.emoji.name === SKIP_EMOJI),
      time: PROMPT_TIME_MS,
      max: 1,
    });

    const finish = (result) => {
      if (settled) return;
      settled = true;
      collector.stop('user');
      resolve(result);
    };

    collector.on('collect', (reaction) => {
      finish(reaction.emoji.name === CONFIRM_EMOJI ? 'confirm' : 'cancel');
    });

    // Terminou sem nenhuma reação válida: a confirmação expirou
    collector.on('end', () => finish('timeout'));

    // Adiciona as duas reações, na ordem, para o autor só clicar
    (async () => {
      await prompt.react(CONFIRM_EMOJI).catch(() => {});
      await prompt.react(SKIP_EMOJI).catch(() => {});
    })();
  });
}

/**
 * Verifica uma permissão do membro. Administrator concede todas as permissões.
 * Usa o enum oficial PermissionFlags (strings como 'BAN_MEMBERS' não são nomes válidos no SDK).
 */
function hasPermission(member, flag) {
  const permissions = member?.permissions;
  if (!permissions) return false;
  return permissions.has(flag) || permissions.has(PermissionFlags.Administrator);
}

/** Identificação de quem executou a ação: username#discriminator (só o username se a conta não tiver discriminator). */
function formatAuthorTag(author) {
  const { username, discriminator } = author;
  const hasDiscriminator = discriminator && discriminator !== '0' && discriminator !== '0000';
  return hasDiscriminator ? `${username}#${discriminator}` : username;
}

/**
 * Motivo padronizado para o registro de auditoria: o que o autor pediu + quem executou a ação.
 * Se passar do limite da API, corta o motivo e preserva a identificação do autor.
 */
function buildAuditReason(motivo, acao, author) {
  const suffix = ` (${acao} por ${formatAuthorTag(author)})`;
  return `${motivo.slice(0, Math.max(0, MAX_REASON_LENGTH - suffix.length))}${suffix}`;
}

/** Converte o limite salvo no banco em um inteiro positivo; senão usa o padrão. */
function toLimit(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

/** Busca o membro no cache; se não estiver, busca na API. Retorna null se não for membro do servidor. */
async function resolveMember(guild, userId) {
  return guild.members.get(userId) ?? (await guild.fetchMember(userId).catch(() => null));
}

export default {
  name: 'mute',
  aliases: ['mutar', 'silenciar'],
  categoria: 'moderacao',
  descricao: 'Silencia (timeout) um ou mais usuários por um tempo determinado.',
  uso: USAGE[MODES.PADRAO], // formato padrão; as mensagens de erro mostram o formato do modo do servidor
  exemplos: [
    'mute @Usuario 10m Spam',
    'mute 123456789012345678 2h',
    'mute @Usuario1 123456789012345678 @Usuario3 1d Flood no chat',
    'mute @Usuario 1h30m',
  ],

  async execute({ client, message, prefixo }) {
    const { emojis, database } = client.brain;

    // Servidor onde o comando foi usado (não funciona em DM)
    const guild = message.guild ?? (await message.resolveGuild().catch(() => null));
    if (!guild) {
      return message.reply(`${emojis.cross_system} Este comando só pode ser usado dentro de um servidor.`);
    }

    // Membro que executou o comando (o cache pode estar vazio, então busca na API)
    const authorMember = message.member ?? (await guild.fetchMember(message.author.id).catch(() => null));
    if (!authorMember) {
      return message.reply(`${emojis.cross_system} Não consegui carregar os seus dados neste servidor. Tente novamente.`);
    }

    // Permissão de quem executa
    if (!hasPermission(authorMember, PermissionFlags.ModerateMembers)) {
      return message.reply(`${emojis.cross_system} Você não tem permissão para silenciar membros.`);
    }

    // Permissão do bot
    const botMember = guild.members.me ?? (await guild.fetchMe().catch(() => null));
    if (!hasPermission(botMember, PermissionFlags.ModerateMembers)) {
      return message.reply(`${emojis.cross_system} Eu não tenho permissão para silenciar membros neste servidor.`);
    }

    // Configurações do servidor (limite por comando e modo do mute)
    let MAX_MUTES = DEFAULT_MAX_MUTES;
    let modo = MODES.PADRAO; // padrão: o comando espera duração e motivo no mesmo comando
    let exigirConfirmacao = true; // padrão: exigir confirmação do autor antes de aplicar o mute
    try {
      const server = await database.Server.get(guild.id);
      MAX_MUTES = toLimit(server?.moderation?.maxMutesPerCommand, DEFAULT_MAX_MUTES);

      const configured = server?.moderation?.muteMode;
      if (Object.values(MODES).includes(configured)) modo = configured;

      // Só desliga a confirmação se o servidor tiver definido explicitamente false
      exigirConfirmacao = server?.moderation?.muteConfirm !== false;
    } catch {}

    const uso = `${prefixo}${USAGE[modo]}`;

    // Argumentos (tudo depois do nome do comando)
    const args = message.content.trim().split(/ +/).slice(1);

    if (!args.length) {
      return message.reply(`${emojis.cross_anim} Uso correto: \`${uso}\``);
    }

    const { ids, duracaoMs: duracaoInformada, motivo: motivoInformado } = parseArgs(args, modo);

    if (ids.length === 0) {
      return message.reply(
        `${emojis.cross_anim} Você precisa mencionar ou fornecer o ID de pelo menos um usuário para silenciar.\n` +
        `Uso correto: \`${uso}\``
      );
    }

    // Nos modos em que a duração vem no comando, ela é obrigatória e precisa ser válida
    if (modo !== MODES.PERGUNTAR_TEMPO) {
      if (duracaoInformada === null || duracaoInformada <= 0) {
        return message.reply(
          `${emojis.cross_anim} Você precisa informar uma duração válida depois dos usuários (ex.: \`30s\`, \`10m\`, \`2h\`, \`1d\`, \`1w\`, \`1h30m\`).\n` +
          `Uso correto: \`${uso}\``
        );
      }

      if (duracaoInformada > MAX_DURATION_MS) {
        return message.reply(`${emojis.cross_anim} A duração máxima do mute é de 365 dias.`);
      }
    }

    if (ids.length > MAX_MUTES) {
      return message.reply(`${emojis.cross_anim} Você pode silenciar no máximo ${MAX_MUTES} usuários por comando.`);
    }

    let duracaoMs = duracaoInformada;
    let motivo = motivoInformado;

    // Modo perguntar_tempo: a duração não veio no comando
    if (duracaoMs === null) {
      const answer = await askAuthor({
        message,
        promptText:
          `Por quanto tempo devo silenciar ${ids.length} usuário(s)? ` +
          `Responda com a duração (ex.: \`30s\`, \`10m\`, \`2h\`, \`1d\`, \`1w\`, \`1h30m\`) ` +
          `ou reaja com ${SKIP_EMOJI} para cancelar. (${PROMPT_TIME_MS / 1000}s)`,
        validate: validateDuration,
      });

      if (answer.type === 'error') return;

      if (answer.type === 'timeout') {
        return message.reply(`${emojis.cross_anim} Tempo esgotado. Mute cancelado.`);
      }
      if (answer.type === 'skip') {
        return message.reply(`${emojis.cross_anim} Mute cancelado.`);
      }
      duracaoMs = answer.value;
    }

    // Modo perguntar_motivo: sempre pergunta o motivo depois do comando
    if (modo === MODES.PERGUNTAR_MOTIVO) {
      const answer = await askAuthor({
        message,
        promptText:
          `Qual o motivo do mute? Responda com o motivo ` +
          `ou reaja com ${SKIP_EMOJI} para continuar sem motivo. (${PROMPT_TIME_MS / 1000}s)`,
        validate: validateReason,
      });

      if (answer.type === 'error') return;

      if (answer.type === 'timeout') {
        return message.reply(`${emojis.cross_anim} Tempo esgotado. Mute cancelado.`);
      }
      motivo = answer.type === 'answer' ? answer.value : null;
    }

    motivo = motivo ?? DEFAULT_REASON;

    // Motivo registrado na auditoria: o que o autor pediu + quem executou
    const muteReason = buildAuditReason(motivo, 'Mutado', message.author);

    // Hierarquia do autor: o dono do servidor ignora a checagem de cargos
    const authorIsOwner = message.author.id === guild.ownerId;
    const authorPosition = getHighestRolePosition(authorMember);

    // Confirmação final (ativada por padrão; o servidor pode desligar com muteConfirm: false), logo antes de executar
    if (exigirConfirmacao) {
      const alvos = ids
        .map((id) => `- <@${id}> (\`${id}\`)`)
        .join('\n');
      const motivoPreview = motivo.length > 200 ? `${motivo.slice(0, 200)}…` : motivo;

      const decision = await confirmAuthor({
        message,
        promptText:
          `Confirma silenciar ${ids.length} usuário(s) por ${formatDuration(duracaoMs)}?\n${alvos}\n` +
          `Motivo: ${motivoPreview}\n` +
          `Reaja com ${CONFIRM_EMOJI} para confirmar ou ${SKIP_EMOJI} para cancelar. (${PROMPT_TIME_MS / 1000}s)`,
      });

      if (decision === 'error') return;

      if (decision === 'timeout') {
        return message.reply(`${emojis.cross_anim} Tempo esgotado. Mute cancelado.`);
      }
      if (decision === 'cancel') {
        return message.reply(`${emojis.cross_anim} Mute cancelado.`);
      }
    }

    const muteResults = [];

    for (const userId of ids) {
      if (userId === message.author.id) {
        muteResults.push({ userId, success: false, reason: 'você não pode se silenciar' });
        continue;
      }

      if (userId === client.user.id) {
        muteResults.push({ userId, success: false, reason: 'você não pode me silenciar' });
        continue;
      }

      if (userId === guild.ownerId) {
        muteResults.push({ userId, success: false, reason: 'você não pode silenciar o dono do servidor' });
        continue;
      }

      // Obtém o membro (cache ou API) para checar hierarquia e permissões. Se não estiver no servidor, não faz sentido tentar silenciar.
      const member = await resolveMember(guild, userId);

      // Timeout só faz sentido para quem está no servidor
      if (!member) {
        muteResults.push({ userId, success: false, reason: 'usuário não encontrado no servidor' });
        continue;
      }

      // Hierarquia do AUTOR: precisa ter cargo estritamente acima do alvo
      if (!authorIsOwner && getHighestRolePosition(member) >= authorPosition) {
        muteResults.push({ userId, success: false, reason: 'o cargo mais alto dele é igual ou superior ao seu' });
        continue;
      }

      // Hierarquia/permissão do BOT
      if (!member.moderatable) {
        muteResults.push({ userId, success: false, reason: 'não posso silenciar este usuário (o cargo dele está acima do meu ou igual)' });
        continue;
      }

      try {
        await member.timeout(duracaoMs, muteReason);
        muteResults.push({ userId, success: true });
      } catch (error) {
        muteResults.push({ userId, success: false, reason: `erro ao tentar silenciar: \`${error.message}\`` });
      }
    }

    // Resumo
    const successMutes = muteResults.filter(r => r.success);
    const failedMutes = muteResults.filter(r => !r.success);

    let summaryMessage = '';

    if (successMutes.length > 0) {
      summaryMessage += `${emojis.check_anim} ${successMutes.length} usuário(s) silenciado(s) com sucesso por ${formatDuration(duracaoMs)}:\n`;
      summaryMessage += successMutes.map(r => `- <@${r.userId}>`).join('\n');
      summaryMessage += `\nMotivo: ${motivo}\n`;
    }

    if (failedMutes.length > 0) {
      summaryMessage += `\n${emojis.cross_anim} Falha ao silenciar:\n`;
      summaryMessage += failedMutes.map(r => `- <@${r.userId}> (${r.reason})`).join('\n');
    }

    await message.reply(summaryMessage.trim());
  },
};
