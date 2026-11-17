import { Events } from '@fluxerjs/core';
import { CLIENT_PREFIX } from '../../utils/loggerPrefixes.js';

export default {
  name: Events.Error,

  execute(client, error) {
    console.error(CLIENT_PREFIX, 'Erro do client:', error)
  }
};