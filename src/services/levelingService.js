import { Leveling } from '../db/database.js';

export const DEFAULT_LEVELING_CONFIG = {
    enabled: false,
    xpMin: 15,
    xpMax: 25,
    cooldownSeconds: 60,
    xpPerLevel: 100,
    announce: true,
    levelUpMessage: 'Parabéns, {user}! Você alcançou o nível **{level}**.',
    levelUpChannelId: null,
    removePreviousRoles: true,
    levelRoles: [],
    roleBoosts: [],
};

const cooldowns = new Map();
const updates = new Map();

export function getLevelingConfig(server) {
    return { ...DEFAULT_LEVELING_CONFIG, ...(server?.leveling ?? {}) };
}

export function getRequiredXp(level, config) {
    return Math.max(0, level * config.xpPerLevel);
}

export function getLevelFromXp(xp, config) {
    return Math.floor(Math.max(0, xp) / Math.max(1, config.xpPerLevel));
}

function formatLevelUpMessage(template, message, level, xp) {
    const user = message.author;
    const guild = message.guild;
    const values = {
        user: `<@${user.id}>`,
        userId: user.id,
        username: user.username ?? user.displayName ?? user.id,
        level: String(level),
        xp: String(xp),
        guild: guild?.name ?? message.guildId,
    };
    return template.replace(/\{(user|userId|username|level|xp|guild)\}/g, (_, key) => values[key]);
}

function memberRoleIds(member) {
    if (member?.roles?.roleIds) return [...member.roles.roleIds];
    return [...(member?.roles?.cache?.keys?.() ?? [])];
}

function randomXp(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function aplicarCargoDeNivel(client, message, config, level) {
    const guild = client.guilds.cache.get(message.guildId);
    const member = message.member ?? await guild?.members?.fetch(message.author.id).catch(() => null);
    if (!guild || !member?.roles) return;

    const configuredRoles = config.levelRoles
        .filter((item) => guild.roles.cache.has(item.roleId))
        .sort((left, right) => left.level - right.level);
    const unlockedRoles = configuredRoles.filter((item) => item.level <= level);
    const cargosParaAdicionar = config.removePreviousRoles
        ? unlockedRoles.slice(-1)
        : unlockedRoles;

    if (config.removePreviousRoles) {
        for (const item of configuredRoles) {
            if (!cargosParaAdicionar.some((role) => role.roleId === item.roleId) && member.roles.has(item.roleId)) {
                await member.roles.remove(item.roleId).catch(() => null);
            }
        }
    }
    for (const item of cargosParaAdicionar) {
        if (!member.roles.has(item.roleId)) await member.roles.add(item.roleId).catch(() => null);
    }
}

async function adicionarXp(client, message) {
    if (!message.guildId || !message.author?.id || message.author.bot) return null;
    const server = await client.brain.database.Server.get(message.guildId);
    const config = getLevelingConfig(server);
    if (!config.enabled) return null;

    const cooldownKey = `${message.guildId}:${message.author.id}`;
    const now = Date.now();
    const lastMessage = cooldowns.get(cooldownKey) ?? 0;
    if (now - lastMessage < config.cooldownSeconds * 1000) return null;
    cooldowns.set(cooldownKey, now);

    const member = message.member ?? client.guilds.cache.get(message.guildId)?.members?.get(message.author.id);
    const roleIds = memberRoleIds(member);
    const multiplier = config.roleBoosts
        .filter((boost) => roleIds.includes(boost.roleId))
        .reduce((total, boost) => total * boost.multiplier, 1);
    const gainedXp = Math.round(randomXp(config.xpMin, config.xpMax) * multiplier);
    const key = `${message.guildId}:${message.author.id}`;
    const previousUpdate = updates.get(key) ?? Promise.resolve();
    const update = previousUpdate.then(async () => {
        const profile = await Leveling.get(message.guildId, message.author.id);
        const previousLevel = getLevelFromXp(profile.xp ?? 0, config);
        const xp = (profile.xp ?? 0) + gainedXp;
        const level = getLevelFromXp(xp, config);
        await Leveling.set(message.guildId, message.author.id, { xp, updatedAt: now });
        if (level > previousLevel) {
            await aplicarCargoDeNivel(client, message, config, level);
            const guild = client.guilds.cache.get(message.guildId);
            const channel = config.levelUpChannelId
                ? guild?.channels?.cache?.get(config.levelUpChannelId)
                : message.channel;
            if (config.announce && channel?.send) {
                const content = formatLevelUpMessage(config.levelUpMessage, message, level, xp);
                await channel.send(content).catch(() => null);
            }
        }
        return { xp, level, gainedXp, leveledUp: level > previousLevel };
    }).finally(() => {
        if (updates.get(key) === update) updates.delete(key);
    });
    updates.set(key, update);
    return update;
}

export async function processMessageXp(client, message) {
    try {
        return await adicionarXp(client, message);
    } catch (error) {
        console.error('[LEVELING]', 'Erro ao conceder XP:', error);
        return null;
    }
}

export async function getProfile(client, guildId, userId) {
    const server = await client.brain.database.Server.get(guildId);
    const config = getLevelingConfig(server);
    const profile = await Leveling.get(guildId, userId);
    const level = getLevelFromXp(profile.xp ?? 0, config);
    const levelBaseXp = getRequiredXp(level, config);
    const nextLevelXp = getRequiredXp(level + 1, config);
    return { ...profile, level, xpInLevel: Math.max(0, (profile.xp ?? 0) - levelBaseXp), xpToNextLevel: nextLevelXp - levelBaseXp, nextLevelXp };
}

export async function getLeaderboard(client, guildId, limit = 10) {
    const server = await client.brain.database.Server.get(guildId);
    const config = getLevelingConfig(server);
    const profiles = await Leveling.getAll(guildId);
    return profiles
        .map((profile) => ({ ...profile, level: getLevelFromXp(profile.xp ?? 0, config) }))
        .sort((left, right) => right.xp - left.xp)
        .slice(0, limit);
}

export async function getMembersPage(client, guildId, page = 1, pageSize = 10) {
    const server = await client.brain.database.Server.get(guildId);
    const config = getLevelingConfig(server);
    const profiles = (await Leveling.getAll(guildId))
        .map((profile) => ({ ...profile, level: getLevelFromXp(profile.xp ?? 0, config) }))
        .sort((left, right) => right.xp - left.xp);
    const totalPages = Math.max(1, Math.ceil(profiles.length / pageSize));
    const currentPage = Math.min(Math.max(Number(page) || 1, 1), totalPages);
    const members = await Promise.all(profiles.slice((currentPage - 1) * pageSize, currentPage * pageSize).map(async (profile) => {
        const user = client.users.cache.get(profile.userId) ?? await client.users.fetch(profile.userId).catch(() => null);
        return { ...profile, username: user?.username ?? profile.userId };
    }));
    return { members, page: currentPage, pageSize, total: profiles.length, totalPages };
}
