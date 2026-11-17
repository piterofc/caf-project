import { PermissionFlags, EmbedBuilder } from '@fluxerjs/core';

import { INVITES_PREFIX } from '../../utils/loggerPrefixes.js';
import {
  EMBED_COLOR,
  INVITE_SETTINGS,
  INVITE_TEMPLATE_VARIABLES,
  InviteError,
  addBonusInvites,
  buildLeaderboardCsv,
  clearInvites,
  createInviteCode,
  describeSettingValue,
  findSettingKey,
  getInviteCounts,
  getInviteSettings,
  getLeaderboard,
  getMemberCodes,
  getMemberInfo,
  inviteLink,
  listActiveMemberCodes,
  previewTemplate,
  renderInviteGraph,
  restoreInvites,
  setInviteCodeName,
  setMemberHidden,
  stamp,
  subtractFakes,
  subtractLeaves,
  updateInviteSettings,
  userCreatedAt,
  userTag,

} from '../../services/inviteService.js';

const PROMPT_TIME_MS = 30_000; // tempo que o bot espera a confirmação do autor
const CONFIRM_EMOJI = '✅';
const SKIP_EMOJI = '❌';
const FUSO_PADRAO = '-03:00'; // datas digitadas sem fuso são interpretadas no horário de Brasília
const DAY_MS = 86_400_000;
const MENTION_REGEX = { usuario: /^<@!?(\d{15,21})>$/, canal: /^<#(\d{15,21})>$/ };
const ID_REGEX = /^\d{15,21}$/;

// Opções (--nome valor). As que estão em FLAGS_SEM_VALOR não recebem valor (só ligam).
const FLAGS = {
  usos: 'usos', uses: 'usos', maxuses: 'usos',
  expira: 'expira', expires: 'expira',
  temporario: 'temporario', temporary: 'temporario',
  bonus: 'bonus',
};
const FLAGS_SEM_VALOR = new Set(['expira', 'temporario', 'bonus']);

// Tipos de gráfico (português e inglês) -> tipo do service
const TIPOS_GRAFICO = {
  entradas: 'joins', joins: 'joins',
  saidas: 'leaves', saídas: 'leaves', leaves: 'leaves',
  ambos: 'joinsAndLeaves', todos: 'joinsAndLeaves', joinsandleaves: 'joinsAndLeaves',
};

/* -------------------------------------------------------------------------- */
/* Leitura dos argumentos                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Divide o texto em palavras, respeitando aspas: "Nome com espaço" vira um valor só.
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

  if (fechamento) throw new InviteError('Você abriu aspas e não fechou. Feche com a mesma aspa.');
  if (temToken) tokens.push(atual);
  return tokens;
}

/** Separa o que é opção (--nome valor ou --nome=valor) do que é argumento solto (usuário, número...). */
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
      throw new InviteError(`Opção desconhecida: \`--${match[1]}\`. Opções válidas: ${[...new Set(Object.values(FLAGS))].map((f) => `\`--${f}\``).join(', ')}.`);
    }

    if (FLAGS_SEM_VALOR.has(chave)) {
      flags[chave] = true;
      continue;
    }

    let valor = match[2];
    if (valor === undefined) {
      const proximo = tokens[i + 1];
      if (proximo === undefined || /^--[^\s]/.test(proximo)) {
        throw new InviteError(`A opção \`--${match[1]}\` precisa de um valor.`);
      }
      valor = proximo;
      i += 1;
    }
    flags[chave] = valor;
  }

  return { positionais, flags };
}

function extrairId(valor, tipo) {
  const texto = String(valor ?? '').trim();
  return texto.match(MENTION_REGEX[tipo])?.[1] ?? (ID_REGEX.test(texto) ? texto : null);
}

function parseInteiro(valor, minimo, maximo, rotulo) {
  const numero = Number(valor);
  if (!Number.isInteger(numero) || numero < minimo || numero > maximo) {
    throw new InviteError(`${rotulo} precisa ser um número inteiro entre ${minimo} e ${maximo}.`);
  }
  return numero;
}

/** Aceita 24/12/2026 ou 2026-12-24 (horário de Brasília). Retorna o início desse dia, em ms. */
function parseDia(valor, rotulo) {
  const texto = String(valor ?? '').trim();
  let iso = null;

  let match = texto.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (match) iso = `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
  else if ((match = texto.match(/^(\d{4})-(\d{2})-(\d{2})$/))) iso = texto;

  const timestamp = iso ? Date.parse(`${iso}T00:00:00${FUSO_PADRAO}`) : NaN;
  const partes = iso?.split('-').map(Number);
  const conferido = partes ? new Date(Date.UTC(partes[0], partes[1] - 1, partes[2])) : null;
  if (!Number.isFinite(timestamp) || conferido.getUTCMonth() !== partes[1] - 1 || conferido.getUTCDate() !== partes[2]) {
    throw new InviteError(`${rotulo[0].toUpperCase()}${rotulo.slice(1)} inválida. Use por exemplo \`24/12/2026\` ou \`2026-12-24\`.`);
  }
  return timestamp;
}

