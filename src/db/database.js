import { QuickDB } from 'quick.db';

const db = new QuickDB({ filePath: "src/db/database.db" });

// Tabelas
const serversTable = db.table('servers');
const globalBansTable = db.table('globalBans');
const globalBanHistoryTable = db.table('globalBanHistory');
export const dashboardSessionsTable = db.table('dashboardSessions');
const giveawaysTable = db.table('giveaways');
const levelingTable = db.table('leveling');

function definedProperties(value) {
    return Object.fromEntries(
        Object.entries(value).filter(([, propertyValue]) => propertyValue !== undefined)
    );
}

function validateModerationConfig(config, allowedKeys) {
    const filteredConfig = definedProperties(config);

    for (const key of Object.keys(filteredConfig)) {
        if (!allowedKeys.includes(key)) {
            throw new Error(`Configuração de moderação inválida: ${key}.`);
        }
    }

    for (const key of ['maxBansPerCommand', 'maxKicksPerCommand', 'maxMutesPerCommand']) {
        if (key in filteredConfig &&
            (!Number.isInteger(filteredConfig[key]) || filteredConfig[key] < 1 || filteredConfig[key] > 100)) {
            throw new Error(`${key} deve ser um número inteiro entre 1 e 100.`);
        }
    }

    for (const key of ['banConfirm', 'kickConfirm', 'muteConfirm']) {
        if (key in filteredConfig && typeof filteredConfig[key] !== 'boolean') {
            throw new Error(`${key} deve ser um valor booleano.`);
        }
    }

    if ('muteMode' in filteredConfig &&
        !['padrao', 'perguntar_motivo', 'perguntar_tempo'].includes(filteredConfig.muteMode)) {
        throw new Error('muteMode possui um valor inválido.');
    }

    return filteredConfig;
}

function validateLevelingConfig(config) {
    const filteredConfig = definedProperties(config);
    const allowedKeys = ['enabled', 'xpMin', 'xpMax', 'cooldownSeconds', 'xpPerLevel', 'announce', 'levelUpMessage', 'levelUpChannelId', 'removePreviousRoles', 'levelRoles', 'roleBoosts'];

    for (const key of Object.keys(filteredConfig)) {
        if (!allowedKeys.includes(key)) throw new Error(`Configuração de níveis inválida: ${key}.`);
    }
    for (const key of ['xpMin', 'xpMax', 'cooldownSeconds', 'xpPerLevel']) {
        if (key in filteredConfig && (!Number.isInteger(filteredConfig[key]) || filteredConfig[key] < 0 || filteredConfig[key] > 1000000)) {
            throw new Error(`${key} deve ser um número inteiro entre 0 e 1000000.`);
        }
    }
    for (const key of ['enabled', 'announce', 'removePreviousRoles']) {
        if (key in filteredConfig && typeof filteredConfig[key] !== 'boolean') throw new Error(`${key} deve ser booleano.`);
    }
    if ('levelUpMessage' in filteredConfig && (typeof filteredConfig.levelUpMessage !== 'string' || filteredConfig.levelUpMessage.length > 1000)) throw new Error('levelUpMessage deve ser uma string de até 1000 caracteres.');
    if ('levelUpChannelId' in filteredConfig && filteredConfig.levelUpChannelId !== null && typeof filteredConfig.levelUpChannelId !== 'string') throw new Error('levelUpChannelId deve ser um canal válido ou nulo.');
    if ('levelRoles' in filteredConfig && (!Array.isArray(filteredConfig.levelRoles) || filteredConfig.levelRoles.some((item) => !Number.isInteger(item.level) || item.level < 1 || typeof item.roleId !== 'string'))) {
        throw new Error('levelRoles possui um formato inválido.');
    }
    if ('roleBoosts' in filteredConfig && (!Array.isArray(filteredConfig.roleBoosts) || filteredConfig.roleBoosts.some((item) => typeof item.roleId !== 'string' || typeof item.multiplier !== 'number' || item.multiplier < 1 || item.multiplier > 10))) {
        throw new Error('roleBoosts possui um formato inválido.');
    }
    if (filteredConfig.xpMin !== undefined && filteredConfig.xpMax !== undefined && filteredConfig.xpMin > filteredConfig.xpMax) {
        throw new Error('xpMin não pode ser maior que xpMax.');
    }
    if (filteredConfig.xpPerLevel !== undefined && filteredConfig.xpPerLevel < 1) throw new Error('xpPerLevel deve ser maior que zero.');

    return filteredConfig;
}

