import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { EVENTHANDLER_PREFIX } from '../../utils/loggerPrefixes.js';

const pastaEventos = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../events',
);

async function buscarArquivos(pasta) {
  const itens = await readdir(pasta, { withFileTypes: true });
  const arquivos = [];

  for (const item of itens) {
    const caminho = path.join(pasta, item.name);

    if (item.isDirectory()) {
      arquivos.push(...await buscarArquivos(caminho));
    } else if (item.name.endsWith('.js')) {
      arquivos.push(caminho);
    }
  }

  return arquivos;
}

export default async function carregarEventos(client) {
  if (!client.brain) {
    throw new Error('Defina client.brain antes de carregar os eventos.');
  }

  console.info(EVENTHANDLER_PREFIX, 'Carregando eventos...');

  let arquivos = [];
  try {
    arquivos = await buscarArquivos(pastaEventos);
  } catch (error) {
    // A pasta de eventos pode ainda não existir enquanto o bot está sendo criado.
    if (error.code !== 'ENOENT') throw error;
  }

  for (const arquivo of arquivos) {
    const { default: evento } = await import(pathToFileURL(arquivo).href);

    if (!evento?.name || typeof evento.execute !== 'function') continue;

    const executar = async (...args) => {
      try {
        await evento.execute(client, ...args);
      } catch (error) {
        console.error(EVENTHANDLER_PREFIX, `Erro no evento ${evento.name}:`, error);
      }
    };

    if (evento.once) {
      client.once(evento.name, executar);
    } else {
      client.on(evento.name, executar);
    }
  }

  console.success(EVENTHANDLER_PREFIX, `${arquivos.length} evento(s) carregado(s).`);
}
