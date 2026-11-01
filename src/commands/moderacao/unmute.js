import { PermissionFlags } from '@fluxerjs/core';

const MENTION_REGEX = /^<@!?(\d{15,21})>$/;
const ID_REGEX = /^(\d{15,21})$/;
const MAX_REASON_LENGTH = 512; // limite do motivo na API do Fluxer

const DEFAULT_MAX_UNMUTES = 5;
const DEFAULT_REASON = 'Sem motivo fornecido';

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
    motivo: args.slice(i).join(' ').trim() || DEFAULT_REASON,
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

export default {
  name: 'unmute',
  aliases: ['desmutar', 'dessilenciar'],
  categoria: 'moderacao',
  descricao: 'Remove o silenciamento (timeout) de um ou mais usuários.',
  uso: 'unmute [@usuário|ID]... <motivo>',
  exemplos: [
    'unmute @Usuario Mute aplicado por engano',
    'unmute 123456789012345678',
    'unmute @Usuario1 123456789012345678 @Usuario3 Revisão concluída',
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
      return message.reply(`${emojis.cross_system} Você não tem permissão para remover o silenciamento de membros.`);
    }

    // Permissão do bot
    const botMember = guild.members.me ?? (await guild.fetchMe().catch(() => null));
    if (!hasPermission(botMember, PermissionFlags.ModerateMembers)) {
      return message.reply(`${emojis.cross_system} Eu não tenho permissão para remover o silenciamento de membros neste servidor.`);
    }

    // Argumentos (tudo depois do nome do comando)
    const args = message.content.trim().split(/ +/).slice(1);

    if (!args.length) {
      return message.reply(`${emojis.cross_anim} Uso correto: \`${prefixo}${this.uso}\``);
    }

    const { ids, motivo } = parseArgs(args);

    if (ids.length === 0) {
      return message.reply(
        `${emojis.cross_anim} Você precisa mencionar ou fornecer o ID de pelo menos um usuário para remover o silenciamento.\n` +
        `Uso correto: \`${prefixo}${this.uso}\``
      );
    }

    // Limite máximo por comando (reaproveita a configuração de bans do servidor, como o mute)
    let MAX_UNMUTES = DEFAULT_MAX_UNMUTES;
    try {
      const server = await database.Server.get(guild.id);
      MAX_UNMUTES = toLimit(server?.moderation?.maxMutesPerCommand, DEFAULT_MAX_UNMUTES);
    } catch {}

    if (ids.length > MAX_UNMUTES) {
      return message.reply(`${emojis.cross_anim} Você pode remover o silenciamento de no máximo ${MAX_UNMUTES} usuários por comando.`);
    }

    // Motivo registrado na auditoria: o que o autor pediu + quem executou
    const unmuteReason = buildAuditReason(motivo, 'Desmutado', message.author);

    // Hierarquia do autor: o dono do servidor ignora a checagem de cargos
    const authorIsOwner = message.author.id === guild.ownerId;
    const authorPosition = getHighestRolePosition(authorMember);

    const unmuteResults = [];

    for (const userId of ids) {
      // Impede que alguém silenciado por um cargo superior remova o próprio mute
      if (userId === message.author.id) {
        unmuteResults.push({ userId, success: false, reason: 'você não pode remover o seu próprio silenciamento' });
        continue;
      }

      // Busca o membro direto da API (guild.fetchMember não usa cache) para ter o estado atual do timeout. Se não estiver no servidor, não há o que remover.
      const member = await guild.fetchMember(userId).catch(() => null);

      if (!member) {
        unmuteResults.push({ userId, success: false, reason: 'usuário não encontrado no servidor' });
        continue;
      }

      // Só faz sentido se existir um timeout ativo (null = sem timeout; data no passado = já expirou)
      const mutadoAte = member.communicationDisabledUntil;
      if (!mutadoAte || new Date(mutadoAte).getTime() <= Date.now()) {
        unmuteResults.push({ userId, success: false, reason: 'o usuário não está silenciado' });
        continue;
      }

      // Hierarquia do AUTOR: precisa ter cargo estritamente acima do alvo
      if (!authorIsOwner && getHighestRolePosition(member) >= authorPosition) {
        unmuteResults.push({ userId, success: false, reason: 'o cargo mais alto dele é igual ou superior ao seu' });
        continue;
      }

      // Hierarquia/permissão do BOT
      if (!member.moderatable) {
        unmuteResults.push({ userId, success: false, reason: 'não posso alterar este usuário (o cargo dele está acima do meu ou igual)' });
        continue;
      }

      try {
        await member.timeout(null, unmuteReason); // null limpa o timeout
        unmuteResults.push({ userId, success: true });
      } catch (error) {
        unmuteResults.push({ userId, success: false, reason: `erro ao tentar remover o silenciamento: \`${error.message}\`` });
      }
    }

    // Resumo
    const successUnmutes = unmuteResults.filter(r => r.success);
    const failedUnmutes = unmuteResults.filter(r => !r.success);

    let summaryMessage = '';

    if (successUnmutes.length > 0) {
      summaryMessage += `${emojis.check_anim} ${successUnmutes.length} silenciamento(s) removido(s) com sucesso:\n`;
      summaryMessage += successUnmutes.map(r => `- <@${r.userId}>`).join('\n');
      summaryMessage += `\nMotivo: ${motivo}\n`;
    }

    if (failedUnmutes.length > 0) {
      summaryMessage += `\n${emojis.cross_anim} Falha ao remover o silenciamento:\n`;
      summaryMessage += failedUnmutes.map(r => `- <@${r.userId}> (${r.reason})`).join('\n');
    }

    await message.reply(summaryMessage.trim());
  },
};
