import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, realpath } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { NodeCommandExecutor } from '../../src/adapters/node/command-executor';

let directory:string,root:string;
beforeEach(async()=>{directory=await mkdtemp(path.join(tmpdir(),'mentat-command-'));root=path.join(directory,'vault');await mkdir(root);});
afterEach(async()=>{await rm(directory,{recursive:true,force:true});});
const nodeCommand=(script:string)=>`'${process.execPath.replace(/'/g,"'\\''")}' -e '${script.replace(/'/g,"'\\''")}'`;
describe('Explicit host command driver',()=>{
  it('runs an approved driver request in the selected vault directory',async()=>{
    const result=await new NodeCommandExecutor(root).execute({command:nodeCommand('process.stdout.write(process.cwd())'),timeout:5000});
    expect(result.outcome).toBe('success');expect((result.data as any).stdout).toBe(await realpath(root));
  });
  it('rejects sibling-prefix and symlink working-directory escapes',async()=>{
    const sibling=path.join(directory,'vault-other');await mkdir(sibling);await symlink(sibling,path.join(root,'outside'));
    for(const cwd of ['../vault-other','outside']){
      const result=await new NodeCommandExecutor(root).execute({command:nodeCommand('process.stdout.write("must not run")'),cwd,timeout:5000});
      expect(result.outcome).toBe('failure');expect(result.outcome==='failure'&&result.code).toBe('denied');
    }
  });
  it('keeps a nonzero exit uncertain rather than claiming that no external effects happened',async()=>{
    const result=await new NodeCommandExecutor(root).execute({command:nodeCommand('process.exit(3)'),timeout:5000});
    expect(result.outcome).toBe('unknown');expect((result.data as any).exitCode).toBe(3);
  });
  it('applies the compatibility blacklist before launching a process',async()=>{
    const result=await new NodeCommandExecutor(root).execute({command:'rm unused',timeout:5000});
    expect(result.outcome).toBe('failure');expect(result.outcome==='failure'&&result.code).toBe('denied');
  });
});
