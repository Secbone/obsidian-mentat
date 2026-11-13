import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=`
import { IndexedObservationQuery } from './src/observability/observation-query';
import { Observer } from './src/observability/observer';
const median=values=>values.sort((a,b)=>a-b)[Math.floor(values.length/2)];
const results=[];
for (const size of [2000,20000,100000]) {
  const records=Array.from({length:size/200},(_,run)=>({id:'run-'+run,sessionId:'s',events:Array.from({length:200},(_,i)=>{
    const phase=i%5,requestId='req-'+Math.floor(i/5);
    return {id:'run-'+run+':'+(i+1),sequence:i+1,timestamp:(run*200+i)*10,
      type:i===0 ? 'run:started':phase===1 ? 'model:requested':phase===2 ? 'model:result':phase===3 ? 'operation:running':phase===4 ? 'operation:finished':'checkpoint',
      operationId:phase===3 || phase===4 ? 'op-'+Math.floor(i/5):undefined,
      details:phase===1 ? {requestId,outputLimit:65536}:phase===2 ? {response:{requestId,elapsedMs:10},usage:{promptTokens:1000,completionTokens:20}}:{}};
  })}));
  const indexed=new Map(records.map(record=>[record.id,record]));
  const runs={list:()=>records.slice().reverse(),get:id=>indexed.get(id),getWarnings:()=>[]};
  const observer=new Observer({folder:'memory',health:{writeError:'',readError:'',dropped:0,malformed:0},enqueue(){},read:async()=>[]} as any);
  const query=new IndexedObservationQuery(runs as any,observer);
  let started=performance.now();const first=query.page({},200);const coldPageMs=performance.now()-started;
  const samples=[];for(let n=0;n<30;n++){started=performance.now();query.page({},200);samples.push(performance.now()-started);}
  const latest=records.at(-1);latest.events.push({id:latest.id+':201',sequence:201,timestamp:size*10+1,type:'model:failed',details:{requestId:'late',error:'synthetic failure'}});
  started=performance.now();const next=query.page({},200);const incrementalPageMs=performance.now()-started;
  started=performance.now();query.page({runId:latest.id},200);const selectedPageMs=performance.now()-started;
  if(first.total!==size || next.total!==size+1 || next.events.length!==200)throw new Error('Incorrect page contract');
  results.push({events:size,runs:records.length,coldPageMs,warmPageMedianMs:median(samples),incrementalPageMs,selectedPageMs});
  query.dispose();
}
console.log(JSON.stringify({note:'Synthetic query projection only; excludes controller snapshot copying, disk IO, DOM and model latency.',results},null,2));
`;
const bundle=await build({stdin:{contents:source,resolveDir:root,loader:'ts'},bundle:true,platform:'node',format:'esm',write:false});
await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
