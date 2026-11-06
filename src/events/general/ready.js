import { Events } from '@fluxerjs/core';
import brain from '../../brain/brain.js';

import { CLIENT_PREFIX, GIVEAWAY_PREFIX, INVITES_PREFIX } from '../../utils/loggerPrefixes.js';
import { processGiveaways } from '../../services/giveawayService.js';
import { initializeInvites } from '../../services/inviteService.js';

async function rotacionarStatus(client) {
  // Agora vamos fazer a rotação de status do bot, para que ele fique alternando entre os status definidos no arquivo de configuração
  const statusList = brain.config.statusConfig.list || [];
  let index = 0;

  async function atualizarStatus() {
    if (statusList.length == 0) return;
    const status = statusList[index];

    // Pegar dados da brain para substituir variáveis no texto do status
    const { database } = brain;

    let numServidores = (await database.Server.getAllComplete()).length || "???";

    // Substituímos variáveis no texto do status, caso existam
    const textoStatus = status.text
      .replace('{{num_servidores}}', numServidores);

    client.user?.setPresence({ status: status.status, customStatus: { text: textoStatus } });

    index = (index + 1) % statusList.length;
  }

  // Atualizamos o status imediatamente ao iniciar
  setTimeout(async () => {
    await atualizarStatus();
  }, 3000);

  // E depois atualizamos a cada intervalo definido na configuração
  setInterval(atualizarStatus, brain.config.statusConfig.interval || 15000); // Intervalo padrão de 15 segundos
}

async function sairDeServers(client) {
  const servidores = client.guilds.cache;

  async function sair() {
    for (const [guildId, guild] of servidores) {
      if (!brain.config.sairDeServers.bypassIds.includes(guildId)) {
        const servidor = await brain.database.Server.get(guildId);
        if (!servidor || Object.keys(servidor).length == 0) {
          console.warn(CLIENT_PREFIX, `Saindo do servidor ${guild.name} (${guildId}) porque não está cadastrado na lista de servidores do CAF.`);
          try {
            await client.user.leaveGuild(guildId);
            console.success(CLIENT_PREFIX, `Saí do servidor ${guild.name} (${guildId}) com sucesso.`);
          } catch (error) {
            console.error(CLIENT_PREFIX, `Erro ao sair do servidor ${guild.name} (${guildId}):`, error);
          }
        }
      }
    }
  }

  // Verificamos os servidores não cadastrados imediatamente ao iniciar
  setTimeout(async () => {
    await sair();
  }, 3000);

  // E depois atualizamos a cada intervalo definido na configuração
  setInterval(sair, brain.config.sairDeServers.interval || 15000); // Intervalo padrão de 15 segundos
}

async function iniciarGiveaways(client) {
  async function verificar() {
    try {
      await processGiveaways(client, brain.database);
    } catch (error) {
      console.error(GIVEAWAY_PREFIX, 'Erro ao verificar giveaways:', error);
    }
  }

  // Verificamos imediatamente ao iniciar (publica agendados e encerra os que venceram com o bot offline)
  await verificar();

  // E depois verificamos a cada intervalo definido na configuração
  setInterval(verificar, brain.config.giveawayConfig?.interval || 15000); // Intervalo padrão de 15 segundos
}

async function iniciarConvites(client) {
  try {
    // Carrega os usos conhecidos e sincroniza os convites de cada servidor (os que chegarem depois são sincronizados pelo evento guildCreate)
    await initializeInvites(client, brain.database);
  } catch (error) {
    console.error(INVITES_PREFIX, 'Erro ao iniciar o sistema de convites:', error);
  }
}

export default {
  name: Events.Ready,
  once: true,

  async execute(client) {
    // Avisamos que o bot está pronto e online
    console.success(CLIENT_PREFIX, `Bot ${client.user?.username}#${client.user?.discriminator} está pronto e online!`);

    // Rotação de status
    await rotacionarStatus(client);

    // Verifica se o bot está em servidores não cadastrados e sai deles
    await sairDeServers(client);

    // Publica/encerra giveaways automaticamente
    await iniciarGiveaways(client);

    // Sincroniza os convites dos servidores (usado para descobrir qual convite cada membro usou)
    await iniciarConvites(client);
  },
};