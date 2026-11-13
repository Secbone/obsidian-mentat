import type { MutationIO } from '../../contracts/tools';
import type { MutationDraft } from './mutation-service';
import { assertVaultPath, MutationService } from './mutation-service';
import { fingerprint } from '../../runtime/fingerprint';
function relative(from: string, to: string): string {
    const base = from.split('/').slice(0, -1), target = to.split('/');
    while (base.length && target.length && base[0] === target[0]) {
        base.shift();
        target.shift();
    }
    return [...base.map(() => '..'), ...target].join('/') || '.';
}
/** Resolve actual links before rewriting; literals in code blocks and inline code are preserved. */
function rewrite(content: string, source: string, from: string, to: string, io: MutationIO, warnings: Set<string>): string {
    const moved = source === from;
    const destination = (raw: string, markdown: boolean): string => {
        const split = raw.indexOf('#'), path = split < 0 ? raw : raw.slice(0, split), fragment = split < 0 ? '' : raw.slice(split);
        if (!path || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(path))
            return raw;
        let decoded = path;
        try {
            decoded = decodeURIComponent(path);
        }
        catch { /* unresolved paths remain unchanged */ }
        const resolved = io.resolveLink(decoded, source);
        if (!resolved) {
            if (moved || decoded === from || decoded.endsWith('/' + from.split('/').pop()) || decoded === from.split('/').pop()?.replace(/\.md$/, ''))
                warnings.add(`未能解析 ${source} 中的引用 ${raw}，已保留原文`);
            return raw;
        }
        const target = resolved === from ? to : resolved;
        if (resolved !== from && !moved)
            return raw;
        const updated = markdown ? relative(moved ? to : source, target) : target;
        return (markdown ? encodeURI(updated).replace(/#/g, '%23') : updated) + fragment;
    };
    let fence: string | undefined;
    return content.split(/(?<=\n)/).map(line => {
        const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
        if (marker) {
            if (!fence)
                fence = marker[1];
            else if (marker[1][0] === fence[0] && marker[1].length >= fence.length)
                fence = undefined;
            return line;
        }
        if (fence)
            return line;
        return line.split(/(`+[^\n]*?`+)/g).map((part, index) => {
            if (index % 2)
                return part;
            return part.replace(/(!?\[\[)([^\]\n]+)(\]\])/g, (_match, open: string, target: string, close: string) => {
                const pipe = target.indexOf('|'), link = pipe < 0 ? target : target.slice(0, pipe), alias = pipe < 0 ? '' : target.slice(pipe);
                return open + destination(link, false) + alias + close;
            }).replace(/(!?\[[^\]\n]*\]\()(<[^>\n]+>|[^\s)]+)([^)\n]*\))/g, (_match, open: string, target: string, tail: string) => {
                const angle = target.startsWith('<'), raw = angle ? target.slice(1, -1) : target, updated = destination(raw, true);
                return open + (angle ? `<${updated}>` : updated) + tail;
            }).replace(/^( {0,3}\[[^\]]+\]:\s*)(<[^>\n]+>|\S+)/, (_match, open: string, target: string) => {
                const angle = target.startsWith('<'), updated = destination(angle ? target.slice(1, -1) : target, true);
                return open + (angle ? `<${updated}>` : updated);
            });
        }).join('');
    }).join('');
}
export async function buildMovePlan(service: MutationService, from: string, to: string): Promise<MutationDraft> {
    assertVaultPath(from);
    assertVaultPath(to);
    if (from === to)
        throw new Error('Source and destination paths are the same.');
    const previous = await service.io.read(from);
    if (previous === null)
        throw new Error(`File does not exist: ${from}`);
    if (await service.io.exists(to))
        throw new Error(`Destination already exists: ${to}. Choose a different path.`);
    const warnings = new Set<string>(), changes = [];
    const movedContent = /\.md$/i.test(from) ? rewrite(previous, from, from, to, service.io, warnings) : previous;
    changes.push({ kind: 'move' as const, path: from, to, beforeHash: await fingerprint(previous), afterHash: await fingerprint(movedContent), ...(movedContent !== previous ? { content: movedContent } : {}) });
    for (const path of await service.io.listMarkdown()) {
        if (path === from)
            continue;
        const content = await service.io.read(path);
        if (content === null)
            continue;
        const updated = rewrite(content, path, from, to, service.io, warnings);
        if (updated !== content)
            changes.push(await service.writeChange(path, updated, content));
    }
    return { changes, warnings: [...warnings], summary: `移动 ${from} → ${to}；更新 ${changes.length - 1} 个已解析引用文件（只修改明确列出的目标）` };
}
