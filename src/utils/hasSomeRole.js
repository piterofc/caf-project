/**
 * Verifica se um usuário possui algum dos cargos permitidos em um servidor específico.
 * @param {Client} client A instância do cliente do Discord.
 * @param {string} userId O ID do usuário a ser verificado.
 * @param {string} guildId O ID do servidor onde a verificação será feita.
 * @param {Array<string>} allowedRoleIds Um array contendo os IDs dos cargos permitidos.
 * @returns {Promise<boolean>} Retorna uma Promise que resolve para true se o usuário possuir algum dos cargos permitidos, caso contrário, false.
 * @throws {Error} se algum parâmetro inválido for fornecido
 * @throws {Error} se o servidor ou membro não for encontrado
 * 
 * @example
 * const hasRole = await hasSomeRole(client, '123456789012345678', '987654321098765432', ['111111111111111111', '222222222222222222']);
 */
export async function hasSomeRole(client, userId, guildId, allowedRoleIds) {
  if (!client || !userId || !guildId || !allowedRoleIds) {
    console.error('Parâmetros inválidos fornecidos para hasSomeRole.');
    throw new Error('Parâmetros inválidos fornecidos para hasSomeRole.');
  }

  if (!Array.isArray(allowedRoleIds) || allowedRoleIds.length === 0) {
    console.error('allowedRoleIds deve ser um array não vazio.');
    throw new Error('allowedRoleIds deve ser um array não vazio.');
  }

  const servidor = await client.guilds.resolve(guildId);
  if (!servidor) {
    console.error(`Servidor com ID ${guildId} não encontrado.`);
    throw new Error(`Servidor com ID ${guildId} não encontrado.`);
  }

  const membro = await servidor.members.resolve(userId);
  if (!membro) {
    console.log(`Membro com ID ${userId} não encontrado no servidor ${guildId}.`);
    throw new Error(`Membro com ID ${userId} não encontrado no servidor ${guildId}.`);
  }

  let result = membro.roles.roleIds.some((roleId) => allowedRoleIds.includes(roleId));
  return result;
}

export default hasSomeRole;