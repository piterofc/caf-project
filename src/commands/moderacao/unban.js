const MENTION_REGEX = /^<@!?(\d{15,21})>$/;
const ID_REGEX = /^(\d{15,21})$/;
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

    // Permissão de quem executa
    if (!message.member.permissions.has('BAN_MEMBERS')) {
      return message.reply(`${emojis.cross_system} Você não tem permissão para desbanir membros.`);
    }

    // Permissão do bot
    if (!message.guild.members.get(client.user.id)?.permissions.has('BAN_MEMBERS')) {
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
      const server = await database.Server.get(message.guild.id);
      MAX_UNBANS = server?.moderation?.maxBansPerCommand || DEFAULT_MAX_UNBANS;
    } catch {}

    if (ids.length > MAX_UNBANS) {
      return message.reply(`${emojis.cross_anim} Você pode desbanir no máximo ${MAX_UNBANS} usuários por comando.`);
    }

    const unbanReason = `${motivo} (Desbanido por ${message.author.username}#${message.author.discriminator})`;

    const unbanResults = [];

    for (const userId of ids) {
      try {
        await message.guild.unban(userId);
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
