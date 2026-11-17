export default {
  name: 'serverinfo',
  aliases: ['server-info', 'si'],
  categoria: 'info',
  descricao: 'Exibe informações detalhadas sobre o servidor.',
  uso: 'ping',
  exemplos: ['server-info', 'si'],

  async execute({ client, message, args }) {
    // Vamos fazer um sistema de informações detalhadas e bem completinhas, com sistema de paginação, para exibir informações sobre o servidor.
    if (!message.guild.id) {
      await message.reply(`${client.brain.emojis.cross_anim} Este comando só pode ser usado dentro de um servidor.`);
      return;
    }

    const { database, emojis, paginate, config } = client.brain;

    let serverId = args[0] || message.guild.id;
    let servidor = await database.Server.get(serverId);
    let guild = client.guilds.cache.get(serverId);

    if (!guild) {
      await message.reply(`${emojis.cross_anim} Não consegui encontrar este servidor. Provavelmente eu não estou lá!`);
      return;
    }

    // Definimos onde ficarão as informações do servidor, separadas por páginas
    const info = [];

    let listagem = "";
    let listagemCount = 1;

    // Listagem de páginas
    listagem += `> **${listagemCount}** - Introdução e listagem de páginas\n`
    listagemCount++;

    // Informações básicas do servidor
    listagem += `> **${listagemCount}** - Informações básicas do servidor`
    listagemCount++;

    if (servidor?.cadastroCompleto) {
      // Informações do cadastro do servidor na network CAF
      listagem += `\n> **${listagemCount}** - Informações do cadastro na network CAF`
      listagemCount++;
    }

    listagemCount = 1; // Resetando o contador para exibir na listagem de páginas

    // Página: Introdução - listagem de páginas
    info.push(
        `**${listagemCount}. Páginas disponíveis \\📄**\n` +
        `${listagem}\n` +
        `Use as reações para navegar entre as páginas.`
    );
    listagemCount++;

    // Página: Informações básicas do servidor (referência: Fluxer.js)
    info.push(
        `**${listagemCount}. Informações básicas do servidor \\📋**\n` +
        `> \\🏷️ Nome do servidor: \`${guild.name}\`\n` +
        `> \🆔 ID do servidor: \`${guild.id}\`\n` +
        `> \👑 Dono do servidor: <@${guild.ownerId}> (\`${guild.ownerId}\`)\n` +
        `> \📅 Criado em: <t:${Math.floor(guild.createdTimestamp / 1000)}:F> (<t:${Math.floor(guild.createdTimestamp / 1000)}:R>)\n` +
        `> \👥 Membros: \`${guild.memberCount}\`\n` +
        `> \📌 Cargos: \`${guild.roles.cache.size}\`\n` +
        `> \📁 Canais: \`${guild.channels.cache.size}\`\n` +
        `> \🖼️ Emojis: \`${guild.emojis.cache.size}\`\n` +
        `> \🎨 Ícone do servidor: ${guild.iconURL() ? `[Clique aqui](${guild.iconURL()})` : 'Nenhum'}\n` +
        `> \🖼️ Banner do servidor: ${guild.bannerURL() ? `[Clique aqui](${guild.bannerURL()})` : 'Nenhum'}\n`
    );
    listagemCount++;

    if (servidor?.cadastroCompleto) {
        // Página: Informações do cadastro do servidor na network CAF
        info.push(
            `**${listagemCount}. Informações do cadastro na network CAF \\📝**\n` +
            `> \\📝 Cadastro completo: ${servidor.cadastroCompleto ? emojis.check_system : emojis.cross_system}\n` +
            `> \🔗 Sincronização de banimentos: ${servidor.banSync ? emojis.ligado : emojis.desligado}\n` +
            `> \⚙️ Prefixo do servidor: \`${servidor.prefix || config.prefix}\`\n`
        );
        listagemCount++;
    }

    var iconURL = guild.iconURL({ dynamic: true, size: 1024 });
    if (iconURL) {
        // Trocar a extensão para .gif (ela pode não ser a última coisa da URL, então vamos usar regex para substituir a extensão)
        iconURL = iconURL.replace(/\.(png|jpg|jpeg|webp)(?=[?#]|$)/i, '.gif');
    }

    // Chamando a função de paginação
    await paginate(client, message, message.author, info, {
      itemsPerPage: 1,
      timeout: 5 * 60000, // 5 minutos
      embed: {
        titulo: `Informações do Servidor - ${guild.name}`,
        cor: '#36b7a5',
        // thumbnail: guild.iconURL() || null,
      }
    });
        
  },
};
