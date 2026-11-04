import { PermissionFlags, PermissionsBitField } from '@fluxerjs/core';
import express from 'express';
import axios from 'axios';
const router = express.Router();

import { ensureAuthenticated, forwardAuthenticated } from '../auth/authenticated.js';
import { shortId } from '../../services/giveawayService.js';
import { DASHBOARD_PREFIX } from '../../utils/loggerPrefixes.js';

async function verificarAcessoGiveaway(client, req, guildId) {
    const response = await axios.get('https://api.fluxer.app/users/@me/guilds', {
        headers: { Authorization: `Bearer ${req.user?.accessToken}` },
    }).catch(() => ({ data: [] }));
    const guild = response.data.find((item) => item.id === guildId);
    if (!guild || !new PermissionsBitField(guild.permissions).has(PermissionFlags.Administrator)) {
        const error = new Error('Você não tem acesso à configuração desse servidor!');
        error.statusCode = 403;
        throw error;
    }

    const botGuild = client.guilds.cache.get(guildId);
    const guildConfig = await client.brain.database.Server.get(guildId);
    if (!botGuild || !guildConfig?.cadastroCompleto) {
        const error = new Error('Servidor não configurado ou bot ausente!');
        error.statusCode = 404;
        throw error;
    }

    return { guild, botGuild, guildConfig };
}

