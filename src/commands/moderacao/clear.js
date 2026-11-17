import { PermissionFlags } from '@fluxerjs/core';
// Comando de clear, que permite apagar mensagens em massa em um canal de texto.
// Este comando é útil para moderadores e administradores que desejam manter o chat limpo e organizado.
// O comando aceita um número como argumento, que indica quantas mensagens devem ser apagadas, com um limite máximo de 100 mensagens por vez
// Aceita também, opcionalmente, a menção ou ID de um usuário, para apagar apenas as mensagens desse usuário específico.
export default {
  name: 'clear',
  aliases: ['cl, clean, limpar'],
  categoria: 'moderacao',
  descricao: 'Apaga mensagens em massa em um canal de texto.',
  uso: 'clear [quantidade] <usuário>',
  exemplos: ['clear 10', 'clear 50 @usuario', 'clear 100 123456789012345678'],

  async execute({ client, message, prefixo }) {
    // Verifica se o usuário tem permissão para gerenciar mensagens
    if (!message.member.permissions.has('MANAGE_MESSAGES')) {
      return message.reply('Você não tem permissão para usar este comando.');
    }

    // Verifica se o bot tem permissão para gerenciar mensagens
    if (!message.guild.members.get(client.user.id).permissions.has('MANAGE_MESSAGES')) {
      return message.reply('Eu não tenho permissão para gerenciar mensagens neste servidor.');
    }

    // Obtém os argumentos do comando
    const args = message.content.trim().split(/ +/).slice(1);
    const quantidade = parseInt(args[0], 10);
    const usuario = message.mentions[0] || (args[1] ? await client.users.fetch(args[1]).catch(() => null) : null);

    if (!args[0]) {
        return message.reply(`Uso correto: \`${prefixo}${this.uso}\``);
    }

    // Verifica se a quantidade é válida
    if (isNaN(quantidade) || quantidade < 1 || quantidade > 100) {
      return message.reply(`${client.brain.emojis.cross_anim} Por favor, forneça um número válido entre 1 e 100 para a quantidade de mensagens a serem apagadas.`);
    }

    // Apaga a mensagem do comando para evitar que ela seja contada na limpeza
    await message.delete();

    // Busca as últimas 100 mensagens do canal (limite máximo do Fluxer para bulkDelete)
    const messages = await message.channel.messages.fetch({ limit: 100 });

    // Filtra as mensagens se um usuário específico foi mencionado
    let messagesToDelete = usuario ? messages.filter(msg => msg.author.id === usuario.id) : messages;

    // Se não houver mensagens para apagar, envia uma mensagem de aviso
    if (messagesToDelete.size === 0) {
      return message.channel.send(`${client.brain.emojis.cross_anim} Não há mensagens suficientes para apagar com os critérios fornecidos.`);
    }

    // Limita a quantidade de mensagens a serem apagadas ao número fornecido pelo usuário
    // Filtra as mensagens para pegar apenas as que não estão fixadas
    // Transforma em um array de IDs
    messagesToDelete = messagesToDelete.first(quantidade).filter(msg => !msg.pinned).map(msg => msg.id);

    // Apaga as mensagens filtradas
    try {
      await message.channel.bulkDelete(messagesToDelete);
      const deletedCount = messagesToDelete.length;

      if (deletedCount === 0) {
        return message.channel.send(`${client.brain.emojis.cross_anim} Não consegui apagar nenhuma mensagem.\n- Mensagens fixadas são protegidas pelo bot\n- Mensagens mais antigas que 14 dias não podem ser apagadas`);
      }

      if (deletedCount < quantidade) {
        return message.channel.send(`${client.brain.emojis.neutral_anim} Apenas ${deletedCount}/${quantidade} mensagens foram apagadas.\n- Mensagens fixadas são protegidas pelo bot\n- Mensagens mais antigas que 14 dias não podem ser apagadas`);
      }

      return message.channel.send(`${client.brain.emojis.check_anim} ${deletedCount} mensagens foram apagadas com sucesso.`);
    } catch (error) {
      console.error('Erro ao apagar mensagens:', error);
      return message.channel.send(`${client.brain.emojis.cross_anim} Ocorreu um erro ao tentar apagar as mensagens. Certifique-se de que as mensagens não estão fixadas ou não são mais antigas que 14 dias.`);
    }
  }
};
