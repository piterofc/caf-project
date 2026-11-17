import { Events } from '@fluxerjs/core';
import { syncGuildInvites } from '../../services/inviteService.js';

// O servidor voltou de uma indisponibilidade: confere os convites de novo (se não foi sincronizado há pouco).
export default {
  name: Events.GuildAvailable,
  once: false,

  async execute(client, guild) {
    await syncGuildInvites(client, client.brain.database, guild, { force: false });
  },
};
