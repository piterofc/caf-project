import { PermissionFlags, EmbedBuilder } from '@fluxerjs/core';

import { GIVEAWAY_PREFIX } from '../../utils/loggerPrefixes.js';
import {
  GiveawayError,
  cancelGiveaway,
  createGiveaway,
  editGiveaway,
  endGiveaway,
  findGiveaway,
  rerollGiveaway,
  sanitizeTemplate,
  shortId,
} from '../../services/giveawayService.js';

const PROMPT_TIME_MS = 60_000; // tempo que o bot espera cada resposta do assistente
const CONFIRM_EMOJI = '✅';
const SKIP_EMOJI = '❌';
const FUSO_PADRAO = '-03:00'; // datas digitadas sem fuso são interpretadas no horário de Brasília
const TEMPLATE_NAME_REGEX = /^[\p{L}\p{N}_-]{1,32}$/u;
const MENTION_REGEX = { cargo: /^<@&(\d{15,21})>$/, usuario: /^<@!?(\d{15,21})>$/, canal: /^<#(\d{15,21})>$/ };
const ID_REGEX = /^\d{15,21}$/;

// Nomes das opções (--nome valor). Aceita português e inglês, mas sempre guardamos o nome em português.
const FLAGS = {
  titulo: 'titulo', title: 'titulo',
  premio: 'premio', prize: 'premio',
  descricao: 'descricao', description: 'descricao',
  duracao: 'duracao', duration: 'duracao',
  ganhadores: 'ganhadores', winners: 'ganhadores',
  canal: 'canal', channel: 'canal',
  cargo: 'cargo', role: 'cargo',
  host: 'host', organizador: 'host',
  inicio: 'inicio', start: 'inicio',
  fim: 'fim', end: 'fim',
  modelo: 'modelo', template: 'modelo',
};

const STATUS_LABELS = {
  scheduled: 'agendado',
  pending: 'publicando',
  publishing: 'publicando',
  running: 'em andamento',
  ending: 'encerrando',
  ended: 'encerrado',
  cancelled: 'cancelado',
  failed: 'falhou',
};

/* -------------------------------------------------------------------------- */
/* Leitura dos argumentos                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Divide o texto em palavras, respeitando aspas: --premio "Pix de 10 reais" vira um valor só.
 * Aceita aspas retas (") e as aspas curvas que o teclado do celular costuma inserir (“ ”).
 */
function tokenize(text) {
  const tokens = [];
  let atual = '';
  let temToken = false;
  let fechamento = null;

  for (const char of text) {
    if (fechamento) {
      if (char === fechamento) fechamento = null;
      else atual += char;
      continue;
    }

    if (/\s/.test(char)) {
      if (temToken) {
        tokens.push(atual);
        atual = '';
        temToken = false;
      }
      continue;
    }

    if (!temToken && (char === '"' || char === '“')) {
      fechamento = char === '“' ? '”' : '"';
      temToken = true;
      continue;
    }

    atual += char;
    temToken = true;
  }

  if (fechamento) throw new GiveawayError('Você abriu aspas e não fechou. Feche com a mesma aspa.');
  if (temToken) tokens.push(atual);
  return tokens;
}

/** Separa o que é opção (--nome valor ou --nome=valor) do que é argumento solto (ID, data...). */
function parseArgs(tokens) {
  const positionais = [];
  const flags = {};

  for (let i = 0; i < tokens.length; i += 1) {
    const match = tokens[i].match(/^--([^=\s]+)(?:=([\s\S]*))?$/);
    if (!match) {
      positionais.push(tokens[i]);
      continue;
    }

    const chave = FLAGS[match[1].toLowerCase()];
    if (!chave) {
      throw new GiveawayError(`Opção desconhecida: \`--${match[1]}\`. Opções válidas: ${[...new Set(Object.values(FLAGS))].map((f) => `\`--${f}\``).join(', ')}.`);
    }

    let valor = match[2];
    if (valor === undefined) {
      const proximo = tokens[i + 1];
      if (proximo === undefined || /^--[^\s]/.test(proximo)) {
        throw new GiveawayError(`A opção \`--${match[1]}\` precisa de um valor.`);
      }
      valor = proximo;
      i += 1;
    }
    flags[chave] = valor;
  }

  return { positionais, flags };
}

