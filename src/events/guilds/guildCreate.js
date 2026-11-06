import { Events } from '@fluxerjs/core';
import { syncGuildInvites } from '../../services/inviteService.js';

// O Ready pode vir antes de todos os servidores chegarem: cada servidor que chega aqui tem os convites sincronizados
// (se já foi sincronizado há pouco, o service ignora).
export default {
  name: Events.GuildCreate,
  once: false,

  async execute(client, guild) {
    await syncGuildInvites(client, client.brain.database, guild, { force: false });
  },
};