/* -------------------------------------------------------------------------- */
/* Permissões, usuário e confirmação (mesmo padrão dos outros comandos)       */
/* -------------------------------------------------------------------------- */

/** Verifica uma permissão do membro. Administrator concede todas as permissões. */
function hasPermission(member, flag) {
  const permissions = member?.permissions;
  if (!permissions) return false;
  return permissions.has(flag) || permissions.has(PermissionFlags.Administrator);
}

function exigirStaff(ctx) {
  if (!hasPermission(ctx.authorMember, PermissionFlags.ManageGuild)) {
    throw new InviteError('Você precisa da permissão Gerenciar Servidor para usar este subcomando.');
  }
}

/** Resolve uma menção ou ID para o usuário (mesmo que ele não esteja mais no servidor). */
async function resolverUsuario({ client, message }, valor) {
  const id = extrairId(valor, 'usuario');
  if (!id) throw new InviteError('Usuário inválido. Use uma menção (@usuário) ou o ID do usuário.');
  const user = message.mentions?.find((item) => item.id === id) ?? (await client.users.fetch(id).catch(() => null));
  if (!user) throw new InviteError('Não encontrei esse usuário.');
  return user;
}

/** Retorna o canal de texto (menção, ID ou `atual`). */
function resolverCanal({ message, guild }, valor) {
  if (valor === undefined || ['atual', 'aqui'].includes(String(valor).trim().toLowerCase())) return message.channel;
  const id = extrairId(valor, 'canal');
  const canal = id ? guild.channels.get(id) : null;
  if (!canal || typeof canal.send !== 'function') throw new InviteError('Canal inválido. Use uma menção de canal (#canal), o ID do canal ou `atual`.');
  return canal;
}

/**
 * Pede confirmação final ao autor, reagindo com CONFIRM_EMOJI / SKIP_EMOJI na mensagem do bot.
 * Só reações do autor do comando contam. Retorna 'confirm', 'cancel', 'timeout' ou 'error'.
 */
async function confirmAuthor({ message, promptText }) {
  let prompt;
  try {
    prompt = await message.reply(promptText);
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

    (async () => {
      await prompt.react(CONFIRM_EMOJI).catch(() => {});
      await prompt.react(SKIP_EMOJI).catch(() => {});
    })();
  });
}

/* -------------------------------------------------------------------------- */
/* Texto de ajuda                                                             */
/* -------------------------------------------------------------------------- */

function usage(prefixo) {
  return [
    '**📨 Convites**',
    `\`${prefixo}invites [@usuário]\` — mostra quantos convites você (ou outra pessoa) tem`,
    `\`${prefixo}invites top\` — ranking de convites · \`${prefixo}invites codigos\` — seus códigos de convite (enviados por DM)`,
    '',
    '**Somente quem tem Gerenciar Servidor**',
    `\`${prefixo}invites info <@usuário> [membros|bonus]\` — detalhes de um membro · \`${prefixo}invites codigos <@usuário>\``,
    `\`${prefixo}invites criar <nome> [#canal] [--usos N] [--expira] [--temporario]\` — cria um código com nome`,
    `\`${prefixo}invites adicionar <@usuário> <quantidade> [motivo]\` · \`${prefixo}invites remover <@usuário> <quantidade> [motivo]\``,
    `\`${prefixo}invites zerar [@usuário] [--bonus]\` · \`${prefixo}invites restaurar [@usuário]\``,
    `\`${prefixo}invites fakes\` · \`${prefixo}invites saidas\` — subtrai fakes / saídas rápidas do histórico`,
    `\`${prefixo}invites grafico <entradas|saidas|ambos> [de] [até]\` · \`${prefixo}invites exportar\``,
    `\`${prefixo}invites config [opção] [valor]\` · \`${prefixo}invites config variaveis\``,
    `\`${prefixo}invites ocultar <@usuário> [sim|não]\` · \`${prefixo}invites nomear <código> <nome|nenhum>\``,
    '-# Datas: `24/12/2026` ou `2026-12-24` (horário de Brasília). Use aspas para nomes com espaço.',
  ].join('\n');
}

/* -------------------------------------------------------------------------- */
/* Subcomandos                                                                */
/* -------------------------------------------------------------------------- */

