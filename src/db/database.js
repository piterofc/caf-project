import { QuickDB } from 'quick.db';

const db = new QuickDB({ filePath: "src/db/database.db" });

// Tabelas
const serversTable = db.table('servers');
const globalBansTable = db.table('globalBans');
const globalBanHistoryTable = db.table('globalBanHistory');
export const dashboardSessionsTable = db.table('dashboardSessions');

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

export default {
    dashboardSessionsTable,
    Server,
    GlobalBan,
    GlobalBanHistory,
};