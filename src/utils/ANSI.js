/*******************************************
 *      COMO USAR CÓDIGOS ANSI DE COR      *
 * "\x1b[" - INÍCIO DO CÓDIGO ANSI         *
 * 38;2;R;G;Bm - COR DO TEXTO (RGB)        *
 * 38;5;0-255m - COR DO TEXTO (256 CORES)  *
 * 48;2;R;G;Bm - COR DE FUNDO (RGB)        *
 * 48;5;0-255m - COR DE FUNDO (256 CORES)  *
 * 39m - COR DO TEXTO PADRÃO               *
 * 49m - COR DE FUNDO PADRÃO               *
 * 0m - RESETAR TODAS AS CORES E ESTILOS   *
 * ****************************************/

// https://github.com/bokub/gradient-string - Para gradientes
// https://github.com/sindresorhus/terminal-link - Para liks clicáveis no terminal

/** Escape */
const ESC = "\x1b["; // Início do código ANSI

/**
 * Converte valores RGB para códigos ANSI de cor.
 * @param {*} tipo "texto"/"foreground" ou "fundo"/"background"
 * @param {*} r valor de vermelho (0-255)
 * @param {*} g valor de verde (0-255)
 * @param {*} b valor de azul (0-255)
 * @returns {string} Código ANSI correspondente
 * @throws {Error} se os valores de r, g ou b não forem números ou estiverem fora do intervalo 0-255
 * @throws {Error} se o tipo não for "texto"/"foreground" ou "fundo"/"background"
 */
export function RGBtoANSI(tipo, r, g, b) {
    if (typeof r !== 'number' || typeof g !== 'number' || typeof b !== 'number') {
        throw new Error('Os valores de r, g e b devem ser números.');
    }

    if (r < 0 || r > 255 || g < 0 || g > 255 || b < 0 || b > 255) {
        throw new Error('Os valores de r, g e b devem estar entre 0 e 255.');
    }

    if (tipo == 'texto' || tipo == 'foreground') {
        return `${ESC}38;2;${r};${g};${b}m`;
    }
    if (tipo == 'fundo' || tipo == 'background') {
        return `${ESC}48;2;${r};${g};${b}m`;
    }

    throw new Error('Tipo inválido. Use "texto"/"foreground" ou "fundo"/"background".');
}

/**
 * Imprime a cor no console
 * @param {string} tipo "texto"/"foreground" ou "fundo"/"background"
 * @param {number} code valor de cor (0-255)
 * @returns {string} String ANSI correspondente
 * @throws {Error} se o tipo não for "texto"/"foreground" ou "fundo"/"background"
 * @throws {Error} se o valor de code não for um número
 */
export function ANSIColor(tipo, code) {
    if (typeof code !== 'number') {
        throw new Error('O valor de code deve ser um número.');
    }

    if (tipo == 'texto' || tipo == 'foreground') {
        return `${ESC}38;5;${code}m`;
    }
    if (tipo == 'fundo' || tipo == 'background') {
        return `${ESC}48;5;${code}m`;
    }

    throw new Error('Tipo inválido. Use "texto"/"foreground" ou "fundo"/"background".');
}

/**
 * Reseta a cor do texto para o padrão.
 * @returns {string} Código ANSI para resetar a cor do texto
 */
export function resetForegroundANSI() {
    return `${ESC}39m`;
}

/**
 * Reseta a cor de fundo para o padrão.
 * @returns {string} Código ANSI para resetar a cor de fundo
 */
export function resetBackgroundANSI() {
    return `${ESC}49m`;
}

/**
 * Reseta todas as cores e estilos para o padrão.
 * @returns {string} Código ANSI para resetar todas as cores e estilos
 */
export function resetANSI() {
    return `${ESC}0m`;
}