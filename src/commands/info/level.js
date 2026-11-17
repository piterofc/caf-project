import { getLeaderboard, getProfile } from '../../services/levelingService.js';

export default {
  name: 'level',
  aliases: ['rank', 'xp', 'nivel'],
  categoria: 'info',
  descricao: 'Exibe seu nível ou o ranking de XP do servidor.',
  uso: 'level [top|@usuário]',
  exemplos: ['level', 'level top', 'level @User'],

  async execute({ client, message, args }) {
    if (!message.guildId) {
      await message.reply('Este comando só pode ser usado em um servidor.');
      return;
    }

    if (args[0]?.toLowerCase() === 'top' || args[0]?.toLowerCase() === 'ranking') {
      const leaderboard = await getLeaderboard(client, message.guildId);
      if (!leaderboard.length) {
        await message.reply('Ainda não há membros com XP neste servidor.');
        return;
      }
      const lines = leaderboard.map((profile, index) => `**${index + 1}.** <@${profile.userId}> — nível **${profile.level}**, **${profile.xp} XP**`);
      await message.reply(`**Ranking de níveis**\n${lines.join('\n')}`);
      return;
    }

    const user = message.mentions?.[0] ?? (args[0] ? await client.users.fetch(args[0]).catch(() => null) : null) ?? message.author;
    const profile = await getProfile(client, message.guildId, user.id);
    await message.reply(`**Nível de ${user.username}**\nNível: **${profile.level}**\nXP: **${profile.xpInLevel}/${profile.xpToNextLevel}**\nXP total: **${profile.xp}**`);
  },
};
