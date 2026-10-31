// Obter o commit em que o bot está rodando
import { execSync } from 'child_process';

export var commitHash = null;
export var commitHashShort = null;
export var commitDate = null;
export var branchName = null;

export function getCommitHash() {
    try {
        commitHash = execSync('git rev-parse HEAD').toString().trim();
        return commitHash;
    } catch (error) {
        console.error('Erro ao obter o commit atual:', error);
        return null;
    }
}

export function getCommitHashShort() {
    try {
        commitHashShort = execSync('git rev-parse --short HEAD').toString().trim();
        return commitHashShort;
    } catch (error) {
        console.error('Erro ao obter o commit atual (curto):', error);
        return null;
    }
}

export function getCommitDate() {
    try {
        commitDate = execSync('git log -1 --format=%cd').toString().trim();
        return commitDate;
    } catch (error) {
        console.error('Erro ao obter a data do commit atual:', error);
        return null;
    }
}

// Get branch name
export function getBranchName() {
    try {
        branchName = execSync('git rev-parse --abbrev-ref HEAD').toString().trim();
        return branchName;
    } catch (error) {
        console.error('Erro ao obter o nome da branch atual:', error);
        return null;
    }
}

export default {
    getCommitHash,
    getCommitHashShort,
    getCommitDate,
    getBranchName,
    commitHash,
    commitHashShort,
    commitDate,
    branchName
};