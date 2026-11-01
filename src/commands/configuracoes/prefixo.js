export default {
  name: 'prefixo',
  aliases: ['prefix', 'setprefix'],
  categoria: 'configuracoes',
  descricao: 'Altera o prefixo deste servidor.',
  uso: 'prefixo <novo-prefixo>',
  exemplos: ['prefixo +', 'prefixo a!'],

  async execute({ client, message, args, prefixo }) {
    if (!message.guildId) {
      await message.reply(`${emojis.cross_anim} Este comando só pode ser usado dentro de um servidor.`);
      return;
    }

    const { database, emojis } = client.brain;
    const servidor = await database.Server.get(message.guildId);

    const novoPrefixo = args[0];
    if (!novoPrefixo) {
      // Se não for fornecido um novo prefixo, exibe o prefixo atual
      await message.reply(`O prefixo atual deste servidor é \`${servidor?.prefix || prefixo}\`.`);
      return;
    }

    const resultado = await database.Server.setPrefix(message.guildId, novoPrefixo);
    if (resultado.success) {
      await message.reply(`${emojis.check_anim} Prefixo atualizado para \`${novoPrefixo}\` com sucesso!`);
    }
  },
};