/** "30m", "2h", "1d", "1h30m"... Número puro conta como minutos. Retorna segundos. */
function parseDuracao(valor) {
  const texto = String(valor ?? '').trim().toLowerCase().replace(/\s+/g, '');
  if (/^\d+$/.test(texto)) return Number(texto) * 60;

  const match = texto.match(/^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)(?:min|m))?(?:(\d+)s)?$/);
  if (!texto || !match || !match.slice(1).some(Boolean)) {
    throw new GiveawayError('Duração inválida. Use por exemplo `30m`, `2h`, `1d` ou `1h30m`.');
  }
  const [dias, horas, minutos, segundos] = match.slice(1).map((parte) => Number(parte ?? 0));
  return dias * 86400 + horas * 3600 + minutos * 60 + segundos;
}

/** Aceita 2026-12-24T20:00, 2026-12-24 20:00, 24/12/2026 20:00 (horário de Brasília) ou ISO completo com fuso. */
function parseData(valor, rotulo = 'data') {
  const texto = String(valor ?? '').trim();
  let iso = null;

  let match = texto.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})[ T]+(\d{1,2}):(\d{2})$/);
  if (match) {
    const [, dia, mes, ano, hora, minuto] = match;
    iso = `${ano}-${mes.padStart(2, '0')}-${dia.padStart(2, '0')}T${hora.padStart(2, '0')}:${minuto}:00${FUSO_PADRAO}`;
  } else if ((match = texto.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?$/))) {
    const [, ano, mes, dia, hora, minuto, segundo = '00'] = match;
    iso = `${ano}-${mes}-${dia}T${hora.padStart(2, '0')}:${minuto}:${segundo}${FUSO_PADRAO}`;
  } else if (/^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})$/i.test(texto)) {
    iso = texto;
  }

  let timestamp = iso ? Date.parse(iso) : NaN;

  // O JS aceita 31/02 e vira 03/03; recusamos datas que não existem no calendário
  const partes = iso?.match(/^(\d{4})-(\d{2})-(\d{2})T/);
  if (partes && !iso.endsWith('Z')) {
    const [, ano, mes, dia] = partes.map(Number);
    const conferido = new Date(Date.UTC(ano, mes - 1, dia));
    if (conferido.getUTCMonth() !== mes - 1 || conferido.getUTCDate() !== dia) timestamp = NaN;
  }

  if (!Number.isFinite(timestamp)) {
    throw new GiveawayError(`${rotulo[0].toUpperCase()}${rotulo.slice(1)} inválida. Use por exemplo \`24/12/2026 20:00\` ou \`2026-12-24T20:00\` (horário de Brasília).`);
  }
  return timestamp;
}

function parseInteiro(valor, minimo, maximo, rotulo) {
  const numero = Number(valor);
  if (!Number.isInteger(numero) || numero < minimo || numero > maximo) {
    throw new GiveawayError(`${rotulo} precisa ser um número inteiro entre ${minimo} e ${maximo}.`);
  }
  return numero;
}

function extrairId(valor, tipo) {
  const texto = String(valor ?? '').trim();
  return texto.match(MENTION_REGEX[tipo])?.[1] ?? (ID_REGEX.test(texto) ? texto : null);
}

function ehVazio(valor) {
  return ['-', 'nenhum', 'nenhuma', 'qualquer'].includes(String(valor ?? '').trim().toLowerCase());
}

/* -------------------------------------------------------------------------- */
/* Resolução de canal / cargo / organizador                                   */
/* -------------------------------------------------------------------------- */

function ehCanalDeTexto(canal) {
  if (!canal) return false;
  if (typeof canal.isTextBased === 'function') return canal.isTextBased() && typeof canal.send === 'function';
  return typeof canal.send === 'function';
}

function resolverCanal({ message, guild }, valor) {
  if (valor === undefined || ['atual', 'aqui'].includes(String(valor).trim().toLowerCase())) {
    return message.channel;
  }
  const id = extrairId(valor, 'canal');
  const canal = id ? guild.channels.cache.get(id) : null;
  if (!ehCanalDeTexto(canal)) throw new GiveawayError('Canal inválido. Use uma menção de canal (#canal), o ID do canal ou `atual`.');
  return canal;
}

/** Retorna o ID do cargo, ou null quando o usuário pediu "qualquer cargo". */
function resolverCargo({ guild }, valor) {
  if (ehVazio(valor)) return null;
  const id = extrairId(valor, 'cargo');
  if (!id) throw new GiveawayError('Cargo inválido. Use uma menção de cargo (@cargo), o ID do cargo ou `-` para qualquer cargo.');
  if (guild.roles?.cache && !guild.roles.cache.has(id)) throw new GiveawayError('Não encontrei esse cargo neste servidor.');
  return id;
}

