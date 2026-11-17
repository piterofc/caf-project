import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { CMDHANDLER_PREFIX } from '../../utils/loggerPrefixes.js';

const pastaComandos = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../commands',
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

async function pegarPrefixo(message, brain) {
  if (!message.guildId) return brain.config.prefix;

  const prefixoDoServidor = await brain.database.Server.getPrefix(message.guildId);
  return prefixoDoServidor || brain.config.prefix;
}

export default async function carregarCmds(client) {
  if (!client.brain) {
    throw new Error('Defina client.brain antes de carregar os comandos.');
  }

  console.info(CMDHANDLER_PREFIX, 'Carregando comandos...');

  client.commands = new Map();

  try {
    const arquivos = await buscarArquivos(pastaComandos);

    for (const arquivo of arquivos) {
      const { default: comando } = await import(pathToFileURL(arquivo).href);

      if (!comando?.name || typeof comando.execute !== 'function') continue;

      client.commands.set(comando.name.toLowerCase(), comando);

      for (const alias of comando.aliases ?? []) {
        client.commands.set(alias.toLowerCase(), comando);
      }
    }
  } catch (error) {
    // A pasta de comandos pode ainda não existir enquanto o bot está sendo criado.
    if (error.code !== 'ENOENT') throw error;
  }

  const totalComandos = new Set(client.commands.values()).size;
  console.success(CMDHANDLER_PREFIX, `${totalComandos} comando(s) carregado(s).`);
}

// Função para processamento de comando
export async function verificarComando(client, message) {
  if (!message.content || message.author?.bot) return;

  const brain = client.brain;
  let prefixo = brain.config.prefix;

  try {
    prefixo = await pegarPrefixo(message, brain);
  } catch (error) {
    console.error(CMDHANDLER_PREFIX, 'Erro ao obter o prefixo do servidor:', error);
  }

  if (!message.content.startsWith(prefixo)) return;

  const [nome, ...args] = message.content.slice(prefixo.length).trim().split(/\s+/);
  if (!nome) return;


  const comando = client.commands.get(nome?.toLowerCase());
  if (!comando) {
    await message.reply(`Não encontrei o comando \`${nome}\`. Use \`${prefixo}help\` para ver os comandos disponíveis.`);
    return;
  }

  // Se o servidor não estiver cadastrado e não estiver na lista de bypass, envia uma mensagem de aviso
  if (message.guildId && !brain.config.bypassCadastroIds.includes(message.guildId)) {
    const servidor = await brain.database.Server.get(message.guildId);
    if (!servidor || !servidor?.cadastroCompleto || Object.keys(servidor).length == 0) {
      await message.reply(`Este servidor não está cadastrado na lista de servidores do CAF.`);
      return;
    }
  }

  try {
    await comando.execute({ client, message, args, prefixo });
  } catch (error) {
    console.error(CMDHANDLER_PREFIX, `Erro ao executar ${comando.name}:`, error);
  }
}
