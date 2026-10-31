const MENTION_REGEX = /^<@!?(\d{15,21})>$/;
const ID_REGEX = /^(\d{15,21})$/;
const DEFAULT_MAX_KICKS = 5;
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
 * Só reações do autor do comando contam. Retorna 'confirm', 'cancel' ou 'timeout'.
 */
async function confirmAuthor({ message, promptText }) {
  const prompt = await message.reply(promptText);

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

export default {
  name: 'kick',
  aliases: ['expulsar'],
  categoria: 'moderacao',
  descricao: 'Expulsa um ou mais usuários do servidor.',
  uso: 'kick <@usuário|ID>... [motivo]',
  exemplos: [
    'kick @Usuario Comportamento inapropriado',
    'kick 123456789012345678',
    'kick @Usuario1 123456789012345678 @Usuario3 Spam',
  ],

  async execute({ client, message, prefixo }) {
    const { emojis, database } = client.brain;

    // Permissão de quem executa
    if (!message.member.permissions.has('KICK_MEMBERS')) {
      return message.reply(`${emojis.cross_system} Você não tem permissão para expulsar membros.`);
    }

    // Permissão do bot
    if (!message.guild.members.get(client.user.id)?.permissions.has('KICK_MEMBERS')) {
      return message.reply(`${emojis.cross_system} Eu não tenho permissão para expulsar membros neste servidor.`);
    }

    // Argumentos (tudo depois do nome do comando)
    const args = message.content.trim().split(/ +/).slice(1);

    if (!args.length) {
      return message.reply(`${emojis.cross_anim} Uso correto: \`${prefixo}${this.uso}\``);
    }

    const { ids, motivo } = parseArgs(args);

    if (ids.length === 0) {
      return message.reply(
        `${emojis.cross_anim} Você precisa mencionar ou fornecer o ID de pelo menos um usuário para expulsar.\n` +
        `Uso correto: \`${prefixo}${this.uso}\``
      );
    }

    // Limite máximo por comando
    let MAX_KICKS = DEFAULT_MAX_KICKS;
    let exigirConfirmacao = true; // padrão: exigir confirmação do autor antes de expulsar
    try {
      const server = await database.Server.get(message.guild.id);
      MAX_KICKS = server?.moderation?.maxKicksPerCommand || DEFAULT_MAX_KICKS;
      exigirConfirmacao = server?.moderation?.kickConfirm !== false;
    } catch {}

    if (ids.length > MAX_KICKS) {
      return message.reply(`${emojis.cross_anim} Você pode expulsar no máximo ${MAX_KICKS} usuários por comando.`);
    }

    const kickReason = `${motivo} (Expulso por ${message.author.username}#${message.author.discriminator})`;

    // Hierarquia do autor: o dono do servidor ignora a checagem de cargos
    const authorIsOwner = message.author.id === message.guild.ownerId;
    const authorPosition = getHighestRolePosition(message.member);

    // Confirmação final (opcional, ativada por servidor), logo antes de executar
    if (exigirConfirmacao) {
      const alvos = ids
        .map((id) => `- <@${id}> (\`${id}\`)`)
        .join('\n');
      const motivoPreview = motivo.length > 200 ? `${motivo.slice(0, 200)}…` : motivo;

      const decision = await confirmAuthor({
        message,
        promptText:
          `Confirma expulsar ${ids.length} usuário(s)?\n${alvos}\n` +
          `Motivo: ${motivoPreview}\n` +
          `Reaja com ${CONFIRM_EMOJI} para confirmar ou ${SKIP_EMOJI} para cancelar. (${PROMPT_TIME_MS / 1000}s)`,
      });

      if (decision === 'timeout') {
        return message.reply(`${emojis.cross_anim} Tempo esgotado. Expulsão cancelada.`);
      }
      if (decision === 'cancel') {
        return message.reply(`${emojis.cross_anim} Expulsão cancelada.`);
      }
    }

    const kickResults = [];

    for (const userId of ids) {
      if (userId === message.author.id) {
        kickResults.push({ userId, success: false, reason: 'você não pode se expulsar' });
        continue;
      }

      if (userId === client.user.id) {
        kickResults.push({ userId, success: false, reason: 'você não pode me expulsar' });
        continue;
      }

      if (userId === message.guild.ownerId) {
        kickResults.push({ userId, success: false, reason: 'você não pode expulsar o dono do servidor' });
        continue;
      }

      const member = message.guild.members.get(userId);

      // Kick só faz sentido para quem está no servidor
      if (!member) {
        kickResults.push({ userId, success: false, reason: 'usuário não encontrado no servidor' });
        continue;
      }

      // Hierarquia do AUTOR: precisa ter cargo estritamente acima do alvo
      if (!authorIsOwner && getHighestRolePosition(member) >= authorPosition) {
        kickResults.push({ userId, success: false, reason: 'o cargo mais alto dele é igual ou superior ao seu' });
        continue;
      }

      // Hierarquia/permissão do BOT
      if (!member.kickable) {
        kickResults.push({ userId, success: false, reason: 'não posso expulsar este usuário (o cargo dele está acima do meu ou igual)' });
        continue;
      }

      try {
        await member.kick();
        kickResults.push({ userId, success: true });
      } catch (error) {
        kickResults.push({ userId, success: false, reason: `erro ao tentar expulsar: \`${error.message}\`` });
      }
    }

    // Resumo
    const successKicks = kickResults.filter(r => r.success);
    const failedKicks = kickResults.filter(r => !r.success);

    let summaryMessage = '';

    if (successKicks.length > 0) {
      summaryMessage += `${emojis.check_anim} ${successKicks.length} expulsão(ões) realizada(s) com sucesso:\n`;
      summaryMessage += successKicks.map(r => `- <@${r.userId}>`).join('\n');
      summaryMessage += `\nMotivo: ${motivo}\n`;
    }

    if (failedKicks.length > 0) {
      summaryMessage += `\n${emojis.cross_anim} Falha ao expulsar:\n`;
      summaryMessage += failedKicks.map(r => `- <@${r.userId}> (${r.reason})`).join('\n');
    }

    await message.reply(summaryMessage.trim());
  },
};