export const Server = {
    dbFunctions: {
        _getAll: async () => {
            return (await serversTable.all()) ?? {};
        },
        _get: async (serverId) => {
            return (await serversTable.get(serverId)) ?? null;
        },
        _set: async (serverId, serverData) => {
            if (!serverData || typeof serverData !== 'object') {
                throw new Error('serverData deve ser um objeto válido.');
            }
            let resp = await serversTable.set(serverId, serverData);
            if (resp) {
                return({ success: true, message: `Servidor setado com sucesso!` });
            }
        },
        _update: async (serverId, serverData) => {
            if (!serverData || typeof serverData !== 'object') {
                throw new Error('serverData deve ser um objeto válido.');
            }
            const existingData = await Server.dbFunctions._get(serverId);
            const updatedData = { ...existingData, ...serverData };
            let resp = await Server.dbFunctions._set(serverId, updatedData)
            if (resp) {
                return({ success: true, message: `Servidor atualizado com sucesso!` });
            }
        },
        _delete: async (serverId) => {
            let existingData = await Server.get(serverId);
            if (!existingData || Object.keys(existingData).length === 0) {
                return({ success: false, message: `Servidor não encontrado.` });
            }

            let resp = await serversTable.delete(serverId)
            if (resp) {
                return({ success: true, message: `Servidor deletado com sucesso!` });
            }
        }
    },
    getAll: async () => {
        return await Server.dbFunctions._getAll();
    },
    getAllComplete: async () => {
        const allServers = await Server.dbFunctions._getAll();
        const completeServers = Object.entries(allServers).filter(([serverId, serverData]) => serverData.value.cadastroCompleto);
        return completeServers.map(([serverId, serverData]) => ({ id: serverId, value: serverData }));
    },
    get: async (serverId) => {
        return await Server.dbFunctions._get(serverId);
    },
    create: async (serverId, serverData) => {
        // Verifica se o servidor já existe
        const existingData = await Server.dbFunctions._get(serverId);
        if (existingData && Object.keys(existingData).length > 0) {
            return({ success: false, message: `servidor já existente.` });
        }

        let resp = await Server.dbFunctions._set(serverId, serverData);
        if (resp.success) {
            return({ success: true, message: `Servidor cadastrado com sucesso!` });
        }
    },
    delete: async (serverId) => {
        return await Server.dbFunctions._delete(serverId);
    },
    getPrefix: async (serverId) => {
        const serverData = await Server.dbFunctions._get(serverId);
        return serverData?.prefix ?? null;
    },
    setPrefix: async (serverId, newPrefix) => {
        if (typeof newPrefix !== 'string' || newPrefix.length === 0) {
            throw new Error('newPrefix deve ser uma string válida.');
        }
        const newServerData = { prefix: newPrefix };
        let resp = await Server.dbFunctions._update(serverId, newServerData);
        if (resp.success) {
            return({ success: true, message: `Prefixo atualizado para \`${newPrefix}\` com sucesso!` });
        }
    },
    toggleBanSync: async (serverId) => {
        const serverData = await Server.dbFunctions._get(serverId);
        if (!serverData || Object.keys(serverData).length === 0) {
            return({ success: false, message: `Servidor não encontrado.` });
        }
        const newBanSyncValue = !serverData.banSync;
        const newServerData = { banSync: newBanSyncValue };
        let resp = await Server.dbFunctions._update(serverId, newServerData);
        if (resp.success) {
            return({ success: true, message: `BanSync atualizado para \`${newBanSyncValue}\` com sucesso!` });
        }
    },
    setBanSync: async (serverId, banSync) => {
        if (typeof banSync !== 'boolean') {
            throw new Error('banSync deve ser um valor booleano.');
        }
        const serverData = await Server.dbFunctions._get(serverId);
        if (!serverData || Object.keys(serverData).length === 0) {
            return({ success: false, message: `Servidor não encontrado.` });
        }
        const newServerData = { banSync: banSync };
        let resp = await Server.dbFunctions._update(serverId, newServerData);
        if (resp.success) {
            return({ success: true, message: `BanSync atualizado para \`${banSync}\` com sucesso!` });
        }
    },
    setLevelingConfig: async (serverId, levelingConfig) => {
        if (!levelingConfig || typeof levelingConfig !== 'object') throw new Error('levelingConfig deve ser um objeto válido.');
        const validConfig = validateLevelingConfig(levelingConfig);
        const serverData = await Server.dbFunctions._get(serverId);
        if (!serverData || Object.keys(serverData).length === 0) return { success: false, message: 'Servidor não encontrado.' };

        const response = await Server.dbFunctions._update(serverId, {
            leveling: { ...serverData.leveling, ...validConfig }
        });
        return response.success ? { success: true, message: 'Configuração de níveis atualizada com sucesso!' } : response;
    },

    // Moderação - ban config
    setModerationBanConfig: async (serverId, banConfig) => {
        if (!banConfig || typeof banConfig !== 'object') {
            throw new Error('banConfig deve ser um objeto válido.');
        }
        banConfig = validateModerationConfig(banConfig, ['maxBansPerCommand', 'banConfirm']);

        const serverData = await Server.dbFunctions._get(serverId);
        if (!serverData || Object.keys(serverData).length === 0) {
            return({ success: false, message: `Servidor não encontrado.` });
        }

        const newServerData = { moderation: { ...serverData.moderation, ...banConfig } };
        let resp = await Server.dbFunctions._update(serverId, newServerData);

        if (resp.success) {
            return({ success: true, message: `Configuração de banimento atualizada com sucesso!` });
        }
    },

    // Moderação - kick config
    setModerationKickConfig: async (serverId, kickConfig) => {
        if (!kickConfig || typeof kickConfig !== 'object') {
            throw new Error('kickConfig deve ser um objeto válido.');
        }
        kickConfig = validateModerationConfig(kickConfig, ['maxKicksPerCommand', 'kickConfirm']);

        const serverData = await Server.dbFunctions._get(serverId);
        if (!serverData || Object.keys(serverData).length === 0) {
            return({ success: false, message: `Servidor não encontrado.` });
        }

        const newServerData = { moderation: { ...serverData.moderation, ...kickConfig } };
        let resp = await Server.dbFunctions._update(serverId, newServerData);

        if (resp.success) {
            return({ success: true, message: `Configuração de expulsão atualizada com sucesso!` });
        }
    },

    // Moderação - mute config
    setModerationMuteConfig: async (serverId, muteConfig) => {
        if (!muteConfig || typeof muteConfig !== 'object') {
            throw new Error('muteConfig deve ser um objeto válido.');
        }
        muteConfig = validateModerationConfig(muteConfig, ['maxMutesPerCommand', 'muteConfirm', 'muteMode']);

        const serverData = await Server.dbFunctions._get(serverId);
        if (!serverData || Object.keys(serverData).length === 0) {
            return({ success: false, message: `Servidor não encontrado.` });
        }

        const newServerData = { moderation: { ...serverData.moderation, ...muteConfig } };
        let resp = await Server.dbFunctions._update(serverId, newServerData);

        if (resp.success) {
            return({ success: true, message: `Configuração de silenciamento atualizada com sucesso!` });
        }
    }
}

