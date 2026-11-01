import { PermissionFlags, PermissionsBitField } from '@fluxerjs/core';
import express from 'express';
import axios from 'axios';
const router = express.Router();

import { ensureAuthenticated, forwardAuthenticated } from '../auth/authenticated.js';

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
            console.error('Erro ao obter servidores do usuário:', error);
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

    return router;
}