/** `invites [@usuário]` — quantos convites a pessoa tem. */
async function contagem(ctx, tokens) {
  const { client, message, guild, emojis, prefixo } = ctx;
  const [referencia] = tokens;

  let alvo = message.author;
  if (referencia !== undefined) {
    if (!extrairId(referencia, 'usuario')) {
      throw new InviteError(`Não encontrei o subcomando \`${referencia}\`. Use \`${prefixo}invites ajuda\` para ver as opções.`);
    }
    alvo = await resolverUsuario(ctx, referencia);
  }

  const counts = await getInviteCounts(client.brain.database, guild.id, alvo.id);
  const detalhes =
    `✅ **${counts.regular}** regulares\n✨ **${counts.custom}** bônus\n💩 **${counts.fake}** fakes\n❌ **${counts.leave}** saídas`;
  const descricao = alvo.id === message.author.id
    ? `Você tem **${counts.total}** convites! 👏\n\n${detalhes}\n\nCompartilhe este servidor com seus amigos para ganhar mais 😉`
    : `<@${alvo.id}> tem **${counts.total}** convites!\n\n${detalhes}`;

  const embed = new EmbedBuilder().setTitle(`📨 Convites de ${alvo.username}`).setDescription(descricao).setColor(EMBED_COLOR);
  return message.reply({ embeds: [embed] });
}

