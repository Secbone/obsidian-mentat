import { exec } from 'child_process';
import * as path from 'path';
import { realpath } from 'fs/promises';
import type { ToolCommandExecutor, ToolOutcome } from '../../contracts/tools';
import { throwIfAborted } from '../../utils/execution';
const blocked = new Set(['sudo', 'rm', 'chmod', 'chown', 'shutdown', 'format', 'dd', 'mkfs', 'init', 'reboot', 'mv', 'poweroff', 'halt']);
/** Trusted host command driver. cwd checks and a blacklist are guardrails, not a sandbox. */
export class NodeCommandExecutor implements ToolCommandExecutor {
    constructor(private root: string) { }
    async execute(input: {
        command: string;
        cwd?: string;
        timeout: number;
    }, signal?: AbortSignal): Promise<ToolOutcome> {
        throwIfAborted(signal);
        const word = input.command.toLowerCase().split(/[\s|;&'"/\\()[\]{}*?~><!^#]+/).find(token => blocked.has(token));
        if (word)
            return { outcome: 'failure', code: 'denied', error: `Command contains blocked high-risk keyword '${word}'` };
        const resolved = path.resolve(this.root, input.cwd || '.'), relative = path.relative(this.root, resolved);
        if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
            return { outcome: 'failure', code: 'denied', error: 'Target working directory is outside the vault root' };
        const actualRoot = await realpath(this.root), actualCwd = await realpath(resolved), actualRelative = path.relative(actualRoot, actualCwd);
        if (actualRelative === '..' || actualRelative.startsWith('..' + path.sep) || path.isAbsolute(actualRelative))
            return { outcome: 'failure', code: 'denied', error: 'Target working directory resolves outside the vault root' };
        const started = Date.now();
        return new Promise(resolve => exec(input.command, { cwd: actualCwd, timeout: Math.min(300000, Math.max(1, input.timeout)), signal, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
            const data = { stdout: String(stdout), stderr: String(stderr), exitCode: error ? (error.code || 1) : 0, executionTime: Date.now() - started };
            resolve(error ? { outcome: 'unknown', error: `Host command did not finish successfully; verify any external effects. ${error.message}`, data } : { outcome: 'success', data });
        }));
    }
}
