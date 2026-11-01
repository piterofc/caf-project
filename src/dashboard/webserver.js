import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import session from 'express-session';
import passport from 'passport';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { slowDown } from 'express-slow-down';
import axios from 'axios';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import flash from 'connect-flash';

import myPassport from './auth/passport.js';
import QuickDBSessionStore from '../db/QuickDBSessionStore.js';

import { ensureAuthenticated, forwardAuthenticated } from './auth/authenticated.js';

import dbRoute from './routes/database.js';
import authRoute from './routes/auth.js';
import dashboardRoute from './routes/dashboard.js';

import { commitHash, commitHashShort } from '../utils/gitInfo.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import { DASHBOARD_PREFIX } from '../utils/loggerPrefixes.js';

function slowDownHeaders(req, res, next) {
  const { delay, used, remaining, limit } = req.slowDown;

  res.setHeader('X-Throttle-Delay', delay);
  res.setHeader('X-Throttle-Used', used);
  res.setHeader('X-Throttle-Remaining', remaining);
  res.setHeader('X-Throttle-Limit', limit);
  res.setHeader('X-Throttle-Reset', Math.ceil(req.slowDown.resetTime / 1000));

  next();
}

export class WebServer {
    client;
    brain;
    app;

    PORT = process.env.DASHBOARD_PORT || 8080;
    HOST = process.env.DASHBOARD_HOST || "0.0.0.0";

    constructor(client) {
        this.client = client;
        this.brain = this.client.brain;
        this.app = this.setServer();
    }

    setServer() {
        const app = express();

        // Middlewares
        app.use(helmet({
            contentSecurityPolicy: false
        }));
        app.use(cors({
            // Configurações de CORS
            allowedHeaders: ['Content-Type', 'Authorization'],
            credentials: true,
            exposedHeaders: [
              'X-Throttle-Delay',
              'X-Throttle-Used',
              'X-Throttle-Remaining',
              'X-Throttle-Limit',
              'X-Throttle-Reset',
            ]
        }));
        app.use(express.json());
        app.use(express.urlencoded({ extended: true, limit: '5mb' }));
        app.use(cookieParser());

        // Slow Down para reduzir a velocidade de requisições excessivas
        const speedLimiter = slowDown({
            windowMs: 60 * 1000, // 1 minuto
            delayAfter: 10, // Começa a atrasar após 10 requisições
            delayMs: (used) => (used - 5) * 500,
            maxDelayMs: 3000,
        });
        app.use('/api', speedLimiter);
        app.use('/api', slowDownHeaders); // Adiciona os headers de atraso

        // Rate Limiter na API para evitar abuso
        const limiter = rateLimit({
            windowMs: 60 * 1000, // 1 minuto
            max: 30, // Limite de 30 requisições por IP
            message: 'Muitas requisições feitas a partir deste IP, por favor tente novamente mais tarde.',
        });
        app.use('/api', limiter);

        // Mensagens flash
        app.use(flash());

        // Session
        app.use(session({
            name: 'caf.session',
            secret: this.brain.config.dashboardConfig.sessionSecret,

            store: new QuickDBSessionStore(
                this.brain.database.dashboardSessionsTable // Ajuste para a propriedade real do seu QuickDB
            ),

            resave: false,
            saveUninitialized: false,
            cookie: {
                maxAge: 7 * 24 * 60 * 60 * 1000, // 7 dias
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                sameSite: 'lax'
            }

        }));

        // Passport
        app.use(passport.initialize());
        app.use(passport.session());
        myPassport(passport, this.client);

        // Variáveis globais para as views
        app.use(function(req, res, next) {
            res.locals.success = req.flash('success');
            res.locals.error = req.flash('error');
            res.locals.user = req.user || null;
            res.locals.commit = {
                hash: commitHash || 'Desconhecido',
                hashShort: commitHashShort || 'Desconhecido'
            };
            next();
        });

        // Engine de views - arquivos EJS em ./views
        app.set('view engine', 'ejs');
        app.set('views', path.join(__dirname, 'views'));

        // Arquivos estáticos em ./public
        app.use(express.static(path.join(__dirname, 'public'),
          {
            maxAge: '1h',
            etag: true,
            lastModified: true
          }
        ));

        /* Rotas */
        // Rota de autenticação
        try {
            app.use('/auth', authRoute(this.client));
            console.success(DASHBOARD_PREFIX, '✅ Rotas de autenticação registradas');
        } catch (error) {
            console.error(DASHBOARD_PREFIX, '❌ Erro ao registrar rotas de autenticação:', error);
        }
        // Rota da API da database
        try {
            app.use('/api/db', dbRoute(this.client));
            console.success(DASHBOARD_PREFIX, '✅ Rotas da API da database registradas');
        } catch (error) {
            console.error(DASHBOARD_PREFIX, '❌ Erro ao registrar rotas da database:', error);
        }
        // Rota do dashboard
        try {
            app.use('/dashboard', ensureAuthenticated, dashboardRoute(this.client));
            console.success(DASHBOARD_PREFIX, '✅ Rotas do dashboard registradas');
        } catch (error) {
            console.error(DASHBOARD_PREFIX, '❌ Erro ao registrar rotas do dashboard:', error);
        }

        // Página inicial
        app.get('/', (req, res) => {
            res.render('index', { user: req.user });
        });

        // Página de login
        app.get('/login', forwardAuthenticated, (req, res) => {
            res.render('login', {
                user:this.client.user.username,
                avatar:this.client.user.avatarURL(),
                // error: req.flash('error')
            })
        })

        // Verifica se o servidor está com vida
        app.get('/health', (req, res) => {
            res.json({ status: 'ok', uptime: process.uptime() });
        });

        // Informações sobre o usuário logado
        app.get('/me', (req, res) => {
            if (!req.user) {
                return res.status(401).json({ error: 'Não autenticado' });
            }

            res.json({ user: req.user });
        });

        // Handle 404
        app.use((req, res) => {
            res.status(404).render('404');
        });

        // Tratamento de erros
        app.use((err, req, res, next) => {
            console.error(DASHBOARD_PREFIX, err);
            res.status(500).json({ error: 'Internal Server Error' });
        });

        return app;
    }

    async requestFluxerAPI(endpoint, method = 'GET', data = null) {
        const url = `https://api.fluxer.app/${endpoint}`;
        const options = {
            method,
            headers: {
                'Authorization': `Bot ${process.env.TOKEN}`,
                'Content-Type': 'application/json'
            }
        };
        if (data) {
            options.body = JSON.stringify(data);
        }
        return fetch(url, options).then(res => res.json());
    }

    startServer() {
        const porta = this.PORT;
        const host = this.HOST;

        // Inicializa o servidor (passa host explicitamente para garantir binding correto)
        this.app.listen(porta, host, () => {
            console.success(DASHBOARD_PREFIX, `Dashboard rodando em http://${host}:${porta}`);
        });
    }
}

export default WebServer;