import { TFile } from 'obsidian';
import type { SkillContext } from './skill-types';
import { NoteLinter } from '../utils/note-linter';
import { fingerprint } from '../runtime/fingerprint';
import { RunBlocked } from '../runtime/types';
import { throwIfAborted } from '../utils/execution';

export function validateArtifact(path: string, content: string, previous: string | null): void {
  if (/\.canvas$/i.test(path)) {
    const data = JSON.parse(content);
    if (!Array.isArray(data.nodes) || !Array.isArray(data.edges)) throw new Error('Canvas 必须包含 nodes 和 edges 数组');
    const ids = new Set<string>();
    for (const node of data.nodes) {
      if (!node.id || ids.has(node.id) || !['text','file','link','group'].includes(node.type) || !['x','y','width','height'].every(key => Number.isFinite(node[key])) || node.width <= 0 || node.height <= 0) throw new Error('Canvas 节点类型、ID 或布局无效');
      if (node.type === 'text' && typeof node.text !== 'string' || node.type === 'file' && typeof node.file !== 'string' || node.type === 'link' && typeof node.url !== 'string') throw new Error('Canvas 节点缺少内容');
      ids.add(node.id);
    }
    const edges = new Set<string>();
    for (const edge of data.edges) {
      if (!edge.id || edges.has(edge.id) || !ids.has(edge.fromNode) || !ids.has(edge.toNode)) throw new Error('Canvas 连线 ID 或引用无效');
      edges.add(edge.id);
    }
  } else if (/\.excalidraw$/i.test(path)) {
    const data = JSON.parse(content);
    if (data.type !== 'excalidraw' || !Array.isArray(data.elements)) throw new Error('Excalidraw 文件结构无效');
    const ids = new Set<string>();
    for (const element of data.elements) {
      if (!element.id || ids.has(element.id) || typeof element.type !== 'string' || !['x','y','width','height'].every(key => Number.isFinite(element[key]))) throw new Error('Excalidraw 元素 ID 或布局无效');
      ids.add(element.id);
    }
  } else if (/\.md$/i.test(path)) {
    const result = NoteLinter.validate(content);
    if (!result.isValid && (previous === null || result.errors.length > NoteLinter.validate(previous).errors.length)) throw new Error(`Note Linter Validation Failed!\n${result.errors.join('\n')}\n文件尚未写入，请修正内容。`);
  }
}

/** Stage and validate before mutation; success requires reading back the exact expected content. */
export async function writeVerifiedArtifact(context: SkillContext, path: string, content: string, previous: string | null): Promise<TFile> {
  if (!path || path.startsWith('/') || path.split('/').some(p => p === '..' || p === '.') || path.includes('\\')) throw new Error('文件路径必须位于当前 vault 内');
  validateArtifact(path, content, previous);
  const beforeHash = await fingerprint(previous), afterHash = await fingerprint(content);
  if (context.runtime && context.operationId) {
    const platform = context.plugin.platform;
    if (!platform) throw new Error('无法暂存产物，禁止执行写入');
    const folder = `${platform.getConfigDir()}/plugins/obsidian-mentat/artifacts`;
    if (!await platform.exists(folder)) await platform.mkdir(folder);
    const id = await fingerprint({ runId: context.runtime.runId, scope: context.runtime.scope, operationId: context.operationId });
    const stagePath = `${folder}/${id}.json`;
    await platform.write(stagePath, JSON.stringify({ path, beforeHash, afterHash, content }));
    await context.runtime.record('artifact:prepared', { path, beforeHash, afterHash, stagePath }, context.operationId);
  }
  throwIfAborted(context.abortSignal);
  const file = context.vault.getAbstractFileByPath(path);
  const current = file instanceof TFile ? await context.vault.read(file) : null;
  if (current !== previous) throw new RunBlocked('文件在准备写入期间发生变化，请核对后重新授权');
  const folder = path.slice(0, path.lastIndexOf('/'));
  if (path.includes('/')) {
    let parent = '';
    for (const part of folder.split('/')) {
      parent += (parent ? '/' : '') + part;
      if (!context.vault.getAbstractFileByPath(parent)) await context.vault.createFolder(parent);
    }
  }
  throwIfAborted(context.abortSignal);
  const written = file instanceof TFile ? (await context.vault.modify(file, content), file) : await context.vault.create(path, content);
  const verified = await context.vault.read(written);
  if (verified !== content) throw new RunBlocked('文件写入后的内容与预期不一致，结果待核对；已保留暂存产物');
  await context.runtime?.record('artifact:verified', { path, afterHash, bytes: content.length }, context.operationId);
  return written;
}
