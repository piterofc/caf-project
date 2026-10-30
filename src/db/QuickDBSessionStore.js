import session from 'express-session';

export class QuickDBSessionStore extends session.Store {
    constructor(db) {
        super();
        this.db = db;
        this.prefix = 'dashboard:sessions:';
    }

    async get(sid, callback) {
        try {
            const sess = await this.db.get(this.prefix + sid);

            if (!sess) {
                return callback(null, null);
            }

            // Não recupera sessões expiradas
            if (
                sess.cookie?.expires &&
                new Date(sess.cookie.expires).getTime() <= Date.now()
            ) {
                await this.db.delete(this.prefix + sid);
                return callback(null, null);
            }

            callback(null, sess);
        } catch (error) {
            callback(error);
        }
    }

    async set(sid, sess, callback) {
        try {
            await this.db.set(this.prefix + sid, sess);
            callback?.(null);
        } catch (error) {
            callback?.(error);
        }
    }

    async destroy(sid, callback) {
        try {
            await this.db.delete(this.prefix + sid);
            callback?.(null);
        } catch (error) {
            callback?.(error);
        }
    }

    async touch(sid, sess, callback) {
        try {
            await this.db.set(this.prefix + sid, sess);
            callback?.(null);
        } catch (error) {
            callback?.(error);
        }
    }
}

export default QuickDBSessionStore;