export const Leveling = {
    get: async (guildId, userId) => {
        const value = await levelingTable.get(`${guildId}:${userId}`);
        return value ? { xp: value.xp ?? 0, updatedAt: value.updatedAt } : { xp: 0 };
    },
    set: async (guildId, userId, data) => levelingTable.set(`${guildId}:${userId}`, data),
    delete: async (guildId, userId) => levelingTable.delete(`${guildId}:${userId}`),
    deleteAll: async (guildId) => {
        const entries = await levelingTable.all();
        await Promise.all(entries.filter((entry) => entry.id.startsWith(`${guildId}:`)).map((entry) => levelingTable.delete(entry.id)));
    },
    getAll: async (guildId) => {
        const entries = await levelingTable.all();
        return entries
            .filter((entry) => entry.id.startsWith(`${guildId}:`))
            .map((entry) => ({ userId: entry.id.slice(guildId.length + 1), xp: entry.value?.xp ?? 0, updatedAt: entry.value?.updatedAt }));
    },
};

export const GlobalBan = {
    dbFunctions: {
        _getAll: async () => {
            return (await globalBansTable.all()) ?? {};
        },
        _get: async (userId) => {
            return (await globalBansTable.get(userId)) ?? {};
        },
        _set: async (userId, banData) => {
            if (!banData || typeof banData !== 'object') {
                throw new Error('banData deve ser um objeto válido.');
            }
            let resp = await globalBansTable.set(userId, banData);
            if (resp) {
                return({ success: true, message: `Usuário banido globalmente com sucesso!` });
            }
        },
        _delete: async (userId) => {
            let existingData = await GlobalBan.dbFunctions._get(userId);
            if (!existingData || Object.keys(existingData).length === 0) {
                return({ success: false, message: `Usuário não encontrado.` });
            }
            let resp = await globalBansTable.delete(userId)
            if (resp) {
                return({ success: true, message: `Usuário desbanido globalmente com sucesso!` });
            }
        }
    },
    getAll: async () => {
        return await GlobalBan.dbFunctions._getAll();
    },
    get: async (userId) => {
        return await GlobalBan.dbFunctions._get(userId);
    },
    add: async (userId, banData) => {
        // Verifica se o usuário já está banido
        const existingData = await GlobalBan.dbFunctions._get(userId);
        if (existingData && Object.keys(existingData).length > 0) {
            return({ success: false, message: `Usuário já está banido globalmente.` });
        }
        let resp = await GlobalBan.dbFunctions._set(userId, banData);
        if (resp.success) {
            return({ success: true, message: `Usuário banido globalmente com sucesso!` });
        }
    },
    remove: async (userId) => {
        return await GlobalBan.dbFunctions._delete(userId);
    }
}