/** Retorna o ID do organizador, ou null quando o usuário pediu "eu mesmo". */
function resolverHost(valor) {
  if (ehVazio(valor)) return null;
  const id = extrairId(valor, 'usuario');
  if (!id) throw new GiveawayError('Organizador inválido. Use uma menção (@usuário), o ID do usuário ou `-` para você.');
  return id;
}

/* -------------------------------------------------------------------------- */
/* Permissões, perguntas e confirmação (mesmo padrão dos comandos de moderação) */
/* -------------------------------------------------------------------------- */

/** Verifica uma permissão do membro. Administrator concede todas as permissões. */
function hasPermission(member, flag) {
  const permissions = member?.permissions;
  if (!permissions) return false;
  return permissions.has(flag) || permissions.has(PermissionFlags.Administrator);
}

/**
 * Faz uma pergunta ao autor do comando e espera, por até PROMPT_TIME_MS, uma mensagem dele no mesmo canal:
 * - resposta válida                  -> { type: 'answer', value }
 * - "cancelar" (ou reação em ❌)     -> { type: 'cancel' }
 * - nada                             -> { type: 'timeout' }
 * - falha ao enviar a pergunta       -> { type: 'error' }
 * Respostas inválidas recebem um aviso e a espera continua.
 */
async function askAuthor({ message, promptText, validate }) {
  let channel;
  let prompt;
  try {
    channel = message.channel ?? (await message.resolveChannel());
    prompt = await message.reply(promptText);
  } catch {
    return { type: 'error' }; // não conseguiu enviar a pergunta
  }

  return new Promise((resolve) => {
    let settled = false;

    const messageCollector = channel.createMessageCollector({
      filter: (m) => m.author.id === message.author.id,
      time: PROMPT_TIME_MS,
    });

    const reactionCollector = prompt.createReactionCollector({
      filter: (reaction, user) => user.id === message.author.id && reaction.emoji.name === SKIP_EMOJI,
      time: PROMPT_TIME_MS,
      max: 1,
    });

    const finish = (result) => {
      if (settled) return;
      settled = true;
      messageCollector.stop('user');
      reactionCollector.stop('user');
      resolve(result);
    };

    messageCollector.on('collect', async (m) => {
      const texto = (m.content ?? '').trim();
      if (['cancelar', 'cancel'].includes(texto.toLowerCase())) return finish({ type: 'cancel' });

      let resultado;
      try {
        resultado = validate(texto);
      } catch (error) {
        resultado = { ok: false, error: error instanceof GiveawayError ? error.message : 'Resposta inválida.' };
      }
      if (resultado.ok) return finish({ type: 'answer', value: resultado.value });
      await m.reply(`${resultado.error}\n-# Tente de novo ou envie \`cancelar\`.`).catch(() => {});
    });

    reactionCollector.on('collect', () => finish({ type: 'cancel' }));

    // Se algum coletor terminar por tempo, a pergunta expirou
    messageCollector.on('end', () => finish({ type: 'timeout' }));
    reactionCollector.on('end', () => finish({ type: 'timeout' }));

    // Adiciona a reação para o autor só clicar (se falhar, ele ainda pode digitar "cancelar")
    prompt.react(SKIP_EMOJI).catch(() => {});
  });
}

/**
 * Pede confirmação final ao autor, reagindo com CONFIRM_EMOJI / SKIP_EMOJI na mensagem do bot.
 * Só reações do autor do comando contam. Retorna 'confirm', 'cancel', 'timeout' ou 'error'.
 */
async function confirmAuthor({ message, prompt: promptContent }) {
  let prompt;
  try {
    prompt = await message.reply(promptContent);
  } catch {
    return 'error'; // não conseguiu enviar a pergunta
  }

  return new Promise((resolve) => {
    let settled = false;

    const collector = prompt.createReactionCollector({
      filter: (reaction, user) =>
        user.id === message.author.id &&
        (reaction.emoji.name === CONFIRM_EMOJI || reaction.emoji.name === SKIP_EMOJI),
      time: PROMPT_TIME_MS,
      max: 1,
    });

    const finish = (result) => {
      if (settled) return;
      settled = true;
      collector.stop('user');
      resolve(result);
    };

    collector.on('collect', (reaction) => {
      finish(reaction.emoji.name === CONFIRM_EMOJI ? 'confirm' : 'cancel');
    });

    // Terminou sem nenhuma reação válida: a confirmação expirou
    collector.on('end', () => finish('timeout'));

    // Adiciona as duas reações, na ordem, para o autor só clicar
    (async () => {
      await prompt.react(CONFIRM_EMOJI).catch(() => {});
      await prompt.react(SKIP_EMOJI).catch(() => {});
    })();
  });
}

