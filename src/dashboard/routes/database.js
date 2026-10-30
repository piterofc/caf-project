import kleur from 'kleur';
import express from 'express';
import jwt from 'jsonwebtoken';
import axios from 'axios';
import { PermissionsBitField, PermissionFlags } from '@fluxerjs/core';
const router = express.Router();

import { ensureAuthenticated, forwardAuthenticated } from '../auth/authenticated.js';

import { DASHBOARD_PREFIX } from '../../utils/loggerPrefixes.js';

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