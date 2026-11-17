export default {
  name: 'ping',
  aliases: ['p'],
  categoria: 'utilidades',
  descricao: 'Verifica se o bot está respondendo.',
  uso: 'ping',
  exemplos: ['ping', 'p'],

  async execute({ client, message }) {
    // Vamos fazer um ping completo, incluindo cálculo de latência e tempo de resposta do bot e do Fluxer
    const start = Date.now();
    const sentMessage = await message.reply(`🏓 Pong!\n${client.brain.emojis.carregando_anim}Calculando latência...`);
    const responseTime = Date.now() - start;

    // Latência
    const latency = sentMessage.createdAt - message.createdAt;

    // Websocket
    const websocketPing = Math.round(await message.client.ws.ping);

    await sentMessage.edit({
      content: `🏓 Pong!\n` +
               `> [!NOTE]\n` +
               `> ⌛ Latência: ${latency}ms\n` +
               `> 📡 API/resposta: ${responseTime}ms\n` +
               `> 💓 Ping do WebSocket: ${websocketPing}ms`
    })
  },
};
