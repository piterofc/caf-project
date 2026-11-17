import { Events } from '@fluxerjs/core';
import { handleMemberLeave } from '../../services/inviteService.js';

export default {
  name: Events.GuildMemberRemove,
  once: false,

  async execute(client, member) {
    await handleMemberLeave(client, client.brain.database, member);
  },
};
