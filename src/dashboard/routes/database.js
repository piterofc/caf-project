import express from 'express';
import axios from 'axios';
import { PermissionsBitField, PermissionFlags } from '@fluxerjs/core';
const router = express.Router();

import { ensureAuthenticated, forwardAuthenticated } from '../auth/authenticated.js';

import { DASHBOARD_PREFIX } from '../../utils/loggerPrefixes.js';
import {
    GiveawayError,
    cancelGiveaway,
    createGiveaway,
    editGiveaway,
    endGiveaway,
    findGiveaway,
    rerollGiveaway,
} from '../../services/giveawayService.js';
import { getMembersPage } from '../../services/levelingService.js';

async function verificarAdministrador(req, serverId) {
    const guildsResponse = await axios.get('https://api.fluxer.app/users/@me/guilds', {
        headers: { Authorization: `Bearer ${req.user?.accessToken}` }
    }).catch(() => ({ data: [] }));
    return guildsResponse.data.some((guild) =>
        guild.id == serverId && new PermissionsBitField(guild.permissions).has(PermissionFlags.Administrator)
    );
}

export default (client) => {
    // Servers
    router.get('/servers', async (req, res) => {
        try {
            const servers = await client.brain.database.Server.getAll();
            res.json(servers);
        } catch (error) {
            console.error(DASHBOARD_PREFIX, 'Erro ao acessar o banco de dados:', error);
            res.status(500).json({ error: 'Erro ao acessar o banco de dados' });
        }
    });

    router.get('/servers/:id', async (req, res) => {
        const serverId = req.params.id;
        try {
            const server = await client.brain.database.Server.get(serverId);
            if (!server || Object.keys(server).length === 0) {
                res.status(404).json({ error: 'Servidor não encontrado' });
            } else {
                res.json(server);
            }
        } catch (error) {
            console.error(DASHBOARD_PREFIX, 'Erro ao acessar o banco de dados:', error);
            res.status(500).json({ error: 'Erro ao acessar o banco de dados' });
        }
    });

    // Obter prefixo do servidor
    router.get('/servers/:id/prefix', async (req, res) => {
        const serverId = req.params.id;
        try {
            const prefix = await client.brain.database.Server.getPrefix(serverId);
            res.json({ prefix });
        } catch (error) {
            console.error(DASHBOARD_PREFIX, 'Erro ao acessar o banco de dados:', error);
            res.status(500).json({ error: 'Erro ao acessar o banco de dados' });
        }
    });

    // Alterar prefixo do servidor
    router.post('/servers/:id/prefix', ensureAuthenticated, async (req, res) => {
        const serverId = req.params.id;
        const user = req.user;

        // Verifica se o usuário tem permissão no servidor específico
        const guildsResponse = await axios.get('https://api.fluxer.app/users/@me/guilds', {
            headers: {
                Authorization: `Bearer ${user.accessToken}`
            }
        }).catch(() => ({ data: [] }));
        const temPerm = guildsResponse.data.some((g) =>
            g.id == serverId && (new PermissionsBitField(g.permissions).has(PermissionFlags.Administrator))
        );

        if (!temPerm) {
            return res.status(403).json({ error: 'Você não tem permissão para alterar o prefixo deste servidor!' });
        }

        const { prefix } = req.body;

        try {
            const response = await client.brain.database.Server.setPrefix(serverId, prefix);
            res.json(response);
        } catch (error) {
            console.error(DASHBOARD_PREFIX, 'Erro ao acessar o banco de dados:', error);
            res.status(500).json({ error: 'Erro ao acessar o banco de dados' });
        }
    });

    // Alterar banSync do servidor
    router.post('/servers/:id/bansync', ensureAuthenticated, async (req, res) => {
        const serverId = req.params.id;
        const user = req.user;

        // Verifica se o usuário tem permissão no servidor específico
        const guildsResponse = await axios.get('https://api.fluxer.app/users/@me/guilds', {
            headers: {
                Authorization: `Bearer ${user.accessToken}`
            }
        }).catch(() => ({ data: [] }));
        const temPerm = guildsResponse.data.some((g) =>
            g.id == serverId && (new PermissionsBitField(g.permissions).has(PermissionFlags.Administrator))
        );

        if (!temPerm) {
            return res.status(403).json({ error: 'Você não tem permissão para alterar o banSync deste servidor!' });
        }

        const { banSync } = req.body;

        try {
            const response = await client.brain.database.Server.setBanSync(serverId, banSync);
            res.json(response);
        } catch (error) {
            console.error(DASHBOARD_PREFIX, 'Erro ao acessar o banco de dados:', error);
            res.status(500).json({ error: 'Erro ao acessar o banco de dados' });
        }
    });

    // Níveis
    router.post('/servers/:id/leveling', ensureAuthenticated, async (req, res) => {
        const serverId = req.params.id;
        const user = req.user;
        const guildsResponse = await axios.get('https://api.fluxer.app/users/@me/guilds', {
            headers: { Authorization: `Bearer ${user.accessToken}` }
        }).catch(() => ({ data: [] }));
        const temPerm = guildsResponse.data.some((g) =>
            g.id == serverId && new PermissionsBitField(g.permissions).has(PermissionFlags.Administrator)
        );

        if (!temPerm) return res.status(403).json({ error: 'Você não tem permissão para alterar os níveis deste servidor!' });

        try {
            const body = req.body ?? {};
            const response = await client.brain.database.Server.setLevelingConfig(serverId, {
                enabled: body.enabled,
                xpMin: Number(body.xpMin),
                xpMax: Number(body.xpMax),
                cooldownSeconds: Number(body.cooldownSeconds),
                xpPerLevel: Number(body.xpPerLevel),
                announce: body.announce,
                levelUpMessage: body.levelUpMessage,
                levelUpChannelId: body.levelUpChannelId || null,
                removePreviousRoles: body.removePreviousRoles,
                levelRoles: Array.isArray(body.levelRoles) ? body.levelRoles.map((item) => ({ level: Number(item.level), roleId: String(item.roleId) })) : [],
                roleBoosts: Array.isArray(body.roleBoosts) ? body.roleBoosts.map((item) => ({ roleId: String(item.roleId), multiplier: Number(item.multiplier) })) : [],
            });
            return res.json(response);
        } catch (error) {
            console.error(DASHBOARD_PREFIX, 'Erro ao salvar níveis:', error);
            return res.status(400).json({ error: error.message || 'Configuração de níveis inválida.' });
        }
    });

    router.get('/servers/:id/leveling/members', ensureAuthenticated, async (req, res) => {
        const serverId = req.params.id;
        if (!await verificarAdministrador(req, serverId)) return res.status(403).json({ error: 'Você não tem permissão para consultar os níveis deste servidor!' });
        try {
            return res.json(await getMembersPage(client, serverId, req.query.page, 10));
        } catch (error) {
            console.error(DASHBOARD_PREFIX, 'Erro ao listar membros com XP:', error);
            return res.status(500).json({ error: 'Erro ao listar membros com XP.' });
        }
    });

    router.post('/servers/:id/leveling/members/:userId/reset', ensureAuthenticated, async (req, res) => {
        const serverId = req.params.id;
        if (!await verificarAdministrador(req, serverId)) return res.status(403).json({ error: 'Você não tem permissão para resetar os níveis deste servidor!' });
        try {
            await client.brain.database.Leveling.delete(serverId, req.params.userId);
            return res.json({ success: true, message: 'XP do membro resetado com sucesso.' });
        } catch (error) {
            console.error(DASHBOARD_PREFIX, 'Erro ao resetar XP do membro:', error);
            return res.status(500).json({ error: 'Erro ao resetar XP do membro.' });
        }
    });

    router.post('/servers/:id/leveling/reset', ensureAuthenticated, async (req, res) => {
        const serverId = req.params.id;
        if (!await verificarAdministrador(req, serverId)) return res.status(403).json({ error: 'Você não tem permissão para resetar os níveis deste servidor!' });
        try {
            await client.brain.database.Leveling.deleteAll(serverId);
            return res.json({ success: true, message: 'XP de todos os membros foi resetado com sucesso.' });
        } catch (error) {
            console.error(DASHBOARD_PREFIX, 'Erro ao resetar todos os níveis:', error);
            return res.status(500).json({ error: 'Erro ao resetar todos os níveis.' });
        }
    });

    // Moderação - Max bans and confirmation
    router.post('/servers/:id/moderation/ban', ensureAuthenticated, async (req, res) => {
        const serverId = req.params.id;
        const user = req.user;

        // Verifica se o usuário tem permissão no servidor específico
        const guildsResponse = await axios.get('https://api.fluxer.app/users/@me/guilds', {
            headers: {
                Authorization: `Bearer ${user.accessToken}`
            }
        }).catch(() => ({ data: [] }));
        const temPerm = guildsResponse.data.some((g) =>
            g.id == serverId && (new PermissionsBitField(g.permissions).has(PermissionFlags.Administrator))
        );

        if (!temPerm) {
            return res.status(403).json({ error: 'Você não tem permissão para alterar as configurações de moderação deste servidor!' });
        }

        const { maxBansPerCommand, banConfirm } = req.body;

        try {
            const response = await client.brain.database.Server.setModerationBanConfig(serverId, { maxBansPerCommand, banConfirm });
            res.json(response);
        } catch (error) {
            console.error(DASHBOARD_PREFIX, 'Erro ao acessar o banco de dados:', error);
            res.status(500).json({ error: 'Erro ao acessar o banco de dados' });
        }
    });

    // Moderação - Max kicks and confirmation
    router.post('/servers/:id/moderation/kick', ensureAuthenticated, async (req, res) => {
        const serverId = req.params.id;
        const user = req.user;

        // Verifica se o usuário tem permissão no servidor específico
        const guildsResponse = await axios.get('https://api.fluxer.app/users/@me/guilds', {
            headers: {
                Authorization: `Bearer ${user.accessToken}`
            }
        }).catch(() => ({ data: [] }));
        const temPerm = guildsResponse.data.some((g) => 
            g.id == serverId && (new PermissionsBitField(g.permissions).has(PermissionFlags.Administrator))
        );

        if (!temPerm) {
            return res.status(403).json({ error: 'Você não tem permissão para alterar as configurações de moderação deste servidor!' });
        }

        const { maxKicksPerCommand, kickConfirm } = req.body;

        try {
            const response = await client.brain.database.Server.setModerationKickConfig(serverId, { maxKicksPerCommand, kickConfirm });
            res.json(response);
        } catch (error) {
            console.error(DASHBOARD_PREFIX, 'Erro ao acessar o banco de dados:', error);
            res.status(500).json({ error: 'Erro ao acessar o banco de dados' });
        }
    });

    // Moderação - Max mutes, confirmation and mute mode
    router.post('/servers/:id/moderation/mute', ensureAuthenticated, async (req, res) => {
        const serverId = req.params.id;
        const user = req.user;

        // Verifica se o usuário tem permissão no servidor específico
        const guildsResponse = await axios.get('https://api.fluxer.app/users/@me/guilds', {
            headers: {
                Authorization: `Bearer ${user.accessToken}`
            }
        }).catch(() => ({ data: [] }));
        const temPerm = guildsResponse.data.some((g) => 
            g.id == serverId && (new PermissionsBitField(g.permissions).has(PermissionFlags.Administrator))
        );

        if (!temPerm) {
            return res.status(403).json({ error: 'Você não tem permissão para alterar as configurações de moderação deste servidor!' });
        }

        const { maxMutesPerCommand, muteConfirm, muteMode } = req.body;

        try {
            const response = await client.brain.database.Server.setModerationMuteConfig(serverId, { maxMutesPerCommand, muteConfirm, muteMode });
            res.json(response);
        } catch (error) {
            console.error(DASHBOARD_PREFIX, 'Erro ao acessar o banco de dados:', error);
            res.status(500).json({ error: 'Erro ao acessar o banco de dados' });
        }
    });


    // Giveaways - confere se o usuário é admin do servidor e se o bot/servidor estão aptos.
    // Em caso de problema já responde ao cliente e retorna null.
    async function acessoGiveaways(req, res) {
        const serverId = req.params.id;
        const guildsResponse = await axios.get('https://api.fluxer.app/users/@me/guilds', {
            headers: {
                Authorization: `Bearer ${req.user.accessToken}`
            }
        }).catch(() => ({ data: [] }));
        const temPerm = guildsResponse.data.some((g) =>
            g.id == serverId && (new PermissionsBitField(g.permissions).has(PermissionFlags.Administrator))
        );

        if (!temPerm) {
            res.status(403).json({ success: false, error: 'Você não tem permissão para gerenciar os giveaways deste servidor!' });
            return null;
        }

        const guildConfig = await client.brain.database.Server.get(serverId);
        if (!client.guilds.cache.has(serverId) || !guildConfig?.cadastroCompleto) {
            res.status(404).json({ success: false, error: 'Servidor não configurado ou o bot não está nele!' });
            return null;
        }

        return serverId;
    }

    // Giveaways - erros esperados (validação) voltam como 400; o resto é erro interno
    function erroGiveaway(res, error, acao) {
        if (error instanceof GiveawayError) {
            return res.status(400).json({ success: false, error: error.message });
        }
        console.error(DASHBOARD_PREFIX, `Erro ao ${acao} giveaway:`, error);
        return res.status(500).json({ success: false, error: 'Erro interno ao processar o giveaway' });
    }

    // Giveaways - busca o giveaway SOMENTE dentro do servidor informado
    async function giveawayDoServidor(serverId, giveawayId) {
        const giveaway = await findGiveaway(client.brain.database, serverId, giveawayId);
        if (!giveaway) throw new GiveawayError('Giveaway não encontrado neste servidor.');
        return giveaway;
    }

    // Giveaways - criar
    router.post('/servers/:id/giveaways', ensureAuthenticated, async (req, res) => {
        try {
            const serverId = await acessoGiveaways(req, res);
            if (!serverId) return;

            const body = req.body ?? {};
            const giveaway = await createGiveaway(client, client.brain.database, {
                guildId: serverId,
                channelId: body.channelId,
                creatorId: req.user.id,
                title: body.title,
                prize: body.prize,
                description: body.description,
                winners: body.winners,
                roleId: body.roleId,
                hostId: body.hostId || req.user.id,
                startAt: body.startAt,
                endAt: body.endAt,
                duration: body.duration,
            });
            res.json({ success: true, message: 'Giveaway criado com sucesso!', giveaway: { id: giveaway.id, status: giveaway.status } });
        } catch (error) {
            erroGiveaway(res, error, 'criar');
        }
    });

    // Giveaways - editar
    router.post('/servers/:id/giveaways/:giveawayId/edit', ensureAuthenticated, async (req, res) => {
        try {
            const serverId = await acessoGiveaways(req, res);
            if (!serverId) return;

            const giveaway = await giveawayDoServidor(serverId, req.params.giveawayId);
            const body = req.body ?? {};
            const patch = {};
            for (const campo of ['title', 'prize', 'description', 'roleId', 'hostId']) {
                if (body[campo] !== undefined) patch[campo] = body[campo];
            }
            if (body.winners !== undefined && body.winners !== '') patch.winners = body.winners;

            await editGiveaway(client, client.brain.database, giveaway.id, patch);
            res.json({ success: true, message: 'Giveaway atualizado com sucesso!' });
        } catch (error) {
            erroGiveaway(res, error, 'editar');
        }
    });

    // Giveaways - encerrar agora
    router.post('/servers/:id/giveaways/:giveawayId/end', ensureAuthenticated, async (req, res) => {
        try {
            const serverId = await acessoGiveaways(req, res);
            if (!serverId) return;

            const giveaway = await giveawayDoServidor(serverId, req.params.giveawayId);
            const encerrado = await endGiveaway(client, client.brain.database, giveaway.id);
            res.json({ success: true, message: `Giveaway encerrado. Ganhadores: ${encerrado.winnerIds.length}.` });
        } catch (error) {
            erroGiveaway(res, error, 'encerrar');
        }
    });

    // Giveaways - cancelar (agendado ou em andamento)
    router.post('/servers/:id/giveaways/:giveawayId/cancel', ensureAuthenticated, async (req, res) => {
        try {
            const serverId = await acessoGiveaways(req, res);
            if (!serverId) return;

            const giveaway = await giveawayDoServidor(serverId, req.params.giveawayId);
            await cancelGiveaway(client, client.brain.database, giveaway.id);
            res.json({ success: true, message: 'Giveaway cancelado.' });
        } catch (error) {
            erroGiveaway(res, error, 'cancelar');
        }
    });

    // Giveaways - sortear novo(s) ganhador(es)
    router.post('/servers/:id/giveaways/:giveawayId/reroll', ensureAuthenticated, async (req, res) => {
        try {
            const serverId = await acessoGiveaways(req, res);
            if (!serverId) return;

            const giveaway = await giveawayDoServidor(serverId, req.params.giveawayId);
            const ganhadores = await rerollGiveaway(client, client.brain.database, giveaway.id, req.body?.amount ?? 1);
            if (!ganhadores.length) {
                return res.json({ success: false, error: 'Não há novos participantes elegíveis.' });
            }
            res.json({ success: true, message: `${ganhadores.length} novo(s) ganhador(es) sorteado(s)!` });
        } catch (error) {
            erroGiveaway(res, error, 'sortear');
        }
    });


    // GlobalBans
    router.get('/globalbans', async (req, res) => {
        try {
            const globalBans = await client.brain.database.GlobalBan.getAll();
            res.json(globalBans);
        } catch (error) {
            console.error(DASHBOARD_PREFIX, 'Erro ao acessar o banco de dados:', error);
            res.status(500).json({ error: 'Erro ao acessar o banco de dados' });
        }
    });

    router.get('/globalbans/:id', async (req, res) => {
        const userId = req.params.id;
        try {
            const globalBan = await client.brain.database.GlobalBan.get(userId);
            if (!globalBan || Object.keys(globalBan).length === 0) {
                res.status(404).json({ error: 'GlobalBan não encontrado' });
            } else {
                res.json(globalBan);
            }
        } catch (error) {
            console.error(DASHBOARD_PREFIX, 'Erro ao acessar o banco de dados:', error);
            res.status(500).json({ error: 'Erro ao acessar o banco de dados' });
        }
    });

    router.post('/globalbans/:id', async (req, res) => {
        const userId = req.params.id;
        const globalBanData = req.body;

        try {
            const existingData = await client.brain.database.GlobalBan.get(userId);
            if (existingData && Object.keys(existingData).length > 0) {
                // Se o GlobalBan já existe, atualizamos os dados
                const response = await client.brain.database.GlobalBan.dbFunctions._update(userId, globalBanData);
                res.json(response);
            } else {
                // Se o GlobalBan não existe, criamos um novo registro
                const response = await client.brain.database.GlobalBan.dbFunctions._set(userId, globalBanData);
                res.json(response);
            }
        } catch (error) {
            console.error(DASHBOARD_PREFIX, 'Erro ao acessar o banco de dados:', error);
            res.status(500).json({ error: 'Erro ao acessar o banco de dados' });
        }
    });

    router.delete('/globalbans/:id', async (req, res) => {
        const userId = req.params.id;
        try {
            const response = await client.brain.database.GlobalBan.dbFunctions._delete(userId);
            res.json(response);
        } catch (error) {
            console.error(DASHBOARD_PREFIX, 'Erro ao acessar o banco de dados:', error);
            res.status(500).json({ error: 'Erro ao acessar o banco de dados' });
        }
    });


    // GlobalBanHistory
    router.get('/globalbans/history', async (req, res) => {
        try {
            const globalBanHistory = await client.brain.database.GlobalBanHistory.getAll();
            res.json(globalBanHistory);
        } catch (error) {
            console.error(DASHBOARD_PREFIX, 'Erro ao acessar o banco de dados:', error);
            res.status(500).json({ error: 'Erro ao acessar o banco de dados' });
        }
    });

    router.get('/globalbans/history/:id', async (req, res) => {
        const userId = req.params.id;
        try {
            const globalBanHistory = await client.brain.database.GlobalBanHistory.get(userId);
            if (!globalBanHistory || Object.keys(globalBanHistory).length === 0) {
                res.status(404).json({ error: 'GlobalBanHistory não encontrado' });
            } else {
                res.json(globalBanHistory);
            }
        } catch (error) {
            console.error(DASHBOARD_PREFIX, 'Erro ao acessar o banco de dados:', error);
            res.status(500).json({ error: 'Erro ao acessar o banco de dados' });
        }
    });

    return router;
}