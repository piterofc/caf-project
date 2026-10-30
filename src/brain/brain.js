// Carregamos o logger antes de qualquer outra coisa, para que ele intercepte o console.
import '../utils/logger.js';

import config from './config.js';
import database from '../db/database.js';

import { client } from './fluxerClient.js';
import carregarCmds from './handlers/commandHandler.js';
import carregarEventos from './handlers/eventHandler.js';

import emojis from './variables/emojis.json' with { type: 'json' };

import { paginate } from '../utils/pagination.js';

export default {
  config,
  client,
  carregarCmds,
  carregarEventos,
  database,
  emojis,
  paginate
};
