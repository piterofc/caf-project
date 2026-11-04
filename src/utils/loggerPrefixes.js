// Aqui vamos definir os prefixos de log para cada módulo do bot, para que possamos identificar facilmente de onde vem cada mensagem de log.
import kleur from 'kleur';
import { RGBtoANSI, resetForegroundANSI } from './ANSI.js';

// Definição de cores para os prefixos de log
let colcheteCor = RGBtoANSI('texto', 245, 120, 66); // Laranja
let resetCor = resetForegroundANSI(); // Resetar para a cor padrão do terminal

/**
 * 
 * @param {*} prefixo 
 * @returns {string} Prefixo formatado com colchetes e cor
 * 
 * @example circundarPrefixo('INDEX') => [INDEX] (com colchetes laranja e texto padrão)
 */
function circundarPrefixo(prefixo) {
    return `${colcheteCor}[${resetCor}${prefixo}${colcheteCor}]${resetCor}`;
}

export const INDEX_PREFIX = circundarPrefixo(kleur.yellow('INDEX'));
export const CLIENT_PREFIX = circundarPrefixo(kleur.cyan('CLIENT'));
export const CMDHANDLER_PREFIX = circundarPrefixo(kleur.green('COMMAND HANDLER'));
export const EVENTHANDLER_PREFIX = circundarPrefixo(kleur.blue('EVENT HANDLER'));
export const DASHBOARD_PREFIX = circundarPrefixo(kleur.red('DASHBOARD'));
export const DATABASE_PREFIX = circundarPrefixo(kleur.magenta('DATABASE'));
export const PAGINATION_PREFIX = circundarPrefixo(kleur.cyan('PAGINATE'));
export const GIVEAWAY_PREFIX = circundarPrefixo(kleur.yellow('GIVEAWAYS'));