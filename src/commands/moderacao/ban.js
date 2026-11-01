import { PermissionFlags } from '@fluxerjs/core';

const MENTION_REGEX = /^<@!?(\d{15,21})>$/;
const ID_REGEX = /^(\d{15,21})$/;
const DEFAULT_MAX_BANS = 5;
const MAX_REASON_LENGTH = 512; // limite do motivo na API de ban do Fluxer
const PROMPT_TIME_MS = 30_000; // tempo que o bot espera a confirmação do autor
const CONFIRM_EMOJI = '✅';
const SKIP_EMOJI = '❌';

/**
 * Lê os argumentos da esquerda para a direita.
 * Enquanto o token for menção ou ID, é alvo.
 * No primeiro token que não for nenhum dos dois, tudo o que sobra é o motivo.
 */
function parseArgs(args) {
  const ids = [];
  let i = 0;

  for (; i < args.length; i++) {
    const match = args[i].match(MENTION_REGEX) || args[i].match(ID_REGEX);
    if (!match) break;
    ids.push(match[1]);
  }

  return {
    ids: [...new Set(ids)], // remove duplicados
    motivo: args.slice(i).join(' ').trim() || 'Sem motivo fornecido',
  };
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
  name: 'ban',
  aliases: ['banir'],
  categoria: 'moderacao',
  descricao: 'Bane um ou mais usuários do servidor.',
  uso: 'ban <@usuário|ID>... [motivo]',
  exemplos: [
    'ban @Usuario Comportamento inapropriado',
    'ban 123456789012345678',
    'ban @Usuario1 123456789012345678 @Usuario3 Spam',
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
    if (!hasPermission(authorMember, PermissionFlags.BanMembers)) {
      return message.reply(`${emojis.cross_system} Você não tem permissão para banir membros.`);
    }

    // Permissão do bot
    const botMember = guild.members.me ?? (await guild.fetchMe().catch(() => null));
    if (!hasPermission(botMember, PermissionFlags.BanMembers)) {
      return message.reply(`${emojis.cross_system} Eu não tenho permissão para banir membros neste servidor.`);
    }

    // Argumentos (tudo depois do nome do comando)
    const args = message.content.trim().split(/ +/).slice(1);

    if (!args.length) {
      return message.reply(`${emojis.cross_anim} Uso correto: \`${prefixo}${this.uso}\``);
    }

    const { ids, motivo } = parseArgs(args);

    if (ids.length === 0) {
      return message.reply(
        `${emojis.cross_anim} Você precisa mencionar ou fornecer o ID de pelo menos um usuário para banir.\n` +
        `Uso correto: \`${prefixo}${this.uso}\``
      );
    }

    // Limite máximo de banimentos por comando (configurável por servidor)
    let MAX_BANS = DEFAULT_MAX_BANS;
    let exigirConfirmacao = true; // padrão: exigir confirmação do autor antes de banir
    try {
      const server = await database.Server.get(guild.id);
      MAX_BANS = toLimit(server?.moderation?.maxBansPerCommand, DEFAULT_MAX_BANS);
      exigirConfirmacao = server?.moderation?.banConfirm !== false;
    } catch {}

    if (ids.length > MAX_BANS) {
      return message.reply(`${emojis.cross_anim} Você pode banir no máximo ${MAX_BANS} usuários por comando.`);
    }

    // Motivo registrado na auditoria: o que o autor pediu + quem executou
    const banReason = buildAuditReason(motivo, 'Banido', message.author);

    // Hierarquia do autor: o dono do servidor ignora a checagem de cargos
    const authorIsOwner = message.author.id === guild.ownerId;
    const authorPosition = getHighestRolePosition(authorMember);

    // Confirmação final (opcional, ativada por servidor), logo antes de executar
    if (exigirConfirmacao) {
      const alvos = ids
        .map((id) => `- <@${id}> (\`${id}\`)`)
        .join('\n');
      const motivoPreview = motivo.length > 200 ? `${motivo.slice(0, 200)}…` : motivo;

      const decision = await confirmAuthor({
        message,
        promptText:
          `Confirma banir ${ids.length} usuário(s)?\n${alvos}\n` +
          `Motivo: ${motivoPreview}\n` +
          `Reaja com ${CONFIRM_EMOJI} para confirmar ou ${SKIP_EMOJI} para cancelar. (${PROMPT_TIME_MS / 1000}s)`,
      });

      if (decision === 'error') return;

      if (decision === 'timeout') {
        return message.reply(`${emojis.cross_anim} Tempo esgotado. Banimento cancelado.`);
      }
      if (decision === 'cancel') {
        return message.reply(`${emojis.cross_anim} Banimento cancelado.`);
      }
    }

    const banResults = [];

    for (const userId of ids) {
      // Checagens que não dependem de o alvo estar no servidor
      if (userId === message.author.id) {
        banResults.push({ userId, success: false, reason: 'você não pode se banir' });
        continue;
      }

      if (userId === client.user.id) {
        banResults.push({ userId, success: false, reason: 'você não pode me banir' });
        continue;
      }

      if (userId === guild.ownerId) {
        banResults.push({ userId, success: false, reason: 'você não pode banir o dono do servidor' });
        continue;
      }

      const member = await resolveMember(guild, userId);

      // Não está no servidor: tenta banir direto pelo ID
      if (!member) {
        try {
          await guild.ban(userId, { reason: banReason });
          banResults.push({ userId, success: true, reason: motivo });
        } catch (error) {
          banResults.push({ userId, success: false, reason: `usuário não está no servidor e o ban por ID falhou: \`${error.message}\`` });
        }
        continue;
      }

      // Hierarquia do AUTOR: precisa ter cargo estritamente acima do alvo
      if (!authorIsOwner && getHighestRolePosition(member) >= authorPosition) {
        banResults.push({ userId, success: false, reason: 'o cargo mais alto dele é igual ou superior ao seu' });
        continue;
      }

      // Hierarquia/permissão do BOT
      if (!member.bannable) {
        banResults.push({ userId, success: false, reason: 'não posso banir este usuário (o cargo dele está acima do meu ou igual)' });
        continue;
      }

      try {
        await member.ban({ reason: banReason });
        banResults.push({ userId, success: true, reason: motivo });
      } catch (error) {
        banResults.push({ userId, success: false, reason: `erro ao tentar banir: ${error.message}` });
      }
    }

    // Resumo
    const successBans = banResults.filter(r => r.success);
    const failedBans = banResults.filter(r => !r.success);

    let summaryMessage = '';

    if (successBans.length > 0) {
      summaryMessage += `${emojis.check_anim} ${successBans.length} banimento(s) realizado(s) com sucesso:\n`;
      summaryMessage += successBans.map(r => `- <@${r.userId}>`).join('\n');
      summaryMessage += `\nMotivo: ${motivo}\n`;
    }

    if (failedBans.length > 0) {
      summaryMessage += `\n${emojis.cross_anim} Falha ao banir:\n`;
      summaryMessage += failedBans.map(r => `- <@${r.userId}> (${r.reason})`).join('\n');
    }

    await message.reply(summaryMessage.trim());
  },
};