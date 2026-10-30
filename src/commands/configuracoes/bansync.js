export default {
  name: 'bansync',
  aliases: ['ban-sync'],
  categoria: 'configuracoes',
  descricao: 'Ativa ou desativa a sincronização de banimentos do servidor com a network CAF.',
  uso: 'bansync <ativar|desativar|status>',
  exemplos: [
    'bansync ativar',
    'bansync desativar',
    'bansync status'
  ],

  async execute({ client, message, args, prefixo }) {
    if (!message.guildId) {
      await message.reply(`${emojis.cross_anim} Este comando só pode ser usado dentro de um servidor.`);
      return;
    }

    const { database, emojis } = client.brain;
    const servidor = await database.Server.get(message.guildId);

    const acao = args[0]?.toLowerCase();

    if (['ativar', 'ligar', 'on'].includes(acao)) {
      if (servidor?.banSync) {
        await message.reply(`${emojis.neutral_anim} A sincronização de banimentos já está **ativada** neste servidor.`);
        return;
      }

      const resultado = await database.Server.toggleBanSync(message.guildId);
      if (resultado.success) {
        await message.reply(`${emojis.check_anim} A sincronização de banimentos foi **ativada** com sucesso neste servidor.`);
      }
      return;
    }

    if (['desativar', 'desligar', 'off'].includes(acao)) {
      if (!servidor?.banSync) {
        await message.reply(`${emojis.neutral_anim} A sincronização de banimentos já está **desativada** neste servidor.`);
        return;
      }

      const resultado = await database.Server.toggleBanSync(message.guildId);
      if (resultado.success) {
        await message.reply(`${emojis.check_anim} A sincronização de banimentos foi **desativada** com sucesso neste servidor.`);
      }
      return;
    }

    if (acao == 'status') {
      let status = servidor?.banSync ? 'ativada' : 'desativada';
      let emoji = servidor?.banSync ? emojis.ligado : emojis.desligado;
      await message.reply(`${emoji} A sincronização de banimentos está atualmente **${status}** neste servidor.`);
      return;
    }

    await message.reply(`${emojis.cross_system} Use \`${prefixo}${this.uso}\` para ativar, desativar ou verificar o status da sincronização de banimentos.`);
  },
};
