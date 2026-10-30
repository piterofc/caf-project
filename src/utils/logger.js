// Logger personalizado.
// Basta importar este arquivo UMA vez, no topo do arquivo principal:  import './logger.js';
// Depois disso, use os métodos normais do console em qualquer lugar, sem importar nada:
//
//   console.info('[BOT]', 'Conectado com sucesso');
//   console.error('[DB]', 'Falha ao conectar', err);
//   console.error(err);

import { createConsola, LogLevels } from "consola";
import { colors } from 'consola/utils';
import kleur from 'kleur';
import { inspect } from 'node:util';

const interceptarConsole = true;             // Defina como false para usar o console original, sem este logger
const registrarErroFatal = false;            // Se true, loga (sem alterar o comportamento do Node) exceções que derrubariam o processo
const marcarLogExterno = true;               // Se true, logs que NÃO começam com [ALGO] ganham o aviso "LOG EXTERNO" e a mensagem desce uma linha
const fundoNaStack = true;                   // Se true, erros ganham fundo (para distinguir do log em si)
const corFundoStack = "48;2;46;52;64m";      // Cor do fundo dos erros: 48;2;R;G;Bm (RGB) ou 48;5;0-255m (256 cores)

// O padrão do Node é 10 frames, o que costuma cortar o caminho até a origem do erro.
Error.stackTraceLimit = 50;

const METODOS = ['log', 'info', 'success', 'warn', 'error', 'fatal', 'debug', 'trace', 'dir', 'table'];

// Preserva o console original antes de interceptá-lo (o reporter usa isso para imprimir).
const consoleOriginal = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    success: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    fatal: console.error.bind(console),
    debug: console.debug.bind(console),
    trace: console.trace.bind(console),
    dir: console.dir.bind(console),
    table: console.table.bind(console),
};

// O consola não possui dir/table, então eles usam log.
const metodoConsola = (metodo) => (metodo === 'dir' || metodo === 'table' ? 'log' : metodo);

// Função para gerar timestamp no formato BR
function timestamp() {
    return new Date().toLocaleString('pt-BR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    });
}

// Aplica fundo em cada linha de stack.
// O fundo é aplicado linha a linha e reiniciado no fim de cada uma, para não vazar para o resto do log.
// O regex aceita códigos ANSI no início da linha, pois o Node escurece frames de node_modules.
const REGEX_LINHA_STACK = /^(?:\x1b\[[0-9;]*m)*\s+at\s/;
const comFundo = (linha) => `\x1b[${corFundoStack}${linha}\x1b[49m`;

// Fundo em TODAS as linhas do texto (usado para erros: mensagem, stack, cause e propriedades)
function destacarBloco(texto) {
    return texto.split('\n').map(comFundo).join('\n');
}

// Fundo apenas nas linhas "at ..." (usado para a pilha do console.trace e para erros dentro de objetos)
function destacarStack(texto) {
    return texto
        .split('\n')
        .map((linha) => (REGEX_LINHA_STACK.test(linha) ? comFundo(linha) : linha))
        .join('\n');
}

// Pilha de chamadas atual (usada no trace). Remove as 3 primeiras linhas:
// "Error", esta função e o wrapper que a chamou.
function pilhaAtual() {
    const pilha = new Error().stack.split('\n').slice(3).join('\n');
    return fundoNaStack ? destacarStack(pilha) : pilha;
}

// Formata um argumento para exibição.
// Erros mantêm stack completa, `cause` e propriedades extras (via util.inspect).
function formatarArgumento(arg, indice) {
    if (typeof arg === 'string') return arg;

    let texto = inspect(arg, {
        depth: 6,
        colors: true,
        breakLength: 120,
        compact: 3,
    });

    if (fundoNaStack) {
        texto = arg instanceof Error ? destacarBloco(texto) : destacarStack(texto);
    }

    // Erros que vêm depois de uma mensagem ficam em uma nova linha, para a stack ficar legível
    return arg instanceof Error && indice > 0 ? `\n${texto}` : texto;
}

// Um log é considerado "do bot" quando o primeiro argumento é uma string que começa com [ALGO].
// Aceita códigos de cor ANSI e espaços antes do colchete. Qualquer outra coisa é "externo".
const REGEX_LOG_DO_BOT = /^(?:\x1b\[[0-9;]*m)*\s*\[[^\]\n]+\]/;
function ehLogExterno(args) {
    return !(typeof args[0] === 'string' && REGEX_LOG_DO_BOT.test(args[0]));
}

// Reporter personalizado
const reporter = {
    log(logObj) {
        const data = colors.magentaBright(`[${timestamp()}]`);
        const message = logObj.args.map(formatarArgumento).join(' ');

        const levelColor = {
            log: (texto) => kleur.white(texto),
            info: (texto) => kleur.white().bgBlue().bold(texto),
            success: (texto) => kleur.white().bgGreen().bold(texto),
            warn: (texto) => kleur.black().bgYellow().bold(texto),
            error: (texto) => kleur.white().bgRed().bold(texto),
            fatal: (texto) => kleur.white().bgRed().bold(texto),
            debug: (texto) => kleur.white().bgBlack().bold(texto),
            trace: (texto) => kleur.white().bgBlack().bold(texto),
        }[logObj.type] ?? ((texto) => kleur.white(texto));

        // Traduz o nível de log para português
        const nivelTraduzido = {
            log: 'LOG',
            info: 'INFO',
            success: 'SUCESSO',
            warn: 'AVISO',
            error: 'ERRO',
            fatal: 'FATAL',
            debug: 'DEBUG',
            trace: 'TRACE',
        }[logObj.type] ?? logObj.type.toUpperCase();

        const cabecalho = `${data} ${levelColor(nivelTraduzido.padEnd(7))}`;

        if (marcarLogExterno && ehLogExterno(logObj.args)) {
            // Log de fora do bot: aviso ao lado do nível e mensagem na linha de baixo
            consoleOriginal.log(`${cabecalho} ${kleur.yellow().bold('LOG EXTERNO AO BOT:')}\n${message}`);
        } else {
            consoleOriginal.log(`${cabecalho} ${message}`);
        }
    },
};

// Cria uma instância do logger
export const consola = createConsola({
    reporters: [reporter],
    level: LogLevels.verbose, // mostra tudo, inclusive debug e trace (o padrão esconde)
    throttle: 0,              // não descarta logs idênticos repetidos
    formatOptions: {
        date: false,
        colors: true,
        compact: false,
    },
});

if (interceptarConsole) {
    for (const metodo of METODOS) {
        console[metodo] = (...args) => {
            if (metodo === 'dir') args = args.slice(0, 1); // ignora o segundo argumento (opções) do console.dir
            if (metodo === 'trace') args.push(pilhaAtual());

            consola[metodoConsola(metodo)](...args);
        };
    }
}

if (registrarErroFatal) {
    // "Monitor" apenas observa: não impede o processo de encerrar como o Node faria normalmente.
    process.on('uncaughtExceptionMonitor', (err, origem) => {
        consola.fatal(`[PROCESSO] Exceção não tratada (${origem})`, err);
    });
}