const SUBCOMANDOS = {
  /** `invites top` — ranking (usa a paginação do bot). */
  async top(ctx) {
    const { client, message, guild, emojis } = ctx;
    const { entries, style } = await getLeaderboard(client, client.brain.database, guild.id);
    if (!entries.length) return message.reply(`${emojis.neutral_anim} Ninguém tem convites ainda.`);

    let items;
    let preDescricao = `Convites desde ${stamp(guild.createdAt?.getTime?.() ?? Date.now(), 'R')}`;
    let posDescricao = '';

    if (style === 'table') {
      const linhas = entries.map((entry, index) => [`${index + 1}.`, entry.name.slice(0, 10), `${entry.total}`, `${entry.regular}`, `${entry.custom}`, `${entry.fakes}`, `${entry.leaves}`]);
      const cabecalho = ['#', 'Nome', 'T', 'R', 'B', 'F', 'L'];
      const larguras = cabecalho.map((titulo, coluna) => Math.max(titulo.length, ...linhas.map((linha) => linha[coluna].length)));
      const montar = (linha) => linha.map((parte, coluna) => parte.padEnd(larguras[coluna] + 2)).join('');

      items = linhas.map(montar);
      preDescricao = `${preDescricao}\n\`\`\`\n${montar(cabecalho)}`;
      posDescricao = '```\n`T` = Total · `R` = Regulares · `B` = Bônus · `F` = Fakes · `L` = Saídas';
    } else {
      items = entries.map((entry, index) => {
        const nome = style === 'mentions' ? `<@${entry.id}>` : `**${entry.name}**`;
        return `**${index + 1}.** ${nome} — **${entry.total}** convites (**${entry.regular}** regulares, **${entry.custom}** bônus, **${entry.fakes}** fakes, **${entry.leaves}** saídas)`;
      });
    }

    await client.brain.paginate(client, message, message.author, items, {
      itemsPerPage: 10,
      timeout: 5 * 60000,
      embed: { titulo: `Ranking de convites de ${guild.name || 'servidor'}`, cor: EMBED_COLOR, preDescricao, posDescricao },
    });
  },

  /** `invites codigos [@usuário]` — seus códigos (por DM) ou, para a staff, os de outro membro. */
  async codigos(ctx, tokens) {
    const { client, message, guild, emojis } = ctx;
    const { database } = client.brain;

    // Staff vendo os códigos de outra pessoa
    if (tokens[0] !== undefined) {
      exigirStaff(ctx);
      const alvo = await resolverUsuario(ctx, tokens[0]);
      const codigos = await getMemberCodes(database, guild.id, alvo.id);
      if (!codigos.length) return message.reply(`${emojis.neutral_anim} Este usuário ainda não tem códigos de convite.`);

      const linhas = codigos.slice(0, 25).map((codigo) => {
        const nome = codigo.name ? `**${codigo.name}** (${codigo.code})` : `**${codigo.code}**`;
        return `**${codigo.uses}** de ${nome} — criado ${stamp(codigo.createdAt, 'R')}`;
      });
      return message.reply(`📨 Códigos de <@${alvo.id}>:\n${linhas.join('\n')}`);
    }

    // Os próprios códigos, por DM
    const { permanent, temporary, recommended } = await listActiveMemberCodes(client, database, guild, message.author.id);
    const embed = new EmbedBuilder().setTitle(`Seus códigos no servidor ${guild.name}`).setColor(EMBED_COLOR);
    const campos = [];

    if (!permanent.length && !temporary.length) {
      embed.setDescription('Você não tem nenhum código de convite ativo. Peça a um moderador para criar um com `invites criar`.');
    } else {
      campos.push({ name: 'Código recomendado', value: recommended ? inviteLink(client, recommended.code) : 'Peça um código permanente a um moderador.' });
    }

    const descrever = (codigo, extra = '') =>
      `**Usos**: ${codigo.uses}\n**Usos máx.**: ${codigo.maxUses || 'ilimitado'}\n**Canal**: <#${codigo.channelId}>${extra}`;

    if (permanent.length) {
      campos.push({ name: 'Permanentes', value: 'Estes convites não expiram.' });
      for (const codigo of permanent) campos.push({ name: codigo.name ? `${codigo.name} (${codigo.code})` : codigo.code, value: descrever(codigo), inline: true });
    }
    if (temporary.length) {
      campos.push({ name: 'Temporários', value: 'Estes convites expiram depois de um tempo.' });
      for (const codigo of temporary) {
        campos.push({
          name: codigo.name ? `${codigo.name} (${codigo.code})` : codigo.code,
          value: descrever(codigo, `\n**Expira**: ${stamp(codigo.createdAt + codigo.maxAge * 1000, 'R')}`),
          inline: true,
        });
      }
    }
    if (campos.length) embed.addFields(...campos.slice(0, 25));

    try {
      await message.author.send({ embeds: [embed] });
      return message.reply(`${emojis.check_anim} Enviei uma DM com todos os seus códigos de convite.`);
    } catch {
      return message.reply(`${emojis.cross_anim} Não consegui te enviar uma DM. Verifique se você permite mensagens privadas.`);
    }
  },

  /** `invites info <@usuário> [membros|bonus]` */
  async info(ctx, tokens) {
    exigirStaff(ctx);
    const { client, message, guild, emojis, prefixo } = ctx;
    const { database } = client.brain;

    if (!tokens[0]) throw new InviteError(`Informe o usuário. Ex.: \`${prefixo}invites info @usuário\``);
    const alvo = await resolverUsuario(ctx, tokens[0]);

    const detalhe = tokens[1]?.toLowerCase();
    if (detalhe !== undefined && !['membros', 'members', 'bonus', 'bônus'].includes(detalhe)) {
      throw new InviteError('Detalhe inválido. Use `membros` ou `bonus`.');
    }

    const dados = await getMemberInfo(database, guild.id, alvo.id);
    const titulo = `Convites de ${userTag(alvo)}`;
    const linhaBonus = (item) => `**${item.amount}** de <@${item.creatorId ?? client.user.id}> — ${stamp(item.createdAt, 'R')}, motivo: ${item.reason ? `**${item.reason}**` : '**sem motivo**'}`;

    if (detalhe === 'bonus' || detalhe === 'bônus') {
      if (!dados.bonus.length) return message.reply(`${emojis.neutral_anim} Este membro ainda não recebeu bônus.`);
      return client.brain.paginate(client, message, message.author, dados.bonus.map(linhaBonus), {
        itemsPerPage: 10, timeout: 5 * 60000, embed: { titulo: `${titulo} — bônus`, cor: EMBED_COLOR },
      });
    }

    if (detalhe === 'membros' || detalhe === 'members') {
      if (!dados.invited.length) return message.reply(`${emojis.neutral_anim} Este membro ainda não convidou ninguém.`);
      return client.brain.paginate(client, message, message.author, dados.invited.map((item) => `<@${item.userId}> — ${stamp(item.createdAt, 'R')}`), {
        itemsPerPage: 10, timeout: 5 * 60000, embed: { titulo: `${titulo} — membros convidados`, cor: EMBED_COLOR },
      });
    }

    // Visão geral
    const { counts } = dados;
    const membro = guild.members.get(alvo.id) ?? (await guild.fetchMember(alvo.id).catch(() => null));
    const campos = [
      { name: 'Última entrada', value: membro?.joinedAt ? stamp(new Date(membro.joinedAt).getTime(), 'R') : 'Não faz parte do servidor', inline: true },
      { name: 'Entradas', value: `${dados.totalJoins} vezes`, inline: true },
      { name: 'Conta criada', value: stamp(userCreatedAt(alvo), 'R'), inline: true },
      { name: 'Convites', value: `**${counts.total}** (**${counts.regular}** regulares, **${counts.custom}** bônus, **${counts.fake}** fakes, **${counts.leave}** saídas)`, inline: true },
      { name: 'Convites zerados', value: `**${dados.clearedRegular + dados.clearedBonus}** (**${dados.clearedRegular}** regulares, **${dados.clearedBonus}** bônus)`, inline: true },
    ];

    if (dados.joins.length) {
      const grupos = new Map();
      for (const entrada of dados.joins) {
        const chave = stamp(entrada.createdAt, 'R');
        if (!grupos.has(chave)) grupos.set(chave, new Map());
        const porConvidador = grupos.get(chave);
        const convidador = entrada.inviterId ?? 'desconhecido';
        porConvidador.set(convidador, (porConvidador.get(convidador) ?? 0) + 1);
      }
      let texto = '';
      for (const [quando, porConvidador] of [...grupos].slice(0, 10)) {
        const total = [...porConvidador.values()].reduce((soma, n) => soma + n, 0);
        const quem = [...porConvidador].map(([id, n]) => `${id === 'desconhecido' ? 'desconhecido' : `<@${id}>`} (${n}x)`).join(', ');
        texto += `${total}x ${quando}, convidado por: ${quem}\n`;
      }
      if (grupos.size > 10) texto += `\nMais **${grupos.size - 10}** entradas`;
      campos.push({ name: 'Histórico de entradas', value: texto.slice(0, 1024) });
    } else {
      campos.push({ name: 'Histórico de entradas', value: 'Desconhecido (só funciona para quem entrou depois do bot)' });
    }

    if (dados.codes.length) {
      let texto = dados.codes.slice(0, 10).map((codigo) => {
        const nome = codigo.name ? `**${codigo.name}** (${codigo.code})` : `**${codigo.code}**`;
        return `**${codigo.uses}** de ${nome} — criado ${stamp(codigo.createdAt, 'R')}`;
      }).join('\n');
      if (dados.codes.length > 10) texto += `\n\nMais **${dados.codes.length - 10}** códigos`;
      campos.push({ name: 'Convites regulares', value: texto.slice(0, 1024) });
    } else {
      campos.push({ name: 'Convites regulares', value: 'Este membro ainda não tem códigos de convite' });
    }

    if (dados.bonus.length) {
      let texto = dados.bonus.slice(0, 10).map(linhaBonus).join('\n');
      if (dados.bonus.length > 10) texto += `\n\nMais **${dados.bonus.length - 10}** convites bônus`;
      texto = `${texto.slice(0, 900)}\nUse \`${prefixo}invites info ${alvo.id} bonus\` para ver todos.`;
      campos.push({ name: 'Convites bônus', value: texto.slice(0, 1024) });
    } else {
      campos.push({ name: 'Convites bônus', value: 'Este membro ainda não recebeu bônus' });
    }

    if (dados.invited.length) {
      let texto = dados.invited.slice(0, 10).map((item) => `<@${item.userId}> — ${stamp(item.createdAt, 'R')}`).join('\n');
      if (dados.invited.length > 10) texto += `\n\nMais **${dados.invited.length - 10}** membros`;
      campos.push({ name: 'Membros convidados', value: `${texto}\nUse \`${prefixo}invites info ${alvo.id} membros\` para ver todos.`.slice(0, 1024) });
    } else {
      campos.push({ name: 'Membros convidados', value: 'Este membro ainda não convidou ninguém' });
    }

    const embed = new EmbedBuilder().setTitle(titulo).setColor(EMBED_COLOR).addFields(...campos.slice(0, 25));
    return message.reply({ embeds: [embed] });
  },

  /** `invites criar <nome> [#canal] [--usos N] [--expira] [--temporario]` */
  async criar(ctx, tokens) {
    exigirStaff(ctx);
    const { client, message, guild, emojis, prefixo } = ctx;
    const { positionais, flags } = parseArgs(tokens);

    if (!positionais[0]) throw new InviteError(`Informe o nome do convite. Ex.: \`${prefixo}invites criar reddit #geral\``);
    const canal = resolverCanal(ctx, positionais[1]);
    const maxUses = flags.usos !== undefined ? parseInteiro(flags.usos, 0, 100, 'O número máximo de usos') : 0;

    const { code, link } = await createInviteCode(client, client.brain.database, {
      guild, channel: canal, creator: message.author, name: positionais[0],
      maxUses, expires: Boolean(flags.expira), temporary: Boolean(flags.temporario),
    });
    return message.reply(`${emojis.check_anim} Criei o código **${link}** chamado **${positionais[0]}** para <#${canal.id}>. (\`${code}\`)`);
  },

  /** `invites adicionar <@usuário> <quantidade> [motivo]` */
  async adicionar(ctx, tokens) {
    return alterarBonus(ctx, tokens, 1);
  },

  /** `invites remover <@usuário> <quantidade> [motivo]` */
  async remover(ctx, tokens) {
    return alterarBonus(ctx, tokens, -1);
  },

  /** `invites zerar [@usuário] [--bonus]` */
  async zerar(ctx, tokens) {
    exigirStaff(ctx);
    const { client, message, guild, emojis } = ctx;
    const { positionais, flags } = parseArgs(tokens);
    const alvo = positionais[0] ? await resolverUsuario(ctx, positionais[0]) : null;

    // Zerar o servidor inteiro é irreversível para quem não souber do `restaurar`: pede confirmação
    if (!alvo) {
      const decisao = await confirmAuthor({
        message,
        promptText: `${emojis.neutral_anim} Isso vai **zerar os convites de todos os membros** do servidor${flags.bonus ? ' (incluindo os bônus)' : ''}. Reaja com ${CONFIRM_EMOJI} para confirmar ou ${SKIP_EMOJI} para cancelar. (${PROMPT_TIME_MS / 1000}s)`,
      });
      if (decisao === 'error') return undefined;
      if (decisao === 'timeout') return message.reply(`${emojis.cross_anim} Tempo esgotado. Nada foi alterado.`);
      if (decisao === 'cancel') return message.reply(`${emojis.cross_anim} Cancelado. Nada foi alterado.`);
    }

    await clearInvites(client.brain.database, guild.id, alvo?.id ?? null, { clearBonus: Boolean(flags.bonus) });
    return message.reply(`${emojis.check_anim} Convites zerados${alvo ? ` de <@${alvo.id}>` : ''}!${flags.bonus ? '' : ' Os convites bônus foram mantidos (use `--bonus` para zerá-los também).'}`);
  },

  /** `invites restaurar [@usuário]` */
  async restaurar(ctx, tokens) {
    exigirStaff(ctx);
    const { client, message, guild, emojis } = ctx;
    const alvo = tokens[0] ? await resolverUsuario(ctx, tokens[0]) : null;

    await restoreInvites(client.brain.database, guild.id, alvo?.id ?? null);
    return message.reply(`${emojis.check_anim} Convites restaurados${alvo ? ` de <@${alvo.id}>` : ''}!`);
  },

  /** `invites fakes` */
  async fakes(ctx) {
    exigirStaff(ctx);
    const { client, message, guild, emojis } = ctx;
    const total = await subtractFakes(client, client.brain.database, guild.id);
    return message.reply(total ? `${emojis.check_anim} Convites fake removidos! (${total})` : `${emojis.neutral_anim} Nenhum convite fake encontrado.`);
  },

  /** `invites saidas` */
  async saidas(ctx) {
    exigirStaff(ctx);
    const { client, message, guild, emojis } = ctx;
    await subtractLeaves(client, client.brain.database, guild.id);
    return message.reply(`${emojis.check_anim} Saídas removidas!`);
  },

  /** `invites grafico <entradas|saidas|ambos> [de] [até]` */
  async grafico(ctx, tokens) {
    exigirStaff(ctx);
    const { client, message, guild, prefixo } = ctx;

    const tipo = TIPOS_GRAFICO[String(tokens[0] ?? '').toLowerCase()];
    if (!tipo) throw new InviteError(`Informe o tipo do gráfico: \`entradas\`, \`saidas\` ou \`ambos\`. Ex.: \`${prefixo}invites grafico entradas\``);

    // Sem datas: últimos 30 dias até agora. Com data final, vai até o fim desse dia.
    const fim = tokens[2] !== undefined ? parseDia(tokens[2], 'data final') + DAY_MS - 1 : Date.now();
    const inicio = tokens[1] !== undefined ? parseDia(tokens[1], 'data inicial') : fim - 30 * DAY_MS;

    const { buffer, title, description } = await renderInviteGraph(client, client.brain.database, guild.id, { type: tipo, from: inicio, to: fim });
    const embed = new EmbedBuilder().setTitle(title).setDescription(description).setColor(EMBED_COLOR).setImage('attachment://grafico.png');
    return message.reply({ embeds: [embed], files: [{ name: 'grafico.png', data: buffer }] });
  },

  /** `invites exportar` — ranking completo em CSV. */
  async exportar(ctx) {
    exigirStaff(ctx);
    const { client, message, guild, emojis } = ctx;
    const csv = await buildLeaderboardCsv(client, client.brain.database, guild.id);
    return message.reply({ content: `${emojis.check_anim} Ranking de convites exportado.`, files: [{ name: 'convites.csv', data: Buffer.from(csv, 'utf8') }] });
  },

  /** `invites config [opção] [valor]` e `invites config variaveis` */
  async config(ctx, tokens, resto) {
    exigirStaff(ctx);
    const { client, message, guild, emojis, prefixo } = ctx;
    const { database } = client.brain;

    const chaveDigitada = tokens[0];
    const settings = await getInviteSettings(database, guild.id);

    // Sem opção: mostra tudo
    if (!chaveDigitada) {
      const embed = new EmbedBuilder()
        .setTitle('⚙️ Configurações de convites')
        .setColor(EMBED_COLOR)
        .setDescription(`Use \`${prefixo}invites config <opção> <valor>\` para alterar. \`nenhum\` limpa um canal e \`padrao\` restaura o valor padrão.`)
        .addFields(...Object.entries(INVITE_SETTINGS).map(([chave, setting]) => ({
          name: chave,
          value: `${describeSettingValue(chave, settings[chave])}`.slice(0, 1024),
          inline: true,
        })));
      return message.reply({ embeds: [embed] });
    }

    if (['variaveis', 'variáveis', 'variables'].includes(chaveDigitada.toLowerCase())) {
      return message.reply(`**Variáveis das mensagens de entrada/saída**\n${INVITE_TEMPLATE_VARIABLES.map(([nome, descricao]) => `\`${nome}\` — ${descricao}`).join('\n')}`);
    }

    const chave = findSettingKey(chaveDigitada);
    if (!chave) {
      throw new InviteError(`Opção desconhecida. Opções: ${Object.keys(INVITE_SETTINGS).map((k) => `\`${k}\``).join(', ')}.`);
    }
    const setting = INVITE_SETTINGS[chave];

    // O valor é o texto original depois do nome da opção (mensagens têm espaços e aspas)
    const bruto = resto.replace(/^\S+\s+\S+\s*/, '').trim();
    if (!bruto) {
      const embed = new EmbedBuilder()
        .setTitle(chave)
        .setColor(EMBED_COLOR)
        .setDescription(setting.descricao)
        .addFields(
          { name: 'Valor atual', value: describeSettingValue(chave, settings[chave]).slice(0, 1024) },
          { name: 'Padrão', value: describeSettingValue(chave, setting.padrao).slice(0, 1024) },
        );
      return message.reply({ embeds: [embed] });
    }

    const valor = setting.tipo === 'canal' && ['atual', 'aqui'].includes(bruto.toLowerCase()) ? message.channel.id : bruto;
    const antes = settings[chave];
    const { changed, settings: novas, messages } = await updateInviteSettings(client, database, guild.id, { [chave]: valor });

    if (!(chave in changed)) return message.reply(`${emojis.neutral_anim} Esse já é o valor atual de \`${chave}\`.`);

    await message.reply(`${emojis.check_anim} \`${chave}\` atualizado: ${describeSettingValue(chave, antes)} → **${describeSettingValue(chave, novas[chave])}**`);

    // Pré-visualização das mensagens de entrada/saída
    if ((chave === 'joinMessage' || chave === 'leaveMessage') && novas[chave]) {
      const previa = await previewTemplate(database, guild, novas[chave], { member: message.member ?? undefined });
      await message.channel.send(typeof previa === 'string' ? `-# Pré-visualização:\n${previa}` : { content: '-# Pré-visualização:', embeds: [previa] }).catch(() => {});
    }
    for (const texto of messages) await message.channel.send(`${emojis.check_anim} ${texto}`).catch(() => {});
    return undefined;
  },

  /** `invites ocultar <@usuário> [sim|não]` — tira (ou devolve) alguém do ranking. */
  async ocultar(ctx, tokens) {
    exigirStaff(ctx);
    const { client, message, guild, emojis } = ctx;
    if (!tokens[0]) throw new InviteError('Informe o usuário.');
    const alvo = await resolverUsuario(ctx, tokens[0]);

    const resposta = String(tokens[1] ?? 'sim').toLowerCase();
    if (!['sim', 'nao', 'não', 'true', 'false', 'yes', 'no', 's', 'n'].includes(resposta)) throw new InviteError('Use `sim` para ocultar ou `não` para mostrar de novo.');
    const ocultar = ['sim', 'true', 'yes', 's'].includes(resposta);

    await setMemberHidden(client.brain.database, guild.id, alvo, ocultar);
    return message.reply(`${emojis.check_anim} <@${alvo.id}> ${ocultar ? 'agora está oculto no ranking' : 'voltou a aparecer no ranking'}.`);
  },

  /** `invites nomear <código> <nome|nenhum>` */
  async nomear(ctx, tokens) {
    exigirStaff(ctx);
    const { client, message, guild, emojis } = ctx;
    if (!tokens[0]) throw new InviteError('Informe o código do convite.');

    // Aceita o link inteiro ou só o código
    const codigo = tokens[0].split(/[/?#]/).filter(Boolean).pop();
    const nome = tokens.slice(1).join(' ').trim();
    if (!nome) throw new InviteError('Informe o nome (ou `nenhum` para remover).');

    const removendo = ['nenhum', 'nenhuma', '-', 'none'].includes(nome.toLowerCase());
    await setInviteCodeName(client.brain.database, guild.id, codigo, removendo ? null : nome);
    return message.reply(`${emojis.check_anim} ${removendo ? `Nome do código \`${codigo}\` removido.` : `Código \`${codigo}\` agora se chama **${nome}**.`}`);
  },
};

async function alterarBonus(ctx, tokens, sinal) {
  exigirStaff(ctx);
  const { client, message, guild, emojis, prefixo } = ctx;
  const [referencia, quantidade, ...motivo] = tokens;
  if (!referencia || quantidade === undefined) {
    throw new InviteError(`Informe o usuário e a quantidade. Ex.: \`${prefixo}invites ${sinal > 0 ? 'adicionar' : 'remover'} @usuário 5 motivo\``);
  }

  const alvo = await resolverUsuario(ctx, referencia);
  const valor = parseInteiro(quantidade, -1_000_000_000, 1_000_000_000, 'A quantidade');
  const total = await addBonusInvites(client.brain.database, guild.id, alvo, message.author.id, valor * sinal, motivo.join(' '));

  const aplicado = valor * sinal;
  return message.reply(aplicado > 0
    ? `${emojis.check_anim} Adicionei **${aplicado}** convites bônus para <@${alvo.id}>, que agora tem **${total}** convites.`
    : `${emojis.check_anim} Removi **${-aplicado}** convites de <@${alvo.id}>, que agora tem **${total}** convites.`);
}

