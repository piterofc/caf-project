import { FluxerStrategy } from 'passport-fluxer';
import { client } from '../../index.js';

export default function passport(passport, client) {
    const brain = client.brain;
    const config = brain.config;

    var scopes = ['identify', 'guilds', 'email'];

    passport.use(new FluxerStrategy({
      clientID: config.dashboardConfig.clientId,
      clientSecret: config.dashboardConfig.clientSecret,
      callbackURL: config.dashboardConfig.callbackURL,
      scope: scopes,
    },
    async (accessToken, refreshToken, profile, done) => {
        // done(null, user.data);
        profile.accessToken = accessToken;
        profile.refreshToken = refreshToken;
        done(null, profile);
    }));

    passport.serializeUser((user, done) => {
        done(null, user);
    });

    passport.deserializeUser((user, done) => {
        done(null, user);
    });
}