export const GlobalBanHistory = {
    dbFunctions: {
        _getAll: async () => {
            return (await globalBanHistoryTable.all()) ?? {};
        },
        _get: async (userId) => {
            return (await globalBanHistoryTable.get(userId)) ?? [];
        },
        _add: async (userId, historyData) => {
            if (!historyData || typeof historyData !== 'object') {
                throw new Error('historyData deve ser um objeto válido.');
            }
            let existingHistory = await GlobalBanHistory.dbFunctions._get(userId);
            existingHistory.push(historyData);
            let resp = await globalBanHistoryTable.set(userId, existingHistory);
            if (resp) {
                return({ success: true, message: `Histórico atualizado com sucesso!` });
            }
        }
    },
    getAll: async () => {
        return await GlobalBanHistory.dbFunctions._getAll();
    },
    get: async (userId) => {
        return await GlobalBanHistory.dbFunctions._get(userId);
    },
    add: async (userId, historyData) => {
        return await GlobalBanHistory.dbFunctions._add(userId, historyData);
    }
}

const GIVEAWAY_STATUSES = ['scheduled', 'pending', 'publishing', 'running', 'ending', 'ended', 'cancelled', 'failed'];

function validateGiveaway(giveaway) {
    if (!giveaway || typeof giveaway !== 'object') {
        throw new Error('giveaway deve ser um objeto válido.');
    }

    if (!giveaway.guildId || !giveaway.id || !giveaway.channelId) {
        throw new Error('Um giveaway precisa de guildId, id e channelId.');
    }

    if (!Number.isInteger(giveaway.winners) || giveaway.winners < 1 || giveaway.winners > 100) {
        throw new Error('winners deve ser um inteiro entre 1 e 100.');
    }

    if (!GIVEAWAY_STATUSES.includes(giveaway.status)) {
        throw new Error(`Status de giveaway inválido: ${giveaway.status}.`);
    }

    if (giveaway.entrants !== undefined && !Array.isArray(giveaway.entrants)) {
        throw new Error('entrants deve ser uma lista de IDs.');
    }

    return giveaway;
}

