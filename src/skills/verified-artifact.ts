import type { SkillContext } from './skill-types';
import { NoteLinter } from '../utils/note-linter';
import { RunBlocked } from '../runtime/types';

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

/** Compatibility helper; all actual mutation and verification stays in the host service. */
export async function writeVerifiedArtifact(context:SkillContext,path:string,content:string,previous:string|null){
  if(!context.mutations)throw new Error('宿主未提供文件变更服务');
  const plan=await context.mutations.prepare('compat:write_verified_artifact',{path,content},async()=>({changes:[await context.mutations!.writeChange(path,content,previous)],summary:`写入 ${path}`}),context);
  const outcome=await context.mutations.apply(plan,context);
  if(outcome.outcome!=='success')throw new RunBlocked(outcome.error);
  const file=context.files.getAbstractFileByPath(path);if(!file||!('extension' in file))throw new RunBlocked('写入文件未能读取');return file;
}
