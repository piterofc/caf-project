import express from 'express';
import passport from 'passport';
const router = express.Router();

import { ensureAuthenticated, forwardAuthenticated } from '../auth/authenticated.js';

export default (client) => {
    router.get('/', (req, res) => {
        res.redirect('/login');
    })

    router.get('/fluxer', passport.authenticate('fluxer'));

    router.get('/fluxer/callback',(req, res, next)=>{
        /*
        passport.authenticate('fluxer', {
            successRedirect: '/',
            failureRedirect: '/login',
            failureFlash: true
        })(req, res, next);
        */
       passport.authenticate('fluxer', (err, user, info) => {
            if (err) {
                console.error('Erro na autenticação:', err);
                return next(err);
            }

            if (!user) {
                console.warn('Falha na autenticação:', info);
                req.flash('error', 'Falha na autenticação. Por favor, tente novamente.');
                return res.redirect('/login');
            }

            // Capture o destino ANTES de req.logIn().
            const returnTo = req.session?.returnTo;
            delete req.session.returnTo;

            req.logIn(user, (err) => {
                if (err) {
                    console.error('Erro ao fazer login do usuário:', err);
                    return next(err);
                }

                // Aceita somente caminhos locais para evitar open redirects.
                const redirectTo =
                    typeof returnTo === 'string' &&
                    returnTo.startsWith('/') &&
                    !returnTo.startsWith('//') &&
                    !returnTo.startsWith('/\\')
                        ? returnTo
                        : '/';

                return res.redirect(redirectTo);
            });
        })(req, res, next);
    })

    router.get('/logout', (req, res) => {
        req.logout(() => {
            res.redirect('/');
        });
    });

    return router;
}