/* -------------------------------------------------------------------------- */
/* Montagem dos dados de um giveaway a partir das opções                      */
/* -------------------------------------------------------------------------- */

async function carregarModelo({ database, guild }, nome) {
  if (nome === undefined) return {};
  const modelos = await database.Giveaways.getTemplates(guild.id);
  if (!Object.hasOwn(modelos, nome)) throw new GiveawayError(`Não encontrei o modelo \`${nome}\`. Veja os disponíveis com \`giveaway modelo listar\`.`);
  return modelos[nome];
}

/**
 * Converte as opções digitadas nos dados que o serviço espera.
 * `padroes` são valores de fallback do subcomando (ex.: o drop dura 60s); o modelo, se houver, vem por cima deles.
 */
async function montarEntrada(ctx, flags, padroes = {}) {
  const { message, guild } = ctx;
  const modelo = await carregarModelo(ctx, flags.modelo);
  const canal = resolverCanal(ctx, flags.canal);

  if (flags.fim !== undefined && flags.duracao !== undefined) {
    throw new GiveawayError('Informe a duração (`--duracao`) ou a data final (`--fim`), não as duas.');
  }

  const entrada = {
    guildId: guild.id,
    channelId: canal.id,
    creatorId: message.author.id,
    title: flags.titulo,
    prize: flags.premio,
    description: flags.descricao,
    winners: flags.ganhadores !== undefined ? parseInteiro(flags.ganhadores, 1, 100, 'O número de ganhadores') : undefined,
    roleId: flags.cargo !== undefined ? resolverCargo(ctx, flags.cargo) : undefined,
    hostId: (flags.host !== undefined ? resolverHost(flags.host) : null) ?? message.author.id,
    defaults: { ...padroes, ...modelo },
  };

  if (flags.fim !== undefined) entrada.endAt = parseData(flags.fim, 'data final');
  else if (flags.duracao !== undefined) entrada.duration = parseDuracao(flags.duracao);
  if (flags.inicio !== undefined) entrada.startAt = parseData(flags.inicio, 'data de início');

  return entrada;
}

/* -------------------------------------------------------------------------- */
/* Texto de ajuda                                                             */
/* -------------------------------------------------------------------------- */

function usage(prefixo) {
  return [
    '**🎁 Giveaways**',
    `\`${prefixo}giveaway criar\` — assistente passo a passo`,
    `\`${prefixo}giveaway criar --premio "Pix de 10 reais" --duracao 1h --ganhadores 2 [--titulo "..."] [--canal #canal] [--cargo @cargo] [--host @usuario] [--modelo nome]\``,
    `\`${prefixo}giveaway drop --premio "Prêmio"\` — giveaway relâmpago (60s por padrão)`,
    `\`${prefixo}giveaway agendar 24/12/2026 20:00 --premio "Prêmio" [--duracao 1h]\` — horário de Brasília`,
    `\`${prefixo}giveaway encerrar <id>\` · \`${prefixo}giveaway reroll <id> [quantidade]\` · \`${prefixo}giveaway cancelar <id>\``,
    `\`${prefixo}giveaway editar <id> [--titulo] [--premio] [--descricao] [--ganhadores] [--cargo] [--host]\` (use \`-\` em --cargo/--host para limpar)`,
    `\`${prefixo}giveaway listar\``,
    `\`${prefixo}giveaway modelo <listar|salvar|remover|exportar|importar> ...\``,
    '-# O ID é o que aparece no rodapé do giveaway (8 caracteres bastam). Duração: `30m`, `2h`, `1d`, `1h30m` (número puro = minutos).',
  ].join('\n');
}

/* -------------------------------------------------------------------------- */
/* Subcomandos                                                                */
/* -------------------------------------------------------------------------- */

async function criarPorOpcoes(ctx, flags, { padroes = {}, mensagem }) {
  const { client, message, emojis } = ctx;
  const entrada = await montarEntrada(ctx, flags, padroes);
  const giveaway = await createGiveaway(client, client.brain.database, entrada);
  return message.reply(`${emojis.check_anim} ${mensagem(giveaway)}`);
}

