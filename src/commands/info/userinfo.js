export default {
  name: 'userinfo',
  aliases: ['user-info', 'ui'],
  categoria: 'info',
  descricao: 'Exibe informações detalhadas sobre um usuário.',
  uso: 'userinfo <@usuário|ID>',
  exemplos: ['userinfo @User', 'ui 123456789012345678'],

  async execute({ client, message, args }) {
    const { database, emojis, paginate } = client.brain;

    let user = message.mentions[0] || await (args[0] ? await client.users.fetch(args[0]).catch(() => null) : null) || message.author;
    if (!user) {
      await message.reply(`${emojis.cross_anim} Não consegui encontrar este usuário.`);
      return;
    }

    // Definimos onde ficarão as informações do usuário, separadas por páginas
    const info = [];

    let listagem = "";
    let listagemCount = 1;

    // Listagem de páginas
    listagem += `> **${listagemCount}** - Introdução e listagem de páginas\n`
    listagemCount++;

    // Informações básicas do usuário
    listagem += `> **${listagemCount}** - Informações básicas do usuário`
    listagemCount++;

    listagemCount = 1; // Resetando o contador para exibir na listagem de páginas

    // Página: Introdução - listagem de páginas
    info.push(
        `**${listagemCount}. Páginas disponíveis \\📄**\n` +
        `${listagem}\n` +
        `Use as reações para navegar entre as páginas.`
    );
    listagemCount++;

    // Página: Informações básicas do usuário
    info.push(
        `**${listagemCount}. Informações básicas do usuário \\📋**\n` +
        `> \\📧 Nome de usuário: \`${user.username}#${user.discriminator}\`\n` +
        `> \🆔 ID do usuário: \`${user.id}\`\n` +
        `> \📅 Criado em: <t:${Math.floor(user.createdTimestamp / 1000)}:F> (<t:${Math.floor(user.createdTimestamp / 1000)}:R>)\n` +
        `> \🎨 Avatar do usuário: ${user.displayAvatarURL() ? `[Clique aqui](${user.displayAvatarURL({ dynamic: true, size: 1024 })})` : 'Nenhum'}\n` +
        `> \🖼️ Banner do usuário: ${user.bannerURL() ? `[Clique aqui](${user.bannerURL({ dynamic: true, size: 1024 })})` : 'Nenhum'}\n` +
        `> \🤖 Bot: ${user.bot ? 'Sim' : 'Não'}`
        // `> \📝 Status do usuário: \`${user.presence?.status || 'offline'}\`\n` +
        // `> \💬 Atividade do usuário: \`${user.presence?.activities?.[0]?.name || 'Nenhuma'}\`\n`
    );

    // Chamando a função de paginação
    await paginate(client, message, message.author, info, {
      itemsPerPage: 1,
      timeout: 5 * 60000, // 5 minutos
      embed: {
        titulo: `Informações do Usuário - ${user.username}`,
        cor: '#36b7a5',
        // thumbnail: user.displayAvatarURL() || null,
      }
    });

  }
}
