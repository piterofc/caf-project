import { Events } from '@fluxerjs/core';
import { handleInviteCreate } from '../../services/inviteService.js';

export default {
  name: Events.InviteCreate,
  once: false,

  async execute(client, invite) {
    await handleInviteCreate(client, client.brain.database, invite);
  },
};
