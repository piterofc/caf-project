import { Events } from '@fluxerjs/core';
import { registerGiveawayEntry } from '../../services/giveawayService.js';

export default {
  name: Events.MessageReactionAdd,
  once: false,

  async execute(client, payload) {
    await registerGiveawayEntry(client, client.brain.database, payload);
  },
};
