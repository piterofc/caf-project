import { Events } from '@fluxerjs/core';

import { verificarComando } from '../../brain/handlers/commandHandler.js';

async function verificarMencao(message) {
  const botId = message.client.user?.id;
  if (!botId) return false;

  const mencaoRegex = new RegExp(`^<@!?${botId}>\\s*`);
  return mencaoRegex.test(message.content);
}

export default {
  name: Events.MessageCreate,
  once: false,

  async execute(client, message) {
    await verificarMencao(message).then(async (mencionado) => {
      if (mencionado) {
        const brain = client.brain;

        // Se o servidor não estiver cadastrado e não estiver na lista de bypass, envia uma mensagem de aviso
        if (message.guildId && !brain.config.bypassCadastroIds.includes(message.guildId)) {
          const servidor = await brain.database.Server.get(message.guildId);
          if (!servidor || !servidor?.cadastroCompleto || Object.keys(servidor).length == 0) {
            await message.reply(`Este servidor não está cadastrado na lista de servidores do CAF.`);
            return;
          }
        }

        const prefixo = await brain.database.Server.getPrefix(message.guildId) || brain.config.prefix;
        await message.reply(`Olá! Meu prefixo neste servidor é \`${prefixo}\`.\nUse \`${prefixo}help\` para ver meus comandos.`);
      }
    });

    await verificarComando(client, message);
  },
};