// Apelidos dos subcomandos (português e inglês)
const ALIASES_SUBCOMANDOS = {
  ranking: 'top', leaderboard: 'top', lb: 'top',
  codes: 'codigos', code: 'codigos', codigo: 'codigos', código: 'codigos', códigos: 'codigos',
  create: 'criar',
  add: 'adicionar', adicionar: 'adicionar',
  remove: 'remover',
  clear: 'zerar', limpar: 'zerar',
  restore: 'restaurar',
  fake: 'fakes', subtractfakes: 'fakes',
  leaves: 'saidas', saídas: 'saidas', subtractleaves: 'saidas',
  graph: 'grafico', gráfico: 'grafico', chart: 'grafico',
  export: 'exportar',
  hide: 'ocultar',
  name: 'nomear',
};

export default {
  name: 'invites',
  aliases: ['invite', 'convites', 'convite'],
  categoria: 'utilidades',
  descricao: 'Mostra os convites de um membro e administra o sistema de convites (ranking, bônus, mensagens, gráficos).',
  uso: 'invites [@usuário|ajuda|top|codigos|info|criar|adicionar|remover|zerar|restaurar|fakes|saidas|grafico|exportar|config|ocultar|nomear]',
  exemplos: [
    'invites',
    'invites @Usuário',
    'invites top',
    'invites adicionar @Usuário 5 Sorteio',
    'invites config joinMessageChannel #entradas',
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

    const ctx = { client, message, guild, prefixo, emojis, authorMember, database: client.brain.database };

    try {
      // Os argumentos vêm do texto original (e não de args) para não perder as aspas
      const resto = message.content.trim().slice(prefixo.length).trim().replace(/^\S+\s*/, '');
      const tokens = tokenize(resto);

      const digitado = (tokens[0] ?? '').toLowerCase();
      if (digitado === 'ajuda' || digitado === 'help') return await message.reply(usage(prefixo));

      const nome = Object.hasOwn(ALIASES_SUBCOMANDOS, digitado) ? ALIASES_SUBCOMANDOS[digitado] : digitado;
      if (Object.hasOwn(SUBCOMANDOS, nome)) {
        tokens.shift();
        return await SUBCOMANDOS[nome](ctx, tokens, resto);
      }

      // Sem subcomando: mostra os convites de quem executou (ou da pessoa mencionada)
      return await contagem(ctx, tokens);
    } catch (error) {
      if (error instanceof InviteError) {
        await message.reply(`${emojis.cross_anim} ${error.message}`).catch(() => {});
        return undefined;
      }
      console.error(INVITES_PREFIX, 'Erro ao executar o comando invites:', error);
      await message.reply(`${emojis.cross_anim} Ocorreu um erro inesperado ao executar o comando.`).catch(() => {});
      return undefined;
    }
  },
};
