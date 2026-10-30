import 'dotenv/config';
import brain from './brain/brain.js';
import kleur from 'kleur';
import { WebServer } from './dashboard/webserver.js';

export const client = brain.client;
client.brain = brain;

import { INDEX_PREFIX } from './utils/loggerPrefixes.js';
import { CLIENT_PREFIX } from './utils/loggerPrefixes.js';

// https://patorjk.com/software/taag/ | Anarchy - cor: Purp
console.log("[START]", `
[0;37m    ▄▄▄▄     ▄▄▄▄        ▄▄▄▄ [0m
[0;37m  ▄[0;37;45m▀[0;35m████[0;90m█[0;37m   █[0;35m████[0;90m█[0;37m     ▄[0;37;45m▀[0;35m████[0;90m█[0m
[0;37m █[0;35m██[0;90;45m▄[0;90m▀▀▀▀[0;37m  █[0;35m██[0;90m█[0;37m█[0;35m██[0;90m█[0;37m   █[0;35m██[0;90;45m▄[0;90m▀▀▀▀[0m
[0;37m▐[0;37;45m▌[0;35m█[0;90;45m▐[0;90m▌[0;37m     ▐[0;37;45m▌[0;35m█[0;90m█[0;37m ▐[0;37;45m▌[0;35m█[0;90;45m▐[0;90m▌[0;37m ▐[0;37;45m▌[0;35m██[0;37;45m▀▀▀[0;90m▄[0;37m [0m
[0;37m▐[0;37;45m▌[0;35m█[0;90;45m▐[0;90m▌[0;37m     █[0;35m████████[0;90m█[0;37m ▐[0;37;45m▌[0;35m██[0;90;45m▄▄▄[0;90m█[0;37m [0m
[0;37m █[0;35m██[0;90;45m▀[0;90m▄[0;37m▄▄  █[0;35m██[0;90m█▀▀[0;37m█[0;35m██[0;90m█[0;37m ▐[0;37;45m▌[0;35m██[0;90m█[0;37m    [0m
[0;37m  ▀[0;37;45m▄[0;35m████[0;90m█[0;37m █[0;35m██[0;90m█[0;37m  █[0;35m██[0;90m█[0;37m ▐[0;37;45m▌[0;35m██[0;90m█[0;37m    [0m
[0;37m    [0;90m▀▀▀▀▀[0;37m [0;90m▀▀▀▀[0;37m  [0;90m▀▀▀▀[0;37m  [0;90m▀▀▀▀[0;37m    [0m`);

console.info(INDEX_PREFIX, 'Iniciando o bot...');

async function iniciarBot() {
    if (!process.env.FLUXER_TOKEN) {
        throw new Error('A variável FLUXER_TOKEN não foi definida.');
    }

    // Carregamos os comandos antes de conectar para não perder mensagens iniciais.
    await brain.carregarCmds(client);

    // Registramos os eventos do bot
    await brain.carregarEventos(client);

    // Fazemos login no Fluxer
    await client.login(process.env.FLUXER_TOKEN);

    // Logamos que o bot está online
    console.success(INDEX_PREFIX, 'Bot iniciado com sucesso!');

    // Iniciamos o dashboard
    await iniciarDashboard(client);
}

async function encerrarBot(motivo = "", exitCode = 0) {
    // Separador
    console.log(INDEX_PREFIX, kleur.gray('='.repeat(50)));
    console.info(INDEX_PREFIX, `Encerrando o bot... Motivo: ${motivo}`);
    await client.destroy();
    console.info(CLIENT_PREFIX, 'Bot encerrado com sucesso!');
    process.exit(exitCode);
}

async function iniciarDashboard(client) {
    console.info(INDEX_PREFIX, 'Iniciando o dashboard...');
    let webserver = new WebServer(client);
    webserver.startServer();
}

// Tratamento de erros não tratados
process.on('unhandledRejection', (reason, promise) => {
    console.error(INDEX_PREFIX, 'Rejeição não tratada em:', promise, 'motivo:', reason);
});

// Tratamento de exceções não capturadas
process.on('uncaughtException', (error) => {
    console.error(INDEX_PREFIX, 'Exceção não capturada:', error);
    encerrarBot('Exceção não capturada', 1);
});

// Tratamento de sinal de término do processo (SIGINT, SIGTERM, SIGHUP, SIGQUIT)
process.on('exit', (code) => {
    console.info(INDEX_PREFIX, `Processo de saída com código: ${code}`);
});

// Interrupção do terminal (Ctrl+C)
process.on('SIGINT', () => {
    encerrarBot('Recebido SIGINT (Ctrl+C)', 0);
});

// Solicitação de término do processo
process.on('SIGTERM', () => {
    encerrarBot('Recebido SIGTERM', 0);
});

// Hangup do terminal, geralmente enviado quando o terminal é fechado
process.on('SIGHUP', () => {
    encerrarBot('Recebido SIGHUP', 0);
});

// Solicitação de término do processo com despejo de núcleo
process.on('SIGQUIT', () => {
    encerrarBot('Recebido SIGQUIT', 0);
});


// Iniciamos o bot
iniciarBot().catch((error) => {
    console.error(INDEX_PREFIX, 'Erro ao iniciar o bot:', error);
});
