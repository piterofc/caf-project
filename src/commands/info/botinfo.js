import os from 'node:os';
import packageJson from '../../../package.json' with { type: 'json' };
import { commitHashShort, commitDate, branchName } from '../../utils/gitInfo.js';

const fluxerVersion =
  packageJson.dependencies?.['@fluxerjs/core'] ??
  'Não encontrada';

export default {
  name: 'botinfo',
  aliases: ['bot-info', 'bi'],
  categoria: 'info',
  descricao: 'Exibe informações detalhadas sobre o bot.',
  uso: 'botinfo',
  exemplos: ['botinfo', 'bot-info', 'bi'],

  async execute({ client, message, args }) {
    const { database, emojis, paginate } = client.brain;

    // Definimos onde ficarão as informações do bot, separadas por páginas
    const info = [];

    let listagem = "";
    let listagemCount = 1;

    // Listagem de páginas
    listagem += `> **${listagemCount}** - Introdução e listagem de páginas\n`
    listagemCount++;

    // Informações básicas do bot
    listagem += `> **${listagemCount}** - Informações básicas do bot`
    listagemCount++;

    // Informações de status do bot
    listagem += `\n> **${listagemCount}** - Informações de status do bot`
    listagemCount++;

    listagemCount = 1; // Resetando o contador para exibir na listagem de páginas

    // Página: Introdução - listagem de páginas
    info.push(
        `**${listagemCount}. Páginas disponíveis \\📄**\n` +
        `${listagem}\n` +
        `Use as reações para navegar entre as páginas.`
    );
    listagemCount++;

    // Página: Informações básicas do bot
    let totalComandos = new Set(client.commands.values()).size;
    info.push(
        `**${listagemCount}. Informações básicas do bot \\📋**\n` +
        `> \\🤖 Nome do bot: \`${client.user.username}#${client.user.discriminator}\`\n` +
        `> \🆔 ID do bot: \`${client.user.id}\`\n` +
        `> \📅 Criado em: <t:${Math.floor(client.user.createdTimestamp / 1000)}:F> (<t:${Math.floor(client.user.createdTimestamp / 1000)}:R>)\n` +
        `> \👥 Servidores: \`${client.guilds.cache.size}\`\n` +
        `> \👤 Usuários: \`${client.users.cache.size}\`\n` +
        `> \📝 Comandos: \`${totalComandos}\`\n`
    );
    listagemCount++;

    const cpus = os.cpus();
    // Página: Informações de status do bot
    info.push(
        `**${listagemCount}. Informações de status do bot \\📊**\n` +
        `> \📡 Latência: \`${client.ws.ping}ms\`\n` +
        `> \💻 Plataforma: \`${process.platform}\`\n` +
        `> \🖥️ Versão do Node.js: \`${process.version}\`\n` +
        `> \📦 Versão do Fluxer.js: \`${fluxerVersion}\`\n` +
        `> \🤖 Versão do Bot: \`${packageJson.version}\`\n` +
        // Info do Git em uma única linha contento hash curto, data e branch
        `> \🗂️ Commit atual: \`${branchName ?? 'Branch desconhecida'}\` > \`${commitHashShort ?? 'Hash desconhecido'}\` (${commitDate ? "<t:" + Math.floor(new Date(commitDate).getTime() / 1000) + ":R>" : 'Data desconhecida'})\n` +
        `> \⚙️ Versão do Sistema Operacional: \`${os.release()}\`\n` +
        `> \⚙️ Arquitetura do Sistema Operacional: \`${os.arch()}\`\n` +
        `> \💿 Memória RAM Total: \`${(os.totalmem() / 1024 ** 3).toFixed(2)} GB\`\n` +
        `> \💿 Memória RAM Livre: \`${(os.freemem() / 1024 ** 3).toFixed(2)} GB\`\n` +
        `> \💿 Memória RAM Usada: \`${((os.totalmem() - os.freemem()) / (1024 ** 3)).toFixed(2)} GB\`\n` +
        `> \📟 CPU: \`${cpus[0]?.model ?? 'Desconhecida'}\`\n` +
        `> \📟 Núcleos da CPU: \`${cpus.length}\`\n` +
        `> \📟 Frequência da CPU: \`${cpus[0]?.speed ?? 0} MHz\`\n` +
        `> \📟 Uso da CPU: \`${(process.cpuUsage().user / 1024 / 1024).toFixed(2)}%\`\n`
    );
    listagemCount++;

    // Chamando a função de paginação
    await paginate(client, message, message.author, info, {
      itemsPerPage: 1,
      timeout: 5 * 60000, // 5 minutos
      embed: {
        titulo: `Informações do Bot - ${client.user.username}`,
        cor: '#36b7a5',
        // thumbnail: client.user.displayAvatarURL() || null,
      }
    });

  }
}