async function assistenteDeCriacao(ctx) {
  const { client, message, guild, emojis } = ctx;

  await message.reply(`🎁 **Criando giveaway** — vou pedir uma configuração por vez. Envie \`cancelar\` (ou reaja com ${SKIP_EMOJI}) a qualquer momento.`);

  const textoObrigatorio = (limite, rotulo) => (texto) => {
    if (!texto) return { ok: false, error: `${emojis.cross_anim} O ${rotulo} não pode ficar vazio.` };
    if (texto.length > limite) return { ok: false, error: `${emojis.cross_anim} O ${rotulo} pode ter no máximo ${limite} caracteres.` };
    return { ok: true, value: texto };
  };

  const etapas = [
    { chave: 'titulo', texto: '1️⃣ Qual será o **título**?', validar: textoObrigatorio(256, 'título') },
    { chave: 'premio', texto: '2️⃣ Qual será o **prêmio**?', validar: textoObrigatorio(256, 'prêmio') },
    { chave: 'duracao', texto: '3️⃣ Quanto **tempo** vai durar? Ex.: `30m`, `2h`, `1d`', validar: (texto) => ({ ok: true, value: parseDuracao(texto) }) },
    { chave: 'ganhadores', texto: '4️⃣ Quantos **ganhadores**? (1 a 100)', validar: (texto) => ({ ok: true, value: parseInteiro(texto, 1, 100, 'O número de ganhadores') }) },
    { chave: 'descricao', texto: '5️⃣ Qual a **descrição**? (ou `-` para usar a padrão)', validar: (texto) => (ehVazio(texto) ? { ok: true, value: undefined } : textoObrigatorio(4000, 'descrição')(texto)) },
    { chave: 'canal', texto: '6️⃣ Em qual **canal** vou publicar? Mencione o canal, envie o ID ou `atual`.', validar: (texto) => ({ ok: true, value: resolverCanal(ctx, texto) }) },
    { chave: 'cargo', texto: '7️⃣ Qual **cargo** pode participar? Mencione o cargo, envie o ID ou `-` para qualquer um.', validar: (texto) => ({ ok: true, value: resolverCargo(ctx, texto) }) },
    { chave: 'host', texto: '8️⃣ Quem é o **organizador**? Mencione o usuário, envie o ID ou `-` para você.', validar: (texto) => ({ ok: true, value: resolverHost(texto) }) },
  ];

  const respostas = {};
  for (const etapa of etapas) {
    const resposta = await askAuthor({ message, promptText: etapa.texto, validate: etapa.validar });

    if (resposta.type === 'error') return;
    if (resposta.type === 'timeout') return message.reply(`${emojis.cross_anim} Tempo esgotado. Criação cancelada.`);
    if (resposta.type === 'cancel') return message.reply(`${emojis.cross_anim} Criação cancelada.`);
    respostas[etapa.chave] = resposta.value;
  }

  const hostId = respostas.host ?? message.author.id;
  const revisao = new EmbedBuilder()
    .setTitle('✅ Revisão do giveaway')
    .setDescription(`**${respostas.titulo}**\n${respostas.descricao ?? 'Descrição padrão'}`)
    .setColor('#f1c40f')
    .addFields(
      { name: 'Prêmio', value: respostas.premio, inline: false },
      { name: 'Ganhadores', value: String(respostas.ganhadores), inline: true },
      { name: 'Duração', value: `${respostas.duracao}s`, inline: true },
      { name: 'Canal', value: `<#${respostas.canal.id}>`, inline: true },
      { name: 'Cargo elegível', value: respostas.cargo ? `<@&${respostas.cargo}>` : 'Qualquer cargo', inline: true },
      { name: 'Organizador', value: `<@${hostId}>`, inline: true },
    );

  const decisao = await confirmAuthor({
    message,
    prompt: { content: `Reaja com ${CONFIRM_EMOJI} para publicar ou ${SKIP_EMOJI} para cancelar. (${PROMPT_TIME_MS / 1000}s)`, embeds: [revisao] },
  });

  if (decisao === 'error') return;
  if (decisao === 'timeout') return message.reply(`${emojis.cross_anim} Tempo esgotado. Criação cancelada.`);
  if (decisao === 'cancel') return message.reply(`${emojis.cross_anim} Criação cancelada.`);

  const giveaway = await createGiveaway(client, client.brain.database, {
    guildId: guild.id,
    channelId: respostas.canal.id,
    creatorId: message.author.id,
    title: respostas.titulo,
    prize: respostas.premio,
    description: respostas.descricao,
    duration: respostas.duracao,
    winners: respostas.ganhadores,
    roleId: respostas.cargo,
    hostId,
  });
  return message.reply(`${emojis.check_anim} Giveaway criado em <#${giveaway.channelId}>! ID: \`${shortId(giveaway.id)}\``);
}

