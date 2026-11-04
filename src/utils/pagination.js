import { EmbedBuilder } from '@fluxerjs/core';
import { PAGINATION_PREFIX } from '../utils/loggerPrefixes.js';

/**
 * Função para paginar uma lista de itens em mensagens do Fluxer.
 * @param {Client} client - O cliente do Fluxer.
 * @param {Message} message - A mensagem que iniciou a paginação.
 * @param {User} userForReactions - O usuário que pode interagir com a paginação.
 * @param {Array} items - A lista de itens a serem paginados.
 * @param {Object} config - Configurações opcionais para a paginação.
 * @param {number} config.itemsPerPage - Número de itens por página (padrão: 10).
 * @param {number} config.timeout - Tempo em milissegundos antes de encerrar a paginação (padrão: 3 minutos).
 * @param {string} config.pesquisaJoined - Termo de pesquisa completa desde o início (padrão: '').
 * @param {Object} config.embed - Configurações do embed da mensagem de paginação.
 * @param {string} config.embed.titulo - Título do embed (padrão: 'Paginação').
 * @param {string} config.embed.preDescricao - Texto antes da descrição dos itens (padrão: '').
 * @param {string} config.embed.posDescricao - Texto após a descrição dos itens (padrão: '').
 * @param {string} config.embed.cor - Cor do embed em hexadecimal (padrão: '#0099ff').
 * @param {string|null} config.embed.thumbnail - URL da thumbnail do embed (padrão: null).
 * @param {string|null} config.embed.image - URL da imagem do embed (padrão: null).
 * @throws {Error} se a lista de itens não for um array não vazio, se itemsPerPage não for um inteiro positivo, ou se timeout não for positivo.
 * @example await paginate(client, message, message.author, ['Item 1', 'Item 2', 'Item 3'], { itemsPerPage: 1, timeout: 60000, embed: { titulo: 'Minha Paginação', cor: '#ff0000' } });
*/
export async function paginate(client, message, userForReactions, items, config = {}) {
    let {
        itemsPerPage = 10,
        timeout = 3 * 60000, // 3 minutos
        pesquisaJoined = '',
        embed = {
          titulo: 'Paginação',
          preDescricao: '',
          posDescricao: '',
          cor: '#0099ff',
          thumbnail: null,
          image: null,
        },
    } = config;

    if (!Array.isArray(items) || items.length === 0) {
        throw new Error('A lista precisa ser um array não vazio.');
    }

    if (!Number.isInteger(itemsPerPage) || itemsPerPage < 1) {
        throw new Error('itemsPerPage precisa ser um inteiro positivo.');
    }

    if (!Number.isFinite(timeout) || timeout <= 0) {
        throw new Error('timeout precisa ser positivo.');
    }

    const totalPages = Math.ceil(items.length / itemsPerPage);
    let currentPage = 0;

    const generateEmbed = (page) => {
        const start = page * itemsPerPage;
        const pageItems = items.slice(start, start + itemsPerPage);

        let description = '';
        if (embed.preDescricao) {
            description += `${embed.preDescricao}\n\n`;
        }
        description += pageItems.map(String).join('\n');
        if (embed.posDescricao) {
            description += `\n\n${embed.posDescricao}`;
        }

        let returnEmbed = new EmbedBuilder()
            .setTitle(embed.titulo)
            .setDescription(description)
            .setColor(embed.cor)
            .setFooter({
                text: `Página ${page + 1} de ${totalPages}`,
            });

        if (embed.thumbnail) {
            returnEmbed.setThumbnail(embed.thumbnail);
        }

        if (embed.image) {
            returnEmbed.setImage(embed.image);
        }

        return returnEmbed;
    };

    const prazoFinal = Date.now() + timeout;
    // Agora vamos puxar o tempo em ms para enviar no formato <t:TIMESTAMP:R>
    const timestampFinal = Math.floor(prazoFinal / 1000);

    const embedMessage = await message.reply({
        content: `Encerramento da paginação <t:${timestampFinal}:R>`,
        embeds: [generateEmbed(currentPage)],
    });

    if (totalPages <= 1) {
        await embedMessage.react('🔎');
        await embedMessage.react('🗑️');
    } else {
        await embedMessage.react('⏪');
        await embedMessage.react('⬅️');
        await embedMessage.react('#️⃣');
        await embedMessage.react('🔎');
        await embedMessage.react('🗑️');
        await embedMessage.react('➡️');
        await embedMessage.react('⏩');
    }


    async function gotoPage() {
        let time = 30000; // 30 segundos
        let prazoFinalPrompt = Math.floor((Date.now() + time)/1000);

        const promptMessage = await embedMessage.reply(`Digite o número da página que deseja ir (1 a ${totalPages}):\n-# Cancelamento <t:${prazoFinalPrompt}:R> | Para cancelar antes envie \`cancelar\``);

        const filter = (response) => response.author.id === userForReactions.id;
        const collected = await message.channel.awaitMessages({
            filter,
            max: 1,
            time: 30000, // 30 segundos
            errors: [],
        });

        if (collected.size === 0) {
            await promptMessage.edit({
                content: ':x: Tempo esgotado para digitar o número da página!',
            });
            setTimeout(() => promptMessage.delete().catch(() => {}), 5000);
            return;
        }

        if (collected.first().content.toLowerCase() == 'cancelar' || collected.first().content.toLowerCase() == 'cancel') {
            await promptMessage.edit({
                content: ':x: Ação de ir para página cancelada!',
            });
            setTimeout(() => promptMessage.delete().catch(() => {}), 5000);
            await collected.first().delete().catch(() => {});
            return;
        }

        const pageNumber = parseInt(collected.first().content, 10);

        if (isNaN(pageNumber) || pageNumber < 1 || pageNumber > totalPages) {
            await collected.first().delete().catch(() => {});
            await promptMessage.edit({
                content: ':x: Número de página inválido!',
            });
            setTimeout(() => promptMessage.delete().catch(() => {}), 5000);
            return;
        }

        currentPage = pageNumber - 1;

        // Tentar ir para a página. Se não der, avise
        try {
            await embedMessage.edit({
                embeds: [generateEmbed(currentPage)],
            });
        } catch (error) {
            console.error(PAGINATION_PREFIX, 'Erro ao ir para a página:', error);
        }

        await promptMessage.delete();
        await collected.first().delete().catch(() => {});
    }


    async function filtrarPesquisa() {
        let time = 30000; // 30 segundos
        let prazoFinalPrompt = Math.floor((Date.now() + time)/1000);

        const promptMessage = await embedMessage.reply(`Digite o termo de pesquisa para filtrar os itens:\n-# Cancelamento <t:${prazoFinalPrompt}:R> | Para cancelar antes envie \`cancelar\``);

        const filter = (response) => response.author.id === userForReactions.id;
        const collected = await message.channel.awaitMessages({
            filter,
            max: 1,
            time: 30000, // 30 segundos
            errors: [],
        });

        if (collected.size === 0) {
            await promptMessage.edit({
                content: ':x: Tempo esgotado para digitar o termo de pesquisa!',
            });
            setTimeout(() => promptMessage.delete().catch(() => {}), 5000);
            return;
        }

        if (collected.first().content.toLowerCase() == 'cancelar' || collected.first().content.toLowerCase() == 'cancel') {
            await promptMessage.edit({
                content: ':x: Ação de pesquisa cancelada!',
            });
            setTimeout(() => promptMessage.delete().catch(() => {}), 5000);
            await collected.first().delete().catch(() => {});
            return;
        }

        // PESQUISA - V3
        // Vamos permitir que o usuário digite múltiplos termos de pesquisa separados por " && ", " || " e notação por parênteses (implementando filtro completo com and, or e ordem de prioridade), e vamos filtrar os itens que contêm todos os termos fornecidos.
        const searchTerm = collected.first().content.toLowerCase();
        pesquisaJoined = pesquisaJoined ? `${pesquisaJoined} && ${searchTerm}` : searchTerm;

        // Função para avaliar a expressão de pesquisa
        function evaluateSearchExpression(expression, item) {
            // Substituir os termos de pesquisa por true/false com base na presença no item
            const itemString = item.toLowerCase();
            const replacedExpression = expression.replace(/([^\s()]+)/g, (match) => {
                const term = match.trim();
                if (term === '&&' || term === '||' || term === '(' || term === ')') {
                    return term; // Manter operadores e parênteses
                }
                return itemString.includes(term) ? 'true' : 'false'; // Substituir termos por true/false
            });

            // Avaliar a expressão lógica resultante
            try {
                return eval(replacedExpression); // Avaliar a expressão lógica
            }
            catch (error) {
                console.error(PAGINATION_PREFIX, 'Erro ao avaliar a expressão de pesquisa:', error);
                return false; // Em caso de erro, considerar como não correspondência
            }
        }

        // Filtrar os itens com base na expressão de pesquisa
        const filteredItems = items.filter(item => evaluateSearchExpression(searchTerm, item));

        if (filteredItems.length === 0) {
            await promptMessage.edit({
                content: ':x: Nenhum item encontrado com o termo de pesquisa fornecido!',
            });
            setTimeout(() => promptMessage.delete().catch(() => {}), 5000);
            await collected.first().delete().catch(() => {});
            return;
        }

        // Enviar a lista filtrada
        var mensagem;
        if (filteredItems.length < 2) {
            mensagem = `:white_check_mark: Foi encontrado ${filteredItems.length} item com o termo de pesquisa \`${searchTerm}\`.`;
        } else {
            mensagem = `:white_check_mark: Foram encontrados ${filteredItems.length} itens com o termo de pesquisa \`${searchTerm}\`.`;
        }
        await promptMessage.edit({
            content: mensagem,
        });

        // setTimeout(() => promptMessage.delete().catch(() => {}), 5000);
        await collected.first().delete().catch(() => {});

        // Enviar a lista filtrada em uma nova paginação
        await paginate(client, promptMessage, userForReactions, filteredItems, {
            itemsPerPage,
            timeout,
            pesquisaJoined,
            embed: {
              titulo: embed.titulo,
              // preDescricao: `🔎 Pesquisa: \`${pesquisaJoined}\``, // Exibe a pesquisa herdada
              preDescricao: `🔎 Pesquisa: \`${searchTerm}\``, // Exibe apenas a última pesquisa
              posDescricao: `✔️ Total de itens encontrados: ${filteredItems.length}`,
              cor: embed.cor,
            }
        });
    }


    while (Date.now() < prazoFinal) {
        const tempoRestante = prazoFinal - Date.now();

        let coletadas;

        try {
            coletadas = await embedMessage.awaitReactions({
                filter: (reaction, user) =>
                    user?.id === userForReactions.id &&
                    ['⏪', '⬅️', '#️⃣', '🔎', '🗑️', '➡️', '⏩'].includes(reaction?.emoji?.name),
                max: 1,
                time: tempoRestante,
                errors: [],
            });
        } catch (error) {
            console.error(
                PAGINATION_PREFIX,
                'Erro ao aguardar reação:',
                error,
            );
            throw error;
        }

        // A coleção do Fluxer.js contém objetos { reaction, user }.
        const resultado =
            typeof coletadas?.first === 'function'
                ? coletadas.first()
                : Array.isArray(coletadas)
                    ? coletadas[0]
                    : undefined;

        if (!resultado) break;

        const reaction = resultado.reaction;
        const user = resultado.user;

        const emoji = reaction?.emoji?.name;

        if (
            !reaction ||
            user?.id !== userForReactions.id ||
            !['⏪', '⬅️', '#️⃣', '🔎', '🗑️', '➡️', '⏩'].includes(emoji)
        ) {
            console.warn(PAGINATION_PREFIX, 'Resultado de reação inválido.');
            continue;
        }

        const paginaAnterior = currentPage;

        try {
            switch (emoji) {
                case '⏪':
                    currentPage = 0;
                    break;
                case '⬅️':
                    if (currentPage > 0) currentPage--;
                    break;
                case '#️⃣':
                    gotoPage();
                    break;
                case '🔎':
                    filtrarPesquisa();
                    break;
                case '🗑️':
                    await embedMessage.delete();
                    // Deletar mensagem original também, se possível, a menos que seja do usuário que chamou a paginação
                    if (message.author.id !== userForReactions.id) {
                        await message.delete().catch(() => {});
                    }
                    return;
                case '➡️':
                    if (currentPage < totalPages - 1) currentPage++;
                    break;
                case '⏩':
                    currentPage = totalPages - 1;
                    break;
                default:
                    console.warn(
                        PAGINATION_PREFIX,
                        'Emoji de reação não reconhecido:',
                        emoji,
                    );
            }

            if (currentPage !== paginaAnterior) {
                await embedMessage.edit({
                    embeds: [generateEmbed(currentPage)],
                });
            }
        } catch (error) {
            console.error(
                PAGINATION_PREFIX,
                'Erro ao atualizar página:',
                error,
            );
        } finally {
            try {
                await embedMessage.removeReaction(
                    emoji,
                    userForReactions.id,
                );
            } catch (error) {
                console.error(
                    PAGINATION_PREFIX,
                    'Erro ao remover reação:',
                    error,
                );
            }
        }
    }

    try {
        await embedMessage.removeAllReactions();
    } catch (error) {
        console.error(
            PAGINATION_PREFIX,
            'Erro ao limpar reações:',
            error,
        );
    }
}

export default paginate;
