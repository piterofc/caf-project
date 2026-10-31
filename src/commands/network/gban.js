import { hasSomeRole } from '../../utils/hasSomeRole.js';

export default {
  name: 'gban',
  aliases: ['global-ban', 'ban-global'],
  categoria: 'network',
  descricao: 'Banimento global de usuários dos servidores da network CAF.',
  uso: 'gban [add|rem|listar|historico] <@usuário|ID> <motivo>',
  exemplos: [
    'gban adicionar @Usuario Motivo do banimento',
    'gban remover 123456789012345678',
    'gban listar',
    'gban historico 123456789012345678'
  ],

  async execute({ client, message, args, prefixo }) {
    const { database, config, paginate, emojis } = client.brain;

    try {
      const autorizado = await hasSomeRole(client, message.author.id, config.mainGuildId, config.cargosPermitidos.cmd_gban);
      if (!autorizado) {
        await message.reply(`${emojis.cross_system} Você não tem permissão para usar este comando.`);
        return;
      }
    } catch (e) {
      await message.reply(`${emojis.cross_anim} Não foi possível verificar os seus cargos no servidor principal.\n\`${e}\``);
      return;
    }

    const agora = Date.now();
    const acao = args[0]?.toLowerCase();

    if (['banir', 'ban', 'adicionar', 'add'].includes(acao)) {
      const user = message.mentions[0] || (args[1] ? await client.users.fetch(args[1]).catch(() => null) : null);
      const motivo = args?.slice(2).join(' ') || 'Sem motivo fornecido';

      if (!user.id) {
        await message.reply(`${emojis.cross_system} Use \`${prefixo}${this.uso}\`.`);
        return;
      }

      const resultado1 = await database.GlobalBan.add(user.id, {
        banidoPor: message.author.id,
        dataBan: new Date().toISOString(),
        motivo: motivo,
      });

      const resultado2 = await database.GlobalBanHistory.add(user.id, {
        id: `${user.id}-${agora}`, // ID único para cada ação de banimento
        acao: 'adicionar',
        realizadoPor: message.author.id,
        dataAcao: new Date().toISOString(),
        motivo: motivo
      });

      if (resultado1.success && resultado2.success) {
        await message.reply(`${emojis.check_anim} O usuário <@${user.id}> foi **banido globalmente** com sucesso!`);
      } else {
        await message.reply(`${emojis.neutral_anim} O usuário <@${user.id}> já está banido globalmente!`);
      }
      return;
    }

    if (['desbanir', 'unban', 'remover', 'remove', 'rem'].includes(acao)) {
      const user = message.mentions[0] || (args[1] ? await client.users.fetch(args[1]).catch(() => null) : null);
      const motivo = args?.slice(2).join(' ') || 'Sem motivo fornecido';

      if (!user.id) {
        await message.reply(`Use \`${prefixo}${this.uso}\`.`);
        return;
      }

      const resultado1 = await database.GlobalBan.remove(user.id);
      const resultado2 = await database.GlobalBanHistory.add(user.id, {
        id: `${user.id}-${agora}`, // ID único para cada ação de banimento
        acao: 'remover',
        realizadoPor: message.author.id,
        dataAcao: new Date().toISOString(),
        motivo: motivo
      });

      if (resultado1.success && resultado2.success) {
        await message.reply(`${emojis.check_anim} O usuário <@${user.id}> foi **desbanido globalmente** com sucesso!`);
      } else {
        await message.reply(`${emojis.neutral_anim} O usuário <@${user.id}> não está banido!`);
      }
      return;
    }

    // Listagem com paginação usando o sistema de paginação presente em /src/utils/paginacao.js
    if (['listar', 'lista', 'list'].includes(acao)) {
      const allBans = await database.GlobalBan.getAll();

      const config = {
        itemsPerPage: 3,
        timeout: 3 * 60000, // 3 minutos
        embed: {
          titulo: 'Banimentos Globais',
          cor: '#ff0000'
        }
      };

      if (allBans.length === 0) {
        await message.reply('Não há usuários banidos globalmente.');
        return;
      }

      const bans = allBans.map((ban) => {
        const banData = ban.value;
        return `- Usuário: <@${ban.id}>\n  - Banido por: <@${banData.banidoPor}>\n  - Data do Banimento: ${new Date(banData.dataBan).toLocaleString()}\n  - Motivo: ${banData.motivo}`;
      });

      // Chamando a função de paginação
      await paginate(client, message, message.author, bans, config);
      return;
    }

    // Histórico de banimentos globais de um usuário específico
    if (['histórico', 'historico', 'history', 'hist'].includes(acao)) {
      const user = message.mentions[0] || (args[1] ? await client.users.fetch(args[1]).catch(() => null) : null);

      if (!user.id) {
        await message.reply(`Use \`${prefixo}${this.uso}\`.`);
        return;
      }

      const history = await database.GlobalBanHistory.get(user.id);

      if (!history || history.length === 0) {
        await message.reply(`Não há histórico de banimentos globais para o usuário <@${user.id}>.`);
        return;
      }

      const config = {
        itemsPerPage: 5,
        timeout: 5 * 60000, // 5 minutos
        embed: {
          titulo: `Histórico de Banimentos Globais - <@${user.id}>`,
          cor: '#ff9900'
        }
      };

      const historyItems = history.map((entry) => {
        return `- Ação: ${entry.acao}\n  - Realizado por: <@${entry.realizadoPor}>\n  - Data da Ação: ${new Date(entry.dataAcao).toLocaleString()}\n  - Motivo: ${entry.motivo}`;
      });

      // Chamando a função de paginação
      await paginate(client, message, message.author, historyItems, config);
      return;
    }

    await message.reply(`${emojis.cross_system} Use \`${prefixo}${this.uso}\` para adicionar, remover ou listar banimentos globais.`);
  },
};