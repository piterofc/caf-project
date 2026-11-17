import { PermissionFlags } from '@fluxerjs/core';

const MENTION_REGEX = /^<@!?(\d{15,21})>$/;
const ID_REGEX = /^(\d{15,21})$/;
const MAX_REASON_LENGTH = 512; // limite do motivo na API do Fluxer
const DEFAULT_MAX_UNBANS = 5;

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
  name: 'unban',
  aliases: ['desbanir'],
  categoria: 'moderacao',
  descricao: 'Remove o banimento de um ou mais usuários do servidor.',
  uso: 'unban <@usuário|ID>... [motivo]',
  exemplos: [
    'unban 123456789012345678',
    'unban @Usuario Apelação aceita',
    'unban 123456789012345678 @Usuario2 987654321098765432 Banimento revisado',
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
      return message.reply(`${emojis.cross_system} Você não tem permissão para desbanir membros.`);
    }

    // Permissão do bot
    const botMember = guild.members.me ?? (await guild.fetchMe().catch(() => null));
    if (!hasPermission(botMember, PermissionFlags.BanMembers)) {
      return message.reply(`${emojis.cross_system} Eu não tenho permissão para desbanir membros neste servidor.`);
    }

    // Argumentos (tudo depois do nome do comando)
    const args = message.content.trim().split(/ +/).slice(1);

    if (!args.length) {
      return message.reply(`${emojis.cross_anim} Uso correto: \`${prefixo}${this.uso}\``);
    }

    const { ids, motivo } = parseArgs(args);

    if (ids.length === 0) {
      return message.reply(
        `${emojis.cross_anim} Você precisa mencionar ou fornecer o ID de pelo menos um usuário para desbanir.\n` +
        `Uso correto: \`${prefixo}${this.uso}\``
      );
    }

    // Limite máximo por comando (reaproveita a configuração de bans do servidor)
    let MAX_UNBANS = DEFAULT_MAX_UNBANS;
    try {
      const server = await database.Server.get(guild.id);
      MAX_UNBANS = toLimit(server?.moderation?.maxBansPerCommand, DEFAULT_MAX_UNBANS);
    } catch {}

    if (ids.length > MAX_UNBANS) {
      return message.reply(`${emojis.cross_anim} Você pode desbanir no máximo ${MAX_UNBANS} usuários por comando.`);
    }

    // Motivo registrado na auditoria: o que o autor pediu + quem executou
    const unbanReason = buildAuditReason(motivo, 'Desbanido', message.author);

    const unbanResults = [];

    for (const userId of ids) {
      try {
        await guild.unban(userId, unbanReason);
        unbanResults.push({ userId, success: true });
      } catch (error) {
        unbanResults.push({
          userId,
          success: false,
          reason: `não foi possível desbanir - o usuário pode não estar banido`,
        });
      }
    }

    // Resumo
    const successUnbans = unbanResults.filter(r => r.success);
    const failedUnbans = unbanResults.filter(r => !r.success);

    let summaryMessage = '';

    if (successUnbans.length > 0) {
      summaryMessage += `${emojis.check_anim} ${successUnbans.length} desbanimento(s) realizado(s) com sucesso:\n`;
      summaryMessage += successUnbans.map(r => `- <@${r.userId}>`).join('\n');
      summaryMessage += `\nMotivo: ${motivo}\n`;
    }

    if (failedUnbans.length > 0) {
      summaryMessage += `\n${emojis.cross_anim} Falha ao desbanir:\n`;
      summaryMessage += failedUnbans.map(r => `- <@${r.userId}> (${r.reason})`).join('\n');
    }

    await message.reply(summaryMessage.trim());
  },
};
