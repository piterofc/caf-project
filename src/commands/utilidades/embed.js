import { EmbedBuilder } from '@fluxerjs/core';

const PROMPT_TIME_MS = 60000;
const SKIP_EMOJI = '❌';
const REMOVE_EMOJI = '🗑️';
const CHANNEL_MENTION_REGEX = /^<#(\d{15,21})>$/;
const CHANNEL_ID_REGEX = /^\d{15,21}$/;

export function createBaseEmbed() {
  return new EmbedBuilder()
    .setTitle('Criador de Embeds do CAF')
    .setDescription('Reaja com os emojis abaixo para personalizar o embed. Você pode adicionar campos, alterar a cor, título, descrição, etc. A cada passo, você verá um preview do embed final.')
    .setColor('#FFAA00')
    .addFields(
      { name: '📌 Título', value: 'Definir o título do embed', inline: true },
      { name: '📝 Descrição', value: 'Definir a descrição do embed', inline: true },
      { name: '🎨 Cor', value: 'Definir a cor do embed', inline: true },
      { name: '🦶 Footer', value: 'Definir o footer do embed', inline: true },
      { name: '➕ Adicionar Campo', value: 'Adicionar um campo ao embed', inline: true },
      { name: '➖ Remover Campo', value: 'Remover um campo do embed', inline: true },
      { name: '📷 Imagem', value: 'Definir uma imagem para o embed', inline: true },
      { name: '🔗 URL', value: 'Definir uma URL para o embed', inline: true },
      { name: '✅ Finalizar', value: 'Finalizar a criação do embed e enviar', inline: true },
      { name: '❌ Cancelar', value: 'Cancelar a criação do embed', inline: true },
    )
    .setFooter({ text: 'Use as reações para personalizar o embed. Você pode cancelar a qualquer momento.' });
}

export function createPreviewEmbed() {
  return new EmbedBuilder()
    .setTitle('Preview do Embed')
    .setDescription('Aqui você verá como o embed final ficará à medida que você personaliza.')
    .setColor('#00ff00')
    .setFooter({ text: 'Este é apenas um preview. O embed final será enviado quando você finalizar.' });
}

export async function updateEmbedPreview(previewEmbed, updates) {
  if (updates.title !== undefined) previewEmbed.setTitle(updates.title);
  if (updates.description !== undefined) previewEmbed.setDescription(updates.description);
  if (updates.color !== undefined) previewEmbed.setColor(updates.color);
  if (updates.fields !== undefined) previewEmbed.setFields(...updates.fields);
  if (updates.image !== undefined) previewEmbed.setImage(updates.image);
  if (updates.url !== undefined) previewEmbed.setURL(updates.url);
  if (updates.footer !== undefined) {
    previewEmbed.setFooter(updates.footer === null ? null : { text: updates.footer });
  }
}

export async function finalizeEmbed(embed, channel) {
  await channel.send({ embeds: [embed] });
}

async function deleteMessage(message) {
  await Promise.resolve(message?.delete?.()).catch(() => {});
}

async function askAuthor({ message, promptText, validate, allowRemove = false }) {
  let channel;
  let prompt;
  try {
    channel = message.channel ?? (await message.resolveChannel());
    prompt = await message.reply(promptText);
  } catch {
    return { type: 'error' };
  }

  return new Promise((resolve) => {
    let settled = false;
    const relatedMessages = [prompt];
    const pendingReplies = new Set();

    const messageCollector = channel.createMessageCollector({
      filter: (candidate) => candidate.author.id === message.author.id,
      time: PROMPT_TIME_MS,
    });

    const reactionCollector = prompt.createReactionCollector({
      filter: (reaction, user) =>
        user.id === message.author.id &&
        (reaction.emoji.name === SKIP_EMOJI || (allowRemove && reaction.emoji.name === REMOVE_EMOJI)),
      time: PROMPT_TIME_MS,
      max: 1,
    });

    const finish = async (result) => {
      if (settled) return;
      settled = true;
      messageCollector.stop('user');
      reactionCollector.stop('user');
      await Promise.all([...pendingReplies]);
      await Promise.all(relatedMessages.map((relatedMessage) => deleteMessage(relatedMessage)));
      resolve(result);
    };

    messageCollector.on('collect', async (candidate) => {
      const text = (candidate.content ?? '').trim();
      relatedMessages.push(candidate);
      if (['cancelar', 'cancel'].includes(text.toLowerCase())) {
        return finish({ type: 'cancel' });
      }

      let result;
      try {
        result = validate(text);
      } catch {
        result = { ok: false, error: 'Resposta inválida.' };
      }

      if (result.ok) {
        return finish({ type: 'answer', value: result.value });
      }

      const errorReply = message.reply(`${result.error}\n-# Tente de novo ou envie \`cancelar\`.`)
        .then((reply) => relatedMessages.push(reply))
        .catch(() => {});
      pendingReplies.add(errorReply);
      await errorReply;
      pendingReplies.delete(errorReply);
    });

    reactionCollector.on('collect', (reaction) => {
      finish({ type: reaction.emoji.name === REMOVE_EMOJI ? 'remove' : 'cancel' });
    });
    messageCollector.on('end', () => finish({ type: 'timeout' }));
    reactionCollector.on('end', () => finish({ type: 'timeout' }));
    (async () => {
      await prompt.react(SKIP_EMOJI).catch(() => {});
      if (allowRemove) await prompt.react(REMOVE_EMOJI).catch(() => {});
    })();
  });
}