const SUBCOMANDOS = {
  async criar(ctx, tokens) {
    if (!tokens.length) return assistenteDeCriacao(ctx);
    const { flags } = parseArgs(tokens);
    return criarPorOpcoes(ctx, flags, {
      mensagem: (g) => `Giveaway criado em <#${g.channelId}>! ID: \`${shortId(g.id)}\``,
    });
  },

  async drop(ctx, tokens) {
    const { flags } = parseArgs(tokens);
    return criarPorOpcoes(ctx, flags, {
      padroes: { title: 'Drop relâmpago', prize: 'Prêmio surpresa', duration: 60 },
      mensagem: (g) => `⚡ Drop criado em <#${g.channelId}>! ID: \`${shortId(g.id)}\``,
    });
  },

  async agendar(ctx, tokens) {
    const { positionais, flags } = parseArgs(tokens);
    if (!positionais.length) {
      throw new GiveawayError(`Informe a data de início. Ex.: \`${ctx.prefixo}giveaway agendar 24/12/2026 20:00 --premio "Prêmio"\``);
    }
    const inicio = parseData(positionais.join(' '), 'data de início');
    if (inicio <= Date.now()) throw new GiveawayError('A data de início precisa estar no futuro.');

    return criarPorOpcoes(ctx, { ...flags, inicio: new Date(inicio).toISOString() }, {
      padroes: { title: 'Giveaway agendado' },
      mensagem: (g) => `🗓️ Giveaway agendado para <t:${Math.floor(g.startAt / 1000)}:F> em <#${g.channelId}>. ID: \`${shortId(g.id)}\``,
    });
  },

  async encerrar(ctx, tokens) {
    const { client, message, guild, emojis } = ctx;
    const { positionais } = parseArgs(tokens);
    if (!positionais[0]) throw new GiveawayError('Informe o ID do giveaway.');

    const giveaway = await findGiveaway(client.brain.database, guild.id, positionais[0]);
    if (!giveaway) throw new GiveawayError('Giveaway não encontrado neste servidor.');
    if (giveaway.status === 'ended') throw new GiveawayError('Este giveaway já foi encerrado. Para sortear outro ganhador use `reroll`.');

    const encerrado = await endGiveaway(client, client.brain.database, giveaway.id);
    return message.reply(`${emojis.check_anim} Giveaway encerrado. Ganhadores: ${encerrado.winnerIds.length}.`);
  },

  async reroll(ctx, tokens) {
    const { client, message, guild, emojis } = ctx;
    const { positionais } = parseArgs(tokens);
    if (!positionais[0]) throw new GiveawayError('Informe o ID do giveaway.');

    const giveaway = await findGiveaway(client.brain.database, guild.id, positionais[0]);
    if (!giveaway) throw new GiveawayError('Giveaway não encontrado neste servidor.');

    const quantidade = positionais[1] === undefined ? 1 : parseInteiro(positionais[1], 1, 100, 'A quantidade');
    const ganhadores = await rerollGiveaway(client, client.brain.database, giveaway.id, quantidade);
    if (!ganhadores.length) return message.reply(`${emojis.neutral_anim} Não há novos participantes elegíveis.`);
    return message.reply(`${emojis.check_anim} Novo(s) ganhador(es) sorteado(s): ${ganhadores.map((id) => `<@${id}>`).join(', ')}.`);
  },

  async cancelar(ctx, tokens) {
    const { client, message, guild, emojis } = ctx;
    const { positionais } = parseArgs(tokens);
    if (!positionais[0]) throw new GiveawayError('Informe o ID do giveaway.');

    const giveaway = await findGiveaway(client.brain.database, guild.id, positionais[0]);
    if (!giveaway) throw new GiveawayError('Giveaway não encontrado neste servidor.');

    await cancelGiveaway(client, client.brain.database, giveaway.id);
    return message.reply(`${emojis.check_anim} Giveaway cancelado.`);
  },

  async editar(ctx, tokens) {
    const { client, message, guild, emojis } = ctx;
    const { positionais, flags } = parseArgs(tokens);
    if (!positionais[0]) throw new GiveawayError('Informe o ID do giveaway e pelo menos uma opção para editar.');

    const giveaway = await findGiveaway(client.brain.database, guild.id, positionais[0]);
    if (!giveaway) throw new GiveawayError('Giveaway não encontrado neste servidor.');

    for (const proibida of ['duracao', 'fim', 'inicio', 'modelo', 'canal']) {
      if (flags[proibida] !== undefined) throw new GiveawayError(`A opção \`--${proibida}\` não pode ser usada na edição.`);
    }

    const alteracoes = {};
    if (flags.titulo !== undefined) alteracoes.title = flags.titulo;
    if (flags.premio !== undefined) alteracoes.prize = flags.premio;
    if (flags.descricao !== undefined) alteracoes.description = flags.descricao;
    if (flags.ganhadores !== undefined) alteracoes.winners = parseInteiro(flags.ganhadores, 1, 100, 'O número de ganhadores');
    if (flags.cargo !== undefined) alteracoes.roleId = resolverCargo(ctx, flags.cargo);
    if (flags.host !== undefined) alteracoes.hostId = resolverHost(flags.host);

    if (!Object.keys(alteracoes).length) {
      throw new GiveawayError('Nenhuma alteração informada. Use opções como `--premio`, `--ganhadores`, `--cargo` ou `--host`.');
    }

    await editGiveaway(client, client.brain.database, giveaway.id, alteracoes);
    return message.reply(`${emojis.check_anim} Giveaway atualizado (${Object.keys(flags).join(', ')}).`);
  },

  async listar(ctx) {
    const { client, message, guild, emojis } = ctx;
    const giveaways = (await client.brain.database.Giveaways.list(guild.id))
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    if (!giveaways.length) return message.reply(`${emojis.neutral_anim} Nenhum giveaway encontrado.`);

    const itens = giveaways.map((item) => {
      const inicio = item.startAt ? `<t:${Math.floor(item.startAt / 1000)}:F>` : 'imediato';
      const fim = item.endAt ? `<t:${Math.floor(item.endAt / 1000)}:F>` : 'não informado';
      const ganhadores = Array.isArray(item.winnerIds) && item.winnerIds.length
        ? item.winnerIds.map((userId) => `<@${userId}>`).join(', ')
        : 'ainda não definidos';
      const participantes = Array.isArray(item.entrants) ? item.entrants.length : (item.entrantCount ?? 0);
      return [
        `**${item.title || 'Sem título'}** — **${item.prize || 'Sem prêmio'}**`,
        `> ID: \`${shortId(item.id)}\``,
        `> Status: **${STATUS_LABELS[item.status] ?? item.status}** · Ganhadores: **${item.winners}** · Participantes: **${participantes}**`,
        `> Início: ${inicio} · Fim: ${fim}`,
        `> Canal: <#${item.channelId}> · Cargo: ${item.roleId ? `<@&${item.roleId}>` : 'qualquer cargo'}`,
        `> Organizador: ${item.hostId ? `<@${item.hostId}>` : 'não informado'} · Resultado: ${ganhadores}`,
      ].join('\n');
    });

    await client.brain.paginate(client, message, message.author, itens, {
      itemsPerPage: 3,
      timeout: 5 * 60000,
      embed: {
        titulo: `Giveaways de ${guild.name || 'servidor'}`,
        cor: '#f1a33c',
      },
    });
  },

  async modelo(ctx, tokens, resto) {
    const { client, message, guild, emojis } = ctx;
    const { database } = client.brain;

    const acao = (tokens.shift() ?? 'listar').toLowerCase();
    const nome = tokens.shift();

    const exigirNome = () => {
      if (!nome) throw new GiveawayError('Informe o nome do modelo.');
      if (!TEMPLATE_NAME_REGEX.test(nome)) throw new GiveawayError('O nome do modelo deve ter até 32 caracteres (letras, números, `_` ou `-`).');
    };

    if (acao === 'listar' || acao === 'list') {
      const nomes = Object.keys(await database.Giveaways.getTemplates(guild.id));
      return message.reply(nomes.length
        ? `📋 Modelos: ${nomes.map((n) => `\`${n}\``).join(', ')}\n-# Use \`--modelo nome\` ao criar um giveaway.`
        : `${emojis.neutral_anim} Nenhum modelo salvo.`);
    }

    if (acao === 'exportar' || acao === 'export') {
      exigirNome();
      const modelos = await database.Giveaways.getTemplates(guild.id);
      if (!Object.hasOwn(modelos, nome)) throw new GiveawayError('Modelo não encontrado.');
      return message.reply(`\`\`\`json\n${JSON.stringify(modelos[nome])}\n\`\`\``);
    }

    if (acao === 'importar' || acao === 'import') {
      exigirNome();
      // O JSON precisa do texto original (o tokenizer tiraria as aspas), então pegamos tudo depois do nome.
      const bruto = resto.replace(/^\S+\s+\S+\s+\S+\s*/, '').replace(/^```(?:json)?\s*|\s*```$/gi, '').trim();
      let modelo;
      try {
        modelo = sanitizeTemplate(JSON.parse(bruto));
      } catch (error) {
        if (error instanceof GiveawayError) throw error;
        throw new GiveawayError(`JSON inválido: ${error.message}`);
      }
      if (!(await database.Giveaways.saveTemplate(guild.id, nome, modelo))) {
        throw new GiveawayError('Não consegui salvar: este servidor não está cadastrado.');
      }
      return message.reply(`${emojis.check_anim} Modelo \`${nome}\` importado.`);
    }

    if (acao === 'salvar' || acao === 'save') {
      exigirNome();
      const { flags } = parseArgs(tokens);
      const modelo = sanitizeTemplate({
        title: flags.titulo,
        prize: flags.premio,
        description: flags.descricao,
        winners: flags.ganhadores,
        duration: flags.duracao !== undefined ? parseDuracao(flags.duracao) : undefined,
        roleId: flags.cargo !== undefined ? resolverCargo(ctx, flags.cargo) : undefined,
      });
      if (!(await database.Giveaways.saveTemplate(guild.id, nome, modelo))) {
        throw new GiveawayError('Não consegui salvar: este servidor não está cadastrado.');
      }
      return message.reply(`${emojis.check_anim} Modelo \`${nome}\` salvo.`);
    }

    if (acao === 'remover' || acao === 'delete' || acao === 'excluir') {
      exigirNome();
      if (!(await database.Giveaways.deleteTemplate(guild.id, nome))) throw new GiveawayError('Modelo não encontrado.');
      return message.reply(`${emojis.check_anim} Modelo \`${nome}\` removido.`);
    }

    throw new GiveawayError('Ação de modelo inválida. Use `listar`, `salvar`, `remover`, `exportar` ou `importar`.');
  },
};

