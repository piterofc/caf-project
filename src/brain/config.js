const prefix = '+';
const mainGuildId = '1561171272639979520';

const FLUXER_CLIENT_ID = process.env.FLUXER_CLIENT_ID || 'YOUR_FLUXER_CLIENT_ID';
const FLUXER_CLIENT_SECRET = process.env.FLUXER_CLIENT_SECRET || 'YOUR_FLUXER_CLIENT_SECRET';
const DASHBOARD_SESSION_SECRET = process.env.DASHBOARD_SESSION_SECRET || 'your_dashboard_session_secret';

// Ativar bot completo sem estar cadastrado
const bypassCadastroIds = [
    mainGuildId, // Servidor principal do bot
    '1474395299655832437', // Servidor da Família BR
]

// Permissão por cargo para comandos específicos
const cargosPermitidos = {
    cmd_servidor: [
        "1563288876938702848", // Administrador
    ],
    cmd_gban: [
        "1563288876938702848", // Administrador
    ],
}

// Configurações de status do bot
const statusConfig = {
    list: [
        { status: 'online', text: 'Integrando a comunidade BR' },
        { status: 'online', text: 'Somos {{num_servidores}} participantes!' },
        { status: 'online', text: 'Bora trazer o Brasil pro Fluxer!' },
        { status: 'online', text: 'Faça parte da network! Envie uma DM para piterofc#1234' },
    ],
    interval: 7.5 * 1000 // 15 segundos
}

// Configurações para sair de servidores não cadastrados
const sairDeServers = {
    bypassIds: [
        mainGuildId, // Servidor principal do bot
        '1564469396561203200', // CAF Emojis 1
        '1474395299655832437', // Servidor da Família BR
    ],
    interval: 15 * 1000 // 15 segundos
}

// Configurações dos giveaways
const giveawayConfig = {
    interval: 15 * 1000, // 15 segundos entre cada verificação de giveaways para publicar/encerrar
}

// Configurações do dashboard
const baseUrl = 'http://localhost:8080'; // Altere para o seu domínio
const dashboardConfig = {
    baseUrl,
    port: 8080, // Porta do servidor web
    clientId: FLUXER_CLIENT_ID,
    clientSecret: FLUXER_CLIENT_SECRET,
    callbackURL: `${baseUrl}/auth/fluxer/callback`,
    sessionSecret: DASHBOARD_SESSION_SECRET,
}

export default {
  prefix,
  mainGuildId,
  bypassCadastroIds,
  cargosPermitidos,
  statusConfig,
  sairDeServers,
  giveawayConfig,
  dashboardConfig,
};
