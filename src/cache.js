import { mkdir, lstat, readFile, open, rename, unlink, chmod, rmdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const VERSION = 1;
const MAX_TTL_MS = 86400000;
const validKey = key => typeof key === 'string' && /^[a-f0-9]{64}$/.test(key);
function validRecord(record, now) {
  return record && typeof record === 'object' && !Array.isArray(record) &&
    typeof record.score === 'number' && Number.isFinite(record.score) && record.score >= 0 && record.score <= 1 &&
    Number.isSafeInteger(record.expires) && record.expires > now && record.expires <= now + MAX_TTL_MS &&
    (record.model == null || (typeof record.model === 'string' && record.model.length <= 256 && /^[a-zA-Z0-9._:/~, -]+$/.test(record.model)));
}
const clean = record => ({ score: record.score, model: record.model || null, expires: record.expires });
function positive(value, name, min, max) { if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}`); }
class TrackedMap extends Map {
  constructor(entries) { super(); this.changed = new Map(); this.removed = new Set(); for (const [key,value] of entries) super.set(key,value); }
  set(key,value) { super.set(key,value); this.changed.set(key,value); this.removed.delete(key); return this; }
  delete(key) { this.changed.delete(key); this.removed.add(key); return super.delete(key); }
  clear() { for (const key of this.keys()) this.removed.add(key); this.changed.clear(); super.clear(); }
}
/** Cache files contain only hashed keys and bounded numeric judgments, never source passages or credentials. */
export async function loadDiskCache({ enabled = true, cacheDir, env = process.env, homeDir = os.homedir(), maxEntries = 2000, maxBytes = 1048576, lockTimeoutMs = 3000 } = {}) {
  if (!enabled) return { cache: null, flush: async () => {}, warnings: [], kind: 'disabled', path: null };
  positive(maxEntries,'maxEntries',1,2000);positive(maxBytes,'maxBytes',256,4194304);positive(lockTimeoutMs,'lockTimeoutMs',0,10000);
  const directory = path.resolve(cacheDir || path.join(env.XDG_CACHE_HOME || path.join(homeDir,'.cache'),'jevgraph'));
  const filename = path.join(directory,'semantic-v1.json'), lockPath = path.join(directory,'.semantic.lock'), warnings=[];
  let memoryOnly=false;
  const warn = message => { if (!warnings.includes(message)) warnings.push(message); };
  async function readEntries() {
    let info;
    try { info=await lstat(filename); } catch(error) {if(error.code==='ENOENT')return new Map();throw error;}
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('unsafe-file');
    if (info.size > maxBytes) { warn('Semantic cache exceeded its size bound and was ignored.'); return new Map(); }
    let data;
    try {data=JSON.parse(await readFile(filename,'utf8'));} catch {warn('Malformed semantic cache was ignored; fresh judgments will be used.');return new Map();}
    if (!data || data.version!==VERSION || !Array.isArray(data.entries) || data.entries.length>maxEntries) {warn('Unsupported or oversized semantic cache was ignored.');return new Map();}
    const entries=new Map(), now=Date.now();
    for(const entry of data.entries) {
      if (!Array.isArray(entry) || entry.length!==2 || !validKey(entry[0]) || !validRecord(entry[1],now)) continue;
      entries.set(entry[0],clean(entry[1]));
    }
    return entries;
  }
  let initial=new Map();
  try {
    // Loading does not create any directories. Creation is deferred until a new score needs saving.
    const info=await lstat(directory);
    if(!info.isDirectory()||info.isSymbolicLink())throw new Error('unsafe-directory');
    initial=await readEntries();
  } catch(error) {
    if(error.code!=='ENOENT') {memoryOnly=true;warn('Semantic disk cache is unavailable; using memory for this run.');}
  }
  const cache=new TrackedMap(initial);
  Object.defineProperty(cache,'cacheKind',{value:memoryOnly?'memory-fallback':'persistent-disk',enumerable:false});
  const result={cache,warnings,kind:memoryOnly?'memory':'disk',path:memoryOnly?null:filename,flush};
  async function flush() {
    if(memoryOnly||(!cache.changed.size&&!cache.removed.size))return;
    let locked=false,temp;
    try {
      await mkdir(directory,{recursive:true,mode:0o700});
      const info=await lstat(directory);
      if(!info.isDirectory()||info.isSymbolicLink())throw new Error('unsafe-directory');
      await chmod(directory,0o700);
      const started=Date.now();
      while(true) {
        try {await mkdir(lockPath,{mode:0o700});locked=true;break;} catch(error) {
          if(error.code!=='EEXIST')throw error;
          if(Date.now()-started>=lockTimeoutMs) {warn('Semantic cache was busy; this run did not save new cache entries.');return;}
          await sleep(25);
        }
      }
      const merged=await readEntries(),now=Date.now();
      for(const key of cache.removed)merged.delete(key);
      for(const [key,value] of cache.changed)if(validKey(key)&&validRecord(value,now)) {
        const previous=merged.get(key);if(!previous||value.expires>=previous.expires)merged.set(key,clean(value));
      }
      let entries=[...merged].filter(([key,value])=>validKey(key)&&validRecord(value,now)).sort((a,b)=>b[1].expires-a[1].expires||a[0].localeCompare(b[0])).slice(0,maxEntries);
      let serialized=JSON.stringify({version:VERSION,entries});
      while(Buffer.byteLength(serialized)+1>maxBytes&&entries.length) {entries.pop();serialized=JSON.stringify({version:VERSION,entries});}
      temp=path.join(directory,`.semantic-${process.pid}-${randomBytes(6).toString('hex')}.tmp`);
      const handle=await open(temp,'wx',0o600);
      try {await handle.writeFile(serialized+'\n','utf8');await handle.sync();} finally {await handle.close();}
      await rename(temp,filename);temp=null;
      await chmod(filename,0o600);
      cache.changed.clear();cache.removed.clear();
    } catch {
      warn('Semantic disk cache could not be saved; retrieval results remain valid.');
    } finally {
      if(temp)await unlink(temp).catch(()=>{});
      if(locked)await rmdir(lockPath).catch(()=>{});
    }
  }
  return result;
}
