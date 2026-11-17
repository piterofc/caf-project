import { Client } from '@fluxerjs/core';

export const client = new Client({
  presence: {
    status: 'online',
    customStatus: { text: '🚀 Iniciando...' }
  }
});

export default {
    client
};