// Como o QuickDB não tem transações, serializamos (por giveaway) tudo que lê e depois grava.
// Sem isso, duas reações simultâneas leem a mesma lista de participantes e uma delas se perde.
const giveawayLocks = new Map();

function withGiveawayLock(id, task) {
    const previous = giveawayLocks.get(id) ?? Promise.resolve();
    const run = previous.then(task, task);
    const tail = run.catch(() => {});
    giveawayLocks.set(id, tail);
    tail.then(() => {
        if (giveawayLocks.get(id) === tail) giveawayLocks.delete(id);
    });
    return run;
}

async function persistGiveaway(giveaway) {
    const valid = validateGiveaway(giveaway);
    await giveawaysTable.set(valid.id, valid);
    return valid;
}

export const Giveaways = {
    getAll: async () => {
        const rows = (await giveawaysTable.all()) ?? [];
        if (Array.isArray(rows)) {
            return Object.fromEntries(rows.map((row) => [row.id, row.value]));
        }
        return rows;
    },
    get: async (id) => (await giveawaysTable.get(id)) ?? null,
    list: async (guildId) => {
        const all = await Giveaways.getAll();
        return Object.values(all).filter((item) => item?.guildId === guildId);
    },
    save: async (giveaway) => {
        validateGiveaway(giveaway);
        return withGiveawayLock(giveaway.id, () => persistGiveaway(giveaway));
    },
    /**
     * Lê, decide e grava com exclusividade para este giveaway.
     * `mutator` recebe o giveaway atual e devolve o que deve ser alterado (objeto parcial),
     * ou null/undefined para não alterar nada. Retorna o giveaway atualizado ou null (nada mudou).
     * Dentro do mutator NÃO chame save/update/mutate/delete (travaria a si mesmo).
     */
    mutate: async (id, mutator) => withGiveawayLock(id, async () => {
        const current = await Giveaways.get(id);
        if (!current) return null;
        const patch = await mutator(current);
        if (!patch) return null;
        return persistGiveaway({ ...current, ...patch, id: current.id });
    }),
    update: async (id, patch) => Giveaways.mutate(id, () => patch),
    delete: async (id) => withGiveawayLock(id, () => giveawaysTable.delete(id)),
    getTemplates: async (guildId) => {
        const server = await Server.get(guildId);
        return server?.giveawayTemplates ?? {};
    },
    saveTemplate: async (guildId, name, template) => {
        if (!name || !template || typeof template !== 'object') {
            throw new Error('Nome e template válidos são obrigatórios.');
        }
        const server = await Server.get(guildId);
        if (!server) return null;
        const templates = { ...(server.giveawayTemplates ?? {}), [name]: template };
        await Server.dbFunctions._update(guildId, { giveawayTemplates: templates });
        return template;
    },
    deleteTemplate: async (guildId, name) => {
        const server = await Server.get(guildId);
        if (!server?.giveawayTemplates || !Object.hasOwn(server.giveawayTemplates, name)) return false;
        const templates = { ...server.giveawayTemplates };
        delete templates[name];
        await Server.dbFunctions._update(guildId, { giveawayTemplates: templates });
        return true;
    },
};

export default {
    dashboardSessionsTable,
    Server,
    GlobalBan,
    GlobalBanHistory,
    Giveaways,
    Leveling,
};