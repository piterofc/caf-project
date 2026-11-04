import { Events } from '@fluxerjs/core';
import { removeGiveawayEntry } from '../../services/giveawayService.js';

export default {
  name: Events.MessageReactionRemove,
  once: false,

  async execute(client, payload) {
    await removeGiveawayEntry(client, client.brain.database, payload);
  },
};
