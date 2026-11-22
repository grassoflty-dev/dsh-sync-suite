/**
 * 远程访问域的**持久化层**：`remote.json`（用户配置）与 `remote-token.json`（令牌）。
 *
 * 为什么单独两个文件、而不是复用 `engine` 的 `settings.json`：
 *   1. **失败隔离**——远程访问配置写坏/写失败，不许影响配置同步（反之亦然）；
 *   2. 令牌与 Git Token 是两套凭据、两条生命周期，混在一个文件里迟早会互相覆盖；
 *   3. 同步载荷（`devices/<id>/**`）与这两个文件**零交集**，令牌永不进仓库。
 *
 * 只做 I/O，不做语义校验：归一化归 `accessMode.normalizeRemoteSettings`，
 * 这样单测可以分别钉住"落盘原子性"与"字段规则"。
 *
 * 路径解析用 `engine/paths.ts`（纯路径计算，无副作用）——它是本域唯一允许共用的
 * engine 工具之一，规则见 `src/remote/types.ts` 文件头。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { statePaths } from '../engine/paths.js';
function ensureDir(dir) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
}
/**
 * 原子写 + 0600。
 *
 * 与 `engine/settings.ts` 的 `writeFilePrivate` 同款：先写 tmp 再 rename，rename 失败退回直写。
 * Windows 上 POSIX mode 不生效，但同一份代码在 Linux/macOS 上是真正收紧的。
 */
function writeFilePrivate(file, content) {
    ensureDir(path.dirname(file));
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 });
    try {
        renameSync(tmp, file);
    }
    catch {
        writeFileSync(file, content, { encoding: 'utf8', mode: 0o600 });
        try {
            unlinkSync(tmp);
        }
        catch {
            /* 临时文件清理失败不影响结果 */
        }
    }
}
function readJson(file) {
    if (!existsSync(file))
        return null;
    try {
        return JSON.parse(readFileSync(file, 'utf8'));
    }
    catch {
        // 手工改坏 / 半截文件：当作"没配置"，由上层回落默认值（不能让插件起不来）。
        return null;
    }
}
function asRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}
export class RemoteStore {
    /** `~/.dsh/dots/remote.json` */
    configFile;
    /** `~/.dsh/dots/remote-token.json` */
    tokenFile;
    /** `~/.dsh/dots/remote-pairing-cert.json`（mod-plugin-pairing：自签证书 + 私钥，0600） */
    certFile;
    /** `~/.dsh/dots/remote-pairing-state.json`（公告已发布端口，0600） */
    pairingStateFile;
    constructor(options = {}) {
        const root = statePaths(options.homeDir).root;
        this.configFile = path.join(root, 'remote.json');
        this.tokenFile = path.join(root, 'remote-token.json');
        this.certFile = path.join(root, 'remote-pairing-cert.json');
        this.pairingStateFile = path.join(root, 'remote-pairing-state.json');
    }
    /** 原始配置（未归一）；文件缺失或损坏 → null（调用方回落默认值）。 */
    readRawSettings() {
        return readJson(this.configFile);
    }
    writeSettings(settings) {
        writeFilePrivate(this.configFile, JSON.stringify(settings, null, 2) + '\n');
    }
    /** 读令牌；文件缺失/损坏/字段非法 → null（fail-closed：没有令牌就没人能通过令牌门）。 */
    readToken() {
        const record = asRecord(readJson(this.tokenFile));
        if (record === null)
            return null;
        const token = record.token;
        if (typeof token !== 'string')
            return null;
        const trimmed = token.trim();
        // 长度下限与 `crypto.randomBytes(32)` 的 base64url 形态对得上；更短的视为损坏数据。
        if (trimmed.length < 32)
            return null;
        const createdAt = typeof record.createdAt === 'string' ? record.createdAt : '';
        return { token: trimmed, createdAt };
    }
    writeToken(record) {
        writeFilePrivate(this.tokenFile, JSON.stringify({ token: record.token, createdAt: record.createdAt }, null, 2) + '\n');
    }
    /** 删除令牌文件（轮换时先写新值，不调用本方法；本方法只给"清空令牌"用）。 */
    clearToken() {
        try {
            if (existsSync(this.tokenFile))
                unlinkSync(this.tokenFile);
        }
        catch {
            /* 删除失败不应抛给调用方；下次读取会因为字段缺失返回 null */
        }
    }
    /**
     * 读取配对证书；文件缺失 / 损坏 / 指纹字段非法 → null（由 provisioning 自动生成）。
     * 私钥只在这个对象里流转，绝不进 RPC 状态视图。
     */
    readCert() {
        const record = asRecord(readJson(this.certFile));
        if (record === null)
            return null;
        const { certPem, keyPem, fingerprint, createdAt } = record;
        if (typeof certPem !== 'string' || typeof keyPem !== 'string' ||
            typeof fingerprint !== 'string' || !/^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/.test(fingerprint))
            return null;
        if (typeof createdAt !== 'string' || createdAt === '')
            return null;
        return { certPem, keyPem, fingerprint, createdAt };
    }
    /** 原子写 + 0600；字段顺序固定，便于字节级幂等核对。 */
    writeCert(record) {
        writeFilePrivate(this.certFile, JSON.stringify({
            certPem: record.certPem,
            keyPem: record.keyPem,
            fingerprint: record.fingerprint,
            createdAt: record.createdAt,
        }, null, 2) + '\n');
    }
    clearCert() {
        try {
            if (existsSync(this.certFile))
                unlinkSync(this.certFile);
        }
        catch {
            /* 同 clearToken：删除失败不改变调用方语义 */
        }
    }
    /** 读"公告已发布端口"；缺失 / 坏字节 → null（视为从未发布，下次 run 必须重发）。 */
    readPairingAnnouncement() {
        const record = asRecord(readJson(this.pairingStateFile));
        if (record === null || record.v !== 1)
            return null;
        const announcedPort = record.announcedPort;
        if (announcedPort !== null && (typeof announcedPort !== 'number' || !Number.isInteger(announcedPort) ||
            announcedPort < 1 || announcedPort > 65535))
            return null;
        if (typeof record.announceRef !== 'string' || typeof record.key !== 'string')
            return null;
        return { v: 1, announcedPort, announceRef: record.announceRef, key: record.key };
    }
    /** 仅在 re-publish 钩子成功后写；原子 + 0600。 */
    writePairingAnnouncement(state) {
        writeFilePrivate(this.pairingStateFile, JSON.stringify({
            v: 1,
            announcedPort: state.announcedPort,
            announceRef: state.announceRef,
            key: state.key,
        }, null, 2) + '\n');
    }
    /**
     * 清掉"已公告"标记（接线 TODO 7a）：没有真正接上公告钩子时，标记绝不能宣称已发布。
     * 写成 `announcedPort: null` 而不是删文件——read 端把它等同"从未发布"，下次 run 强制重发。
     */
    clearPairingAnnouncement() {
        writeFilePrivate(this.pairingStateFile, JSON.stringify({
            v: 1,
            announcedPort: null,
            announceRef: '',
            key: '',
        }, null, 2) + '\n');
    }
}