export default (client) => {
    const { Server } = client.brain.database;

    // Dashboard - seleção de servidores
    router.get('/', ensureAuthenticated, async (req, res) => {
        try {
            const user = req.user;

            // Obter a lista de servidores Fluxer do usuário usando o token de acesso
            const guildsResponse = await axios.get(`https://api.fluxer.app/users/@me/guilds`, {
                headers: {
                    Authorization: `Bearer ${user.accessToken}`
                }
            }).catch(() => ({ data: [] }));

            const userGuilds = guildsResponse.data;

            // Filtrar servidores onde o usuário tem permissão de admin e que o bot está presente
            const manageableGuilds = (
                await Promise.all(
                    userGuilds.map(async (guild) => {
                        const guildData = await Server.get(guild.id);

                        return (
                            // Verifica se o bot está presente no servidor
                            client.guilds.cache.has(guild.id) &&
                            // Verifica se o usuário tem permissão de admin no servidor
                            new PermissionsBitField(guild.permissions)
                                .has(PermissionFlags.Administrator) &&
                            // Verifica se o cadastro do servidor está completo no banco de dados
                            guildData && 
                            guildData.cadastroCompleto === true
                        ) ? guild : null;
                    })
                )
            ).filter(Boolean);

            res.render('dashboard/servers', { 
                // user: req.user,
                guilds: manageableGuilds
            });
        } catch (error) {
            console.error(DASHBOARD_PREFIX, 'Erro ao obter servidores do usuário:', error);
            res.status(500).send('Erro ao obter servidores do usuário');
        }
    });


    // Dashboard - servidor específico
    router.get('/:guildId', ensureAuthenticated, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const user = req.user;

            // Verifica se o usuário tem permissão no servidor específico
            const guildsResponse = await axios.get('https://api.fluxer.app/users/@me/guilds', {
                headers: {
                    Authorization: `Bearer ${user.accessToken}`
                }
            }).catch(() => ({ data: [] }));

            const temPerm = guildsResponse.data.some((g) => 
                g.id == guildId && (new PermissionsBitField(g.permissions).has(PermissionFlags.Administrator))
            );

            if (!temPerm) {
                return res.status(403).render('error', { 
                    error: { message: 'Você não tem acesso à configuração desse servidor!' },
                    // user: req.user
                });
            }

            // Verifica se o bot está presente no servidor
            const botGuild = client.guilds.cache.get(guildId);
            if (!botGuild) {
                return res.status(404).render('error', { 
                    error: { message: 'O bot não está presente nesse servidor!' },
                    // user: req.user
                });
            }

            // Obter configuração do servidor do banco de dados
            let guildData = await Server.get(guildId);
            if (!guildData || Object.keys(guildData).length === 0) {
                return res.status(404).render('error', { 
                    error: { message: 'Servidor não configurado!' },
                    // user: req.user
                });
            }

            // Verificar se o servidor tem o cadastro completo
            if (!guildData.cadastroCompleto) {
                return res.status(403).render('error', { 
                    error: { message: 'Servidor em processo de cadastro. Volte quando o cadastro estiver completo!' },
                    // user: req.user
                });
            }

            res.render('dashboard/guild', { 
                // user: req.user,
                guild: guildsResponse.data.find(g => g.id === guildId),
                guildConfig: guildData
            });
        } catch (error) {
            res.status(500).render('error', { error, user: req.user });
        }
    });


    // Dashboard - moderação
    router.get('/:guildId/moderation', ensureAuthenticated, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const user = req.user;

            // Verifica se o usuário tem permissão no servidor específico
            const guildsResponse = await axios.get('https://api.fluxer.app/users/@me/guilds', {
                headers: {
                    Authorization: `Bearer ${user.accessToken}`
                }
            }).catch(() => ({ data: [] }));

            const temPerm = guildsResponse.data.some((g) => 
                g.id == guildId && (new PermissionsBitField(g.permissions).has(PermissionFlags.Administrator))
            );

            if (!temPerm) {
                return res.status(403).render('error', { 
                    error: { message: 'Você não tem acesso à configuração desse servidor!' },
                    // user: req.user
                });
            }

            // Verifica se o bot está presente no servidor
            const botGuild = client.guilds.cache.get(guildId);
            if (!botGuild) {
                return res.status(404).render('error', { 
                    error: { message: 'O bot não está presente nesse servidor!' },
                    // user: req.user
                });
            }

            // Obter configuração do servidor do banco de dados
            let guildData = await Server.get(guildId);
            if (!guildData || Object.keys(guildData).length === 0) {
                return res.status(404).render('error', { 
                    error: { message: 'Servidor não configurado!' },
                    // user: req.user
                });
            }

            // Verificar se o servidor tem o cadastro completo
            if (!guildData.cadastroCompleto) {
                return res.status(403).render('error', {
                    error: { message: 'Servidor em processo de cadastro. Volte quando o cadastro estiver completo!' },
                    // user: req.user
                });
            }

            res.render('dashboard/moderation', {
                // user: req.user,
                guild: guildsResponse.data.find(g => g.id === guildId),
                guildConfig: guildData
            });
        } catch (error) {
            res.status(500).render('error', { error, user: req.user });
        }
    });

    // Dashboard - giveaways (criar/editar/encerrar/cancelar/sortear usam a API em /api/db/servers/:id/giveaways)
    router.get('/:guildId/giveaways', ensureAuthenticated, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const { guild: userGuild, botGuild, guildConfig: guildData } =
                await verificarAcessoGiveaway(client, req, guildId);

            const allGiveaways = (await client.brain.database.Giveaways.list(guildId))
                .sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0));

            const channels = [...botGuild.channels.cache.values()]
                .filter((channel) => channel.name && (typeof channel.isTextBased === 'function' ? channel.isTextBased() : typeof channel.send === 'function'))
                .map((channel) => ({ id: channel.id, name: channel.name }));
            const roles = [...(botGuild.roles?.cache?.values() ?? [])]
                .filter((role) => role.id !== guildId && role.name)
                .map((role) => ({ id: role.id, name: role.name }));

            const nomeDoUsuario = (id) => client.users.cache.get(id)?.username || id;
            const nomeDoCargo = (id) => roles.find((role) => role.id === id)?.name || id;

            const pageSize = 5;
            const totalPages = Math.max(1, Math.ceil(allGiveaways.length / pageSize));
            const requestedPage = Number.parseInt(req.query.page, 10);
            const page = Number.isInteger(requestedPage)
                ? Math.min(Math.max(requestedPage, 1), totalPages)
                : 1;

            const giveaways = allGiveaways.slice((page - 1) * pageSize, page * pageSize)
                .map((giveaway) => ({
                    id: giveaway.id,
                    shortId: shortId(giveaway.id),
                    title: giveaway.title,
                    prize: giveaway.prize,
                    description: giveaway.description,
                    status: giveaway.status,
                    winners: giveaway.winners,
                    channelId: giveaway.channelId,
                    roleId: giveaway.roleId,
                    hostId: giveaway.hostId,
                    startAt: giveaway.startAt,
                    endAt: giveaway.endAt,
                    entrantCount: Array.isArray(giveaway.entrants) ? giveaway.entrants.length : (giveaway.entrantCount ?? 0),
                    channelName: botGuild.channels.cache.get(giveaway.channelId)?.name || 'canal indisponível',
                    roleName: giveaway.roleId ? nomeDoCargo(giveaway.roleId) : null,
                    hostName: giveaway.hostId ? nomeDoUsuario(giveaway.hostId) : null,
                    winnerNames: (giveaway.winnerIds ?? []).map(nomeDoUsuario),
                    lastError: giveaway.lastError || null,
                }));

            return res.render('dashboard/giveaways', {
                guild: userGuild,
                guildConfig: guildData,
                giveaways,
                channels,
                roles,
                page,
                totalPages,
            });
        } catch (error) {
            console.error(DASHBOARD_PREFIX, 'Erro ao obter giveaways:', error);
            return res.status(error.statusCode || 500).render('error', { error, user: req.user });
        }
    });

    return router;
}