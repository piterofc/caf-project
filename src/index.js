import 'dotenv/config';

console.log('Rodando index.js...');

if (!process.env.FLUXER_TOKEN) {
  throw new Error('A variável FLUXER_TOKEN não foi definida.');
}

// Conexão com o Fluxer aqui

console.log('Configuração inicial carregada.');