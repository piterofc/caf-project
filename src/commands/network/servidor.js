import { hasSomeRole } from '../../utils/hasSomeRole.js';
import { EmbedBuilder } from '@fluxerjs/core';

export default {
  name: 'servidor',
  aliases: ['server', 'servers', 'srv'],
  categoria: 'network',
  descricao: 'Gerencia a lista global de servidores do bot.',
  uso: 'servidor [add|rem|listar] <id-do-servidor>',
  exemplos: [
    'servidor cadastrar 123456789012345678',
    'servidor excluir 123456789012345678',
    'servidor listar'
  ],

  async execute({ client, message, args, prefixo }) {
    const { database, config, emojis, paginate } = client.brain;

    try {
      const autorizado = await hasSomeRole(client, message.author.id, config.mainGuildId, config.cargosPermitidos.cmd_servidor);
      if (!autorizado) {
        await message.reply(`${emojis.cross_system} Você não tem permissão para usar este comando.`);
        return;
      }
    } catch (e) {
      await message.reply(`${emojis.cross_anim} Não foi possível verificar os seus cargos no servidor principal.\n\`\`\`${e}\`\`\``);
      return;
    }

    const acao = args[0]?.toLowerCase();

    if (['cadastrar', 'registrar', 'adicionar', 'add'].includes(acao)) {
      const serverId = args[1];

      if (!serverId) {
        await message.reply(`${emojis.cross_anim} Use \`${prefixo}${this.uso}\`.`);
        return;
      }

      // Verifica se o servidor já está cadastrado
      const servidorExistente = await database.Server.get(serverId);

      // Verifica se o bot está no servidor
      const guild = client.guilds.cache.get(serverId);

      // Se o servidor já estiver cadastrado, verifica se o cadastro está completo
      if (servidorExistente) {
        // Se tiver, avisamos
        if (servidorExistente.cadastroCompleto) {
          await message.reply(`${emojis.check_system} Este servidor já está cadastrado na lista de servidores do CAF.`);
          return;
        } else {
          // Se não, verificamos se ele pode ser completado
          if (guild) {
            // Se o bot estiver no servidor, atualiza o cadastro para completo
            let resultado = await database.Server.dbFunctions._update(serverId, { cadastroCompleto: true });
            if (resultado.success) {
              await message.reply(`${emojis.check_anim} Cadastro de servidor concluído com sucesso!`);
            } else {
              await message.reply(`${emojis.cross_anim} Falha ao concluir o cadastro do servidor. Motivo: ${resultado.message}`);
            }
            return;
          } else {
            // Se não, avisamos que precisa add o bot e executar o comando novamente
            await message.reply(`${emojis.neutral_anim} Servidor em processo de cadastro. Por favor, adicione o bot ao servidor que deseja cadastrar e execute o comando novamente para concluir o cadastro!`);
            return;
          }
        }
      }

      // Se o servidor não estiver cadastrado, cria um novo registro
      const resultado = await database.Server.create(serverId, {
        prefix: config.prefix,
        banSync: false,
        cadastroCompleto: false,
      });

      if (resultado.success) {
        await message.reply(`${emojis.check_anim} Cadastro de servidor iniciado!\nPor favor, adicione o bot ao servidor que deseja cadastrar e execute o comando novamente para concluir o cadastro!`);
      } else {
        await message.reply(`${emojis.cross_anim} Falha ao cadastrar o servidor. Motivo: ${resultado.message}`);
      }
      return;
    }

    if (['excluir', 'deletar', 'remover', 'remove', 'rem'].includes(acao)) {
      const serverId = args[1];

      if (!serverId) {
        await message.reply(`${emojis.cross_anim} Use \`${prefixo}${this.uso}\`.`);
        return;
      }

      const resultado = await database.Server.delete(serverId);

      if (resultado.success) {
        await message.reply(`${emojis.check_anim} Servidor removido da lista de servidores do CAF com sucesso!`);
      } else {
        await message.reply(`${emojis.cross_anim} Falha ao remover o servidor. Motivo: ${resultado.message}`);
      }
      return;
    }

    if (['listar', 'lista', 'list'].includes(acao)) {
      const allServers = await database.Server.getAll();
      if (allServers.length === 0) {
        await message.reply('Nenhum servidor cadastrado.');
        return;
      }

      const serverList = allServers.map((server) => {
        let banSyncEmoji = server.value.banSync ? emojis.ligado : emojis.desligado;
        let serverPlaceholder = client.guilds.cache.get(server.id) ? client.guilds.cache.get(server.id).name : null;
        let cadastroStatusEmoji = server.value.cadastroCompleto ? emojis.check_system : emojis.cross_system;
        if (!serverPlaceholder) {
          return (
`<:text_curve2:1564519829136748544> ${server.id}\r
<:text_linecurve1:1564512636136062977> Prefixo: \`${server.value.prefix}\`\r
<:text_linecurve1:1564512636136062977> Cadastro concluído: ${cadastroStatusEmoji}\r
<:text_curve1:1564512636136062976> BanSync ${banSyncEmoji}\n`
          );
        }
        return (
`<:text_curve2:1564519829136748544> ${serverPlaceholder}\r
<:text_linecurve1:1564512636136062977> ID: \`${server.id}\`\r
<:text_linecurve1:1564512636136062977> Prefixo: \`${server.value.prefix}\`\r
<:text_linecurve1:1564512636136062977> Cadastro concluído: ${cadastroStatusEmoji}\r
<:text_curve1:1564512636136062976> BanSync ${banSyncEmoji}\n`
        );
      });

      // Chamando a função de paginação
      await paginate(client, message, message.author, serverList, {
        itemsPerPage: 5,
        timeout: 5 * 60000, // 5 minutos
        embed: {
          titulo: 'Servidores Cadastrados',
          cor: '#36b7a5'
        }
      });
      return;
    }

    if (['informacao', 'informação', 'info', 'sobre', 'ver', 'view'].includes(acao)) {
      var serverId = args[1];

      /*
      if (!serverId) {
        await message.reply(`${emojis.cross_anim} Use \`${prefixo}${this.uso}\`.`);
        return;
      }
      */
      if (!serverId) {
        // Se não for passado o ID do servidor, usamos o ID do servidor atual
        if (message.guildId) {
          serverId = message.guildId;
        } else {
          await message.reply(`${emojis.cross_anim} Use \`${prefixo}${this.uso}\`.`);
          return;
        }
      }

      const servidor = await database.Server.get(serverId);

      if (!servidor) {
        await message.reply(`${emojis.cross_anim} Servidor não encontrado na lista de servidores do CAF.`);
        return;
      }

      let banSyncEmoji = servidor.banSync ? emojis.ligado : emojis.desligado;
      let cadastroStatusEmoji = servidor.cadastroCompleto ? emojis.check_system : emojis.cross_system;

      let serverPlaceholder = client.guilds.cache.get(serverId) ? client.guilds.cache.get(serverId).name : null;

      let infoEmbed = new EmbedBuilder()
        .setTitle('Informações do Servidor')
        .setColor('#00ff00')
        .addFields(
          { name: 'ID do Servidor', value: `\`${serverId}\``, inline: true },
          { name: 'Prefixo', value: `\`${servidor.prefix}\``, inline: true },
          { name: '\u200B', value: '\u200B', inline: true }, // Campo vazio para espaçamento
          { name: 'Cadastro Concluído', value: cadastroStatusEmoji, inline: true },
          { name: 'BanSync', value: banSyncEmoji, inline: true },
          { name: '\u200B', value: '\u200B', inline: true }, // Campo vazio para espaçamento
        );

      if (serverPlaceholder) {
        infoEmbed.setDescription(`Nome do Servidor: **${serverPlaceholder}**`);
      }

      await message.reply({ embeds: [infoEmbed] });
      return;
    }

    await message.reply(`${emojis.cross_system} Use \`${prefixo}${this.uso}\`.`);
  },
};

/*
      if (!serverPlaceholder) {
        await message.reply(`\\🔘 ${serverId}\n<:text_linecurve1:1564512636136062977> Cadastro concluído: ${cadastroStatusEmoji}\n<:text_linecurve1:1564512636136062977> Prefixo: \`${servidor.prefix}\`\n<:text_curve1:1564512636136062976> BanSync ${banSyncEmoji}\n`);
        return;
      }
      await message.reply(`\\🔘 ${serverPlaceholder}\n<:text_linecurve1:1564512636136062977> ID: \`${serverId}\`\n<:text_linecurve1:1564512636136062977> Cadastro concluído: ${cadastroStatusEmoji}\n<:text_linecurve1:1564512636136062977> Prefixo: \`${servidor.prefix}\`\n<:text_curve1:1564512636136062976> BanSync ${banSyncEmoji}\n`);
      return;
    }

    await message.reply(`${emojis.cross_system} Use \`${prefixo}${this.uso}\`.`);
  },
};
*/