function isTextChannel(channel) {
  if (!channel || typeof channel.send !== 'function') return false;
  return typeof channel.isTextBased !== 'function' || channel.isTextBased();
}

function resolveDestinationChannel(message, value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (['atual', 'aqui'].includes(text)) return message.channel;

  const rawValue = String(value ?? '').trim();
  const id = rawValue.match(CHANNEL_MENTION_REGEX)?.[1] ?? (CHANNEL_ID_REGEX.test(rawValue) ? rawValue : null);
  const channel = id ? message.guild?.channels?.cache?.get(id) : null;
  if (!isTextChannel(channel)) {
    throw new Error('Canal inválido. Use uma menção de canal (#canal), o ID do canal ou `atual`.');
  }
  return channel;
}

export default {
  name: 'criar-embed',
  description: 'Cria um embed personalizado de forma interativa.',
  async execute({ message }) {
    const embed = createBaseEmbed();
    const previewEmbed = createPreviewEmbed();
    const sentMessage = await message.reply({ embeds: [embed, previewEmbed] });
    const reactions = ['📌', '📝', '🎨', '🦶', '➕', '➖', '📷', '🔗', '✅', '❌'];

    for (const reaction of reactions) {
      await sentMessage.react(reaction);
    }

    const filter = (reaction, user) => reactions.includes(reaction.emoji.name) && user.id === message.author.id;
    let actionQueue = Promise.resolve();
    let collector;
    let stopped = false;
    const editedFields = {
      title: false,
      description: false,
      footer: false,
      color: false,
    };

    const editPreview = async (updates) => {
      await updateEmbedPreview(previewEmbed, updates);
      await sentMessage.edit({ embeds: [embed, previewEmbed] });
    };

    const askAndEdit = async (promptText, validate, updates, editedField, allowRemove = false) => {
      const result = await askAuthor({ message, promptText, validate, allowRemove });
      if (result.type === 'answer' || result.type === 'remove') {
        if (editedField) editedFields[editedField] = true;
        const update = result.type === 'remove'
          ? updates.remove
          : typeof updates === 'function' ? updates(result.value) : updates.answer(result.value);
        await editPreview(update);
      }
    };

    const handleReaction = async (reaction) => {
      switch (reaction.emoji.name) {
        case '📌':
          await askAndEdit(
            'Por favor, envie o título do embed:',
            (input) => input.length <= 256
              ? { ok: true, value: input }
              : { ok: false, error: 'O título do embed não pode ter mais de 256 caracteres.' },
            { answer: (value) => ({ title: value }), remove: { title: null } },
            'title',
            true,
          );
          break;
        case '📝':
          await askAndEdit(
            'Por favor, envie a descrição do embed:',
            (input) => input.length <= 2048
              ? { ok: true, value: input }
              : { ok: false, error: 'A descrição do embed não pode ter mais de 2048 caracteres.' },
            { answer: (value) => ({ description: value }), remove: { description: null } },
            'description',
            true,
          );
          break;
        case '🎨':
          await askAndEdit(
            'Por favor, envie a cor do embed em hexadecimal (ex: #FFAA00):',
            (input) => /^#([0-9A-F]{3}){1,2}$/i.test(input)
              ? { ok: true, value: input }
              : { ok: false, error: 'A cor do embed deve estar em formato hexadecimal (ex: #FFAA00).' },
            { answer: (value) => ({ color: value }), remove: { color: null } },
            'color',
            true,
          );
          break;
        case '🦶':
          await askAndEdit(
            'Por favor, envie o texto do footer do embed:',
            (input) => input.length <= 2048
              ? { ok: true, value: input }
              : { ok: false, error: 'O footer do embed não pode ter mais de 2048 caracteres.' },
            { answer: (value) => ({ footer: value }), remove: { footer: null } },
            'footer',
            true,
          );
          break;
        case '➕':
          await askAndEdit(
            'Por favor, envie nome, valor e se o campo será inline, separados por barras (ex: Nome do Campo / Valor do Campo / sim):',
            (input) => {
              const parts = input.split('/').map((part) => part.trim());
              if (parts.length !== 3 || parts.some((part) => !part)) {
                return { ok: false, error: 'Envie nome, valor e inline separados por barras (ex: Nome do Campo / Valor do Campo / sim).' };
              }
              const [name, value, inlineInput] = parts;
              const normalizedInline = inlineInput.toLowerCase();
              const inlineValues = {
                sim: true,
                s: true,
                true: true,
                inline: true,
                não: false,
                nao: false,
                n: false,
                false: false,
                normal: false,
              };
              if (name.length > 256) return { ok: false, error: 'O nome do campo não pode ter mais de 256 caracteres.' };
              if (value.length > 1024) return { ok: false, error: 'O valor do campo não pode ter mais de 1024 caracteres.' };
              if (!Object.hasOwn(inlineValues, normalizedInline)) {
                return { ok: false, error: 'Informe inline como `sim` ou `não` (ex: Nome / Valor / sim).' };
              }
              return { ok: true, value: { name, value, inline: inlineValues[normalizedInline] } };
            },
            (value) => ({ fields: [...(previewEmbed.data.fields ?? []), value] }),
          );
          break;
        case '➖':
          const currentFields = previewEmbed.data.fields ?? [];
          if (currentFields.length === 0) {
            // Avisamos o usuário que não há campos para remover, apagamos a mensagem de aviso e retornamos
            const aviso = await message.reply('Não há campos para remover no embed.');
            setTimeout(() => {
              try { deleteMessage(aviso) } catch (e) {console.error('Erro ao apagar mensagem de aviso:', e);}
            }, 5000);
            return;
          }
          await askAndEdit(
            `Por favor, envie o índice do campo a ser removido (1 a ${currentFields.length}):\n` +
            currentFields.map((field, index) => `**${index + 1}.** ${field.name}`).join('\n'),
            (input) => {
              const index = Number.parseInt(input, 10);
              return Number.isInteger(index) && index >= 1 && index <= currentFields.length
                ? { ok: true, value: index - 1 }
                : { ok: false, error: `O índice deve ser um número entre 1 e ${currentFields.length}.` };
            },
            (index) => ({ fields: currentFields.filter((_, fieldIndex) => fieldIndex !== index) }),
          );
          break;
        case '📷':
          await askAndEdit(
            'Por favor, envie a URL da imagem do embed:',
            (input) => URL.canParse(input)
              ? { ok: true, value: input }
              : { ok: false, error: 'A URL da imagem deve ser uma URL válida.' },
            { answer: (value) => ({ image: value }), remove: { image: null } },
            undefined,
            true,
          );
          break;
        case '🔗':
          await askAndEdit(
            'Por favor, envie a URL do embed:',
            (input) => URL.canParse(input)
              ? { ok: true, value: input }
              : { ok: false, error: 'A URL do embed deve ser uma URL válida.' },
            { answer: (value) => ({ url: value }), remove: { url: null } },
            undefined,
            true,
          );
          break;
        case '✅': {
          const result = await askAuthor({
            message,
            promptText: 'Em qual canal deseja enviar o embed? Mencione o canal, envie o ID ou digite `atual`:',
            validate: (input) => {
              try {
                return { ok: true, value: resolveDestinationChannel(message, input) };
              } catch (error) {
                return { ok: false, error: error.message };
              }
            },
          });
          if (result.type === 'answer') {
            if (!editedFields.title) previewEmbed.setTitle(null);
            if (!editedFields.description) previewEmbed.setDescription(null);
            if (!editedFields.footer) previewEmbed.setFooter(null);
            if (!editedFields.color) previewEmbed.setColor(null);
            await finalizeEmbed(previewEmbed, result.value);
            await deleteMessage(sentMessage);
            stopped = true;
            collector.stop('finished');
            await message.reply('Embed enviado com sucesso!');
          } else if (result.type === 'cancel') {
            // await message.reply('Envio do embed cancelado pelo usuário.');
          }
          break;
        }
        case '❌':
          await message.reply('Criação do embed cancelada pelo usuário.');
          await deleteMessage(sentMessage);
          stopped = true;
          collector.stop('cancelled');
          break;
        default:
          break;
      }
    };

    const startCollector = () => {
      collector = sentMessage.createReactionCollector({ filter, time: 600000 });
      collector.on('collect', (reaction, user) => {
        collector.stop('user');
        actionQueue = actionQueue
          .then(() => handleReaction(reaction))
          .catch((error) => message.reply(`Não foi possível atualizar o embed: ${error.message}`))
          .finally(async () => {
            await sentMessage.removeReaction(reaction.emoji.name, user.id).catch(() => {});
            if (!stopped) startCollector();
          });
      });

      collector.on('end', async (collected, reason) => {
        if (reason === 'time' && !stopped) {
          stopped = true;
          await sentMessage.edit({ content: 'Tempo esgotado para criar o embed. Por favor, tente novamente.', embeds: [] });
        }
      });
    };

    startCollector();
  },
};
