export function ensureAuthenticated(req, res, next) {
    if (req.isAuthenticated()) {
        return next();
    }

    const returnTo = req.originalUrl;
    console.log('Usuário não autenticado. Salvando URL para redirecionamento após login:', returnTo);
    req.session.returnTo = returnTo;

    req.session.save((err) => {
        if (err) {
            return next(err);
        }

        return res.redirect('/login');
    });
}

export function forwardAuthenticated(req, res, next) {
    if (!req.isAuthenticated()) {
        return next();
    }
    res.redirect('/');
}

export default {
    ensureAuthenticated,
    forwardAuthenticated
};