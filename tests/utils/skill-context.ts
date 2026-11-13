import { MutationService } from '../../src/skills/mutations/mutation-service';
import { NodeCommandExecutor } from '../../src/adapters/node/command-executor';
import type { MutationPlan } from '../../src/contracts/tools';
import type { SkillContext } from '../../src/skills/skill-types';
/** Explicit test-only bridge for historical Obsidian fixtures. Production never receives plugin/App. */
export function adaptTestSkillContext(legacy:any):SkillContext {
  if(legacy.files)return legacy;
  const vault=legacy.vault||{},plans=new Map<string,MutationPlan>();
  const fileAt=(path:string)=>{
    const file=vault.getAbstractFileByPath?.(path);if(!file)return null;
    if(!('children' in file)){
      file.extension??=path.split('.').pop()||'';file.name??=path.split('/').pop()||path;file.basename??=file.name.replace(/\.[^.]+$/,'');file.stat??={mtime:1,ctime:1,size:0};
    }
    return file;
  };
  const files={getAbstractFileByPath:fileAt,getMarkdownFiles:()=>vault.getMarkdownFiles?.()||[],read:(file:any)=>vault.read(file)};
  const mutations=new MutationService({
    read:async path=>{const file=fileAt(path);return file&&'extension' in file?vault.read(file):null;},
    exists:async path=>!!fileAt(path),listMarkdown:async()=>files.getMarkdownFiles().map((f:any)=>f.path),
    write:async(path,content)=>{const file=fileAt(path);if(file)await vault.modify(file,content);else await vault.create(path,content);},
    move:async(from,to)=>{
      const file=fileAt(from);
      if(vault.rename)await vault.rename(file,to);else if(legacy.plugin?.app?.fileManager)await legacy.plugin.app.fileManager.renameFile(file,to);else throw new Error('Mock does not implement move');
    },
    resolveLink:(link,source)=>{
      const resolved=legacy.metadataCache?.getFirstLinkpathDest?.(link,source);if(resolved)return resolved.path;
      const candidates=[link,`${link}.md`,`${source.split('/').slice(0,-1).join('/')}/${link}`];return candidates.find(path=>!!fileAt(path))||null;
    },
  },{load:async key=>structuredClone(plans.get(key)||null),save:async(key,plan)=>{plans.set(key,structuredClone(plan));},clear:async key=>{plans.delete(key);}});
  return {files,mutations,settings:structuredClone(legacy.settings??legacy.plugin?.settings??{}),metadataCache:legacy.metadataCache||{getFileCache:()=>null},indexManager:legacy.indexManager,readTracker:legacy.readTracker,
    runtime:legacy.runtime,operationId:legacy.operationId,abortSignal:legacy.abortSignal,askUser:legacy.askUser,
    commands:legacy.commands||(vault.adapter?.getBasePath?new NodeCommandExecutor(vault.adapter.getBasePath()):undefined)};
}