// Apelidos dos subcomandos (português e inglês)
const ALIASES_SUBCOMANDOS = {
  create: 'criar',
  end: 'encerrar', finalizar: 'encerrar',
  novoganhar: 'reroll',
  cancel: 'cancelar',
  schedule: 'agendar',
  edit: 'editar',
  list: 'listar',
  template: 'modelo',
};

export default {
  name: 'giveaway',
  aliases: ['sorteio', 'giveaways'],
  categoria: 'utilidades',
  descricao: 'Cria e administra giveaways, drops, agendamentos e modelos.',
  uso: 'giveaway <criar|editar|encerrar|reroll|drop|agendar|cancelar|modelo|listar>',
  exemplos: [
    'giveaway criar',
    'giveaway criar --premio "Pix de 10 reais" --duracao 1h --ganhadores 2',
    'giveaway drop --premio "Nitro"',
    'giveaway agendar 24/12/2026 20:00 --premio "Presente de Natal"',
    'giveaway encerrar 23b53b04',
    'giveaway reroll 23b53b04 1',
  ],

  async execute({ client, message, prefixo }) {
    const { emojis } = client.brain;

    // Servidor onde o comando foi usado (não funciona em DM)
    const guild = message.guild ?? (await message.resolveGuild().catch(() => null));
    if (!guild) {
      return message.reply(`${emojis.cross_system} Este comando só pode ser usado dentro de um servidor.`);
    }

    // Membro que executou o comando (o cache pode estar vazio, então busca na API)
    const authorMember = message.member ?? (await guild.fetchMember(message.author.id).catch(() => null));
    if (!authorMember) {
      return message.reply(`${emojis.cross_system} Não consegui carregar os seus dados neste servidor. Tente novamente.`);
    }

    // Permissão de quem executa
    if (!hasPermission(authorMember, PermissionFlags.ManageGuild)) {
      return message.reply(`${emojis.cross_system} Você precisa da permissão Gerenciar Servidor para usar este comando.`);
    }

    const ctx = { client, message, guild, prefixo, emojis, database: client.brain.database };

    try {
      // Os argumentos vêm do texto original (e não de args) para não perder as aspas
      const resto = message.content.trim().slice(prefixo.length).trim().replace(/^\S+\s*/, '');
      const tokens = tokenize(resto);

      const digitado = (tokens.shift() ?? 'ajuda').toLowerCase();
      if (digitado === 'ajuda' || digitado === 'help') return await message.reply(usage(prefixo));

      const nome = Object.hasOwn(ALIASES_SUBCOMANDOS, digitado) ? ALIASES_SUBCOMANDOS[digitado] : digitado;
      if (!Object.hasOwn(SUBCOMANDOS, nome)) return await message.reply(usage(prefixo));
      const subcomando = SUBCOMANDOS[nome];

      await subcomando(ctx, tokens, resto);
    } catch (error) {
      if (error instanceof GiveawayError) {
        await message.reply(`${emojis.cross_anim} ${error.message}`).catch(() => {});
        return;
      }
      console.error(GIVEAWAY_PREFIX, 'Erro ao executar o comando giveaway:', error);
      await message.reply(`${emojis.cross_anim} Ocorreu um erro inesperado ao executar o comando.`).catch(() => {});
    }
  },
};
