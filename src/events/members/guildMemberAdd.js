import { Events } from '@fluxerjs/core';
import { handleMemberJoin } from '../../services/inviteService.js';

export default {
  name: Events.GuildMemberAdd,
  once: false,

  async execute(client, member) {
    await handleMemberJoin(client, client.brain.database, member);
  },
};
