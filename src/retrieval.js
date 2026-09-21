import { createHash } from 'node:crypto';
import { auditGraph } from './graph.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const tokens = value => String(value).toLocaleLowerCase('en').match(/[\p{L}\p{N}]{2,}/gu) || [];
const stop = new Set(['the','and','for','with','from','that','this','what','how','does','are','our','can','which','where','when','have','into','who','why','was','will','not','you','your']);
const terms = value => [...new Set(tokens(value).filter(t => !stop.has(t)))];
const defaultCache = new Map();
const checkInt = (value,name,min,max) => { if(!Number.isInteger(value)||value<min||value>max) throw new Error(`${name} must be an integer between ${min} and ${max}`); };
const clientIds = new WeakMap(); let nextClientId = 0;
function namespace(jev) { if(jev.cacheNamespace) return jev.cacheNamespace; if(!clientIds.has(jev)) clientIds.set(jev,++nextClientId); return `client:${clientIds.get(jev)}`; }
function candidates(graph,query,limit) {
  const queryTerms=terms(query), corpus=graph.pages.map(p=>({page:p,words:tokens(`${p.title} ${p.tags.join(' ')} ${p.content}`)}));
  const average=corpus.reduce((n,d)=>n+d.words.length,0)/Math.max(1,corpus.length), frequency=new Map();
  for(const doc of corpus) for(const word of new Set(doc.words)) frequency.set(word,(frequency.get(word)||0)+1);
  const ranked=corpus.map(({page,words})=>{
    const counts=new Map(); for(const word of words) counts.set(word,(counts.get(word)||0)+1);
    let score=0;
    for(const term of queryTerms) {
      const tf=counts.get(term)||0, df=frequency.get(term)||0;
      const idf=Math.log(1+(corpus.length-df+.5)/(df+.5));
      if(tf) score+=idf*(tf*2.2)/(tf+1.2*(.25+.75*words.length/Math.max(1,average)));
      if(tokens(page.title).includes(term)) score+=idf*1.7;
      if(page.tags.some(tag=>tokens(tag).includes(term))) score+=idf*.8;
    }
    return {page,lexical_score:score,candidate_source:'lexical'};
  }).sort((a,b)=>b.lexical_score-a.lexical_score||a.page.id.localeCompare(b.page.id));
  const seeds=ranked.filter(r=>r.lexical_score>0).slice(0,3),seedIds=new Set(seeds.map(r=>r.page.id)),neighborIds=new Set();
  for(const edge of graph.edges) {if(seedIds.has(edge.from)&&!seedIds.has(edge.to)) neighborIds.add(edge.to);if(seedIds.has(edge.to)&&!seedIds.has(edge.from))neighborIds.add(edge.from);}
  const extra=ranked.filter(r=>neighborIds.has(r.page.id)).slice(0,Math.floor(limit/4));
  const selected=ranked.slice(0,Math.max(0,limit-extra.length));
  for(const candidate of extra) if(!selected.some(c=>c.page.id===candidate.page.id)) selected.push({...candidate,candidate_source:'graph-neighbor'});
  for(const candidate of ranked) {if(selected.length>=limit)break;if(!selected.some(c=>c.page.id===candidate.page.id))selected.push(candidate);}
  return selected.slice(0,limit);
}
function sourceWindow(page,query,maxLength=1600) {
  const body=page.content;
  if(body.length<=maxLength) return {text:body,start:0,end:body.length};
  const lower=body.toLocaleLowerCase('en'),queryTerms=terms(query),anchors=[0];
  for(const term of queryTerms) {
    let position=lower.indexOf(term),count=0;
    while(position>=0&&count++<30) {anchors.push(Math.max(0,position-Math.floor(maxLength*.25)));position=lower.indexOf(term,position+term.length);}
  }
  let best={start:0,score:-1};
  for(const anchor of anchors) {
    const start=Math.min(anchor,Math.max(0,body.length-maxLength)),slice=lower.slice(start,start+maxLength);
    const score=queryTerms.reduce((n,t)=>n+(slice.includes(t)?1:0),0);
    if(score>best.score)best={start,score};
  }
  const end=Math.min(body.length,best.start+maxLength);
  return {text:body.slice(best.start,end),start:best.start,end};
}
function optionsCheck({limit,candidateLimit,maxChars,threshold}) {
  checkInt(limit,'limit',1,100);checkInt(candidateLimit,'candidateLimit',1,100);checkInt(maxChars,'maxChars',128,1000000);
  if(limit>candidateLimit)throw new Error('limit must not exceed candidateLimit');
  if(typeof threshold!=='number'||!Number.isFinite(threshold)||threshold<0||threshold>1)throw new Error('threshold must be between 0 and 1');
}
async function score(jev,pairs,{purpose='relevance',cache=defaultCache,signal,cacheTtlMs=300000}={}) {
  if(!jev||typeof jev.scorePairs!=='function')throw new Error('Semantic retrieval requires a configured Jev client. Run jevgraph setup or explicitly choose --offline.');
  checkInt(cacheTtlMs,'cacheTtlMs',0,86400000);
  const now=Date.now(), scores=new Map(), pending=[], keys=new Map(), cachedModels=new Set(); let hits=0;
  for(const pair of pairs) {
    const key=hash(JSON.stringify([namespace(jev),'retrieval-v1',purpose,pair.query,pair.text,pair.content_digest||null]));keys.set(pair.id,key);
    const cached=cache?.get(key);
    if(cached&&cached.expires>now&&Number.isFinite(cached.score)&&cached.score>=0&&cached.score<=1) {scores.set(pair.id,cached.score);if(cached.model)cachedModels.add(cached.model);hits++;}else pending.push(pair);
  }
  let response={scores:[],usage:{input_tokens:0,output_tokens:0,cost:0},requests:0,model:cachedModels.size?[...cachedModels].join(','):jev.model||null,provider:jev.provider||null};
  if(pending.length) {
    response=await jev.scorePairs(pending,{purpose,signal});
    if(!response||!Array.isArray(response.scores))throw new Error('Semantic provider returned invalid scores');
    const returned=new Map();
    for(const row of response.scores) {
      if(!row||returned.has(row.id)||!pending.some(p=>p.id===row.id)||typeof row.score!=='number'||!Number.isFinite(row.score)||row.score<0||row.score>1)throw new Error('Semantic provider returned missing, duplicate or invalid candidate scores');
      returned.set(row.id,row.score);
    }
    if(returned.size!==pending.length)throw new Error('Semantic provider omitted candidate scores');
    for(const pair of pending) {
      const value=returned.get(pair.id);scores.set(pair.id,value);
      if(cacheTtlMs&&cache) {if(cache.size>=2000)cache.delete(cache.keys().next().value);cache.set(keys.get(pair.id),{score:value,expires:now+cacheTtlMs,model:response.model});}
    }
  }
  return {scores,response,hits};
}
export async function retrieve(graph,query,{limit=5,candidateLimit=20,maxChars=6000,jev,mode='required',offline=false,threshold=0,cache,signal,cacheTtlMs=300000,purpose='relevance'}={}) {
  if(typeof query!=='string'||!query.trim()||query.length>6000)throw new Error('query must contain 1–6000 characters');
  if(!['required','off'].includes(mode))throw new Error('mode must be required or off; offline retrieval must be explicit');
  optionsCheck({limit,candidateLimit,maxChars,threshold});
  const useJev=mode!=='off'&&!offline;
  if(useJev&&(!jev||typeof jev.scorePairs!=='function'))throw new Error('Semantic retrieval requires a configured Jev client. Run jevgraph setup or explicitly choose --offline.');
  if(signal?.aborted)throw new Error('Retrieval cancelled');
  const started=performance.now(),shortlist=candidates(graph,query,candidateLimit);
  const rows=shortlist.map(c=>{
    const window=sourceWindow(c.page,query);
    return {id:c.page.id,title:c.page.title,url:c.page.url,source_path:c.page.source_path,excerpt:window.text,lexical_score:c.lexical_score,score_source:useJev?'jev':'lexical',candidate_source:c.candidate_source,evidence:[{page_id:c.page.id,location:{start:window.start,end:window.end},text:window.text}],content_digest:hash(c.page.content)};
  });
  let semantics={response:{usage:{input_tokens:0,output_tokens:0,cost:0},requests:0,model:null,provider:null},hits:0};
  if(useJev&&rows.length) {
    semantics=await score(jev,rows.map(r=>({id:r.id,query,text:`Title: ${r.title.slice(0,512)}\n${r.excerpt}`,content_digest:r.content_digest})),{purpose,cache,signal,cacheTtlMs});
    for(const row of rows)row.score=semantics.scores.get(row.id);
    rows.sort((a,b)=>b.score-a.score||b.lexical_score-a.lexical_score||a.id.localeCompare(b.id));
  } else rows.sort((a,b)=>b.lexical_score-a.lexical_score||a.id.localeCompare(b.id));
  const qualified=rows.filter(r=>useJev?r.score>=threshold:r.lexical_score>0),results=[];
  let budgetOmitted=0;
  for(const row of qualified.slice(0,limit)) {
    if(JSON.stringify([...results,row]).length>maxChars) {
      // Keep citation metadata intact and trim only verbatim source text to fit the evidence budget.
      const copy=structuredClone(row); let available=Math.min(copy.excerpt.length,Math.max(0,Math.floor((maxChars-JSON.stringify([...results,{...copy,excerpt:'',evidence:copy.evidence.map(e=>({...e,text:''}))}]).length)/2)));
      const selectBudgetWindow=()=>{
        const window=available>0?sourceWindow({content:row.excerpt},query,available):{text:'',start:0,end:0};
        copy.excerpt=window.text;copy.evidence[0].text=window.text;
        copy.evidence[0].location.start=row.evidence[0].location.start+window.start;
        copy.evidence[0].location.end=row.evidence[0].location.start+window.end;
      };
      selectBudgetWindow();
      while(copy.excerpt.length&&JSON.stringify([...results,copy]).length>maxChars) {available--;selectBudgetWindow();}
      if(copy.excerpt.length&&JSON.stringify([...results,copy]).length<=maxChars)results.push(copy);else budgetOmitted++;
    } else results.push(row);
  }
  const payload=JSON.stringify(results).length, warnings=[...graph.metadata.warnings];
  if(!graph.metadata.inventory_complete)warnings.push('Results cover the supplied partial snapshot only.');
  if(!useJev)warnings.push('Explicit offline mode: lexical ranking is not a semantic judgment.');
  if(budgetOmitted||results.some(r=>r.evidence[0].text.length<rows.find(x=>x.id===r.id).excerpt.length))warnings.push('Evidence was truncated to the requested result payload character budget.');
  return {query,mode_requested:offline?'off':mode,mode_used:useJev?'jev':'lexical',results,warnings,inventory_complete:graph.metadata.inventory_complete,diagnostics:{candidate_ids:shortlist.map(c=>c.page.id),qualified_count:qualified.length,budget_omitted:budgetOmitted},metrics:{candidate_count:shortlist.length,corpus_pages:graph.pages.length,returned_count:results.length,output_chars:payload,output_budget_scope:'JSON results array only; excludes response metadata',estimated_output_tokens:Math.ceil(payload/4),token_estimator:'chars/4',jev_input_tokens:semantics.response.usage?.input_tokens??null,jev_output_tokens:semantics.response.usage?.output_tokens??null,jev_cost:semantics.response.usage?.cost??null,jev_requests:semantics.response.requests||0,cache_hits:semantics.hits,cache_kind:cache===null?'disabled':cache?.cacheKind||'process-memory',elapsed_ms:performance.now()-started,model:semantics.response.model||jev?.model||null,provider:semantics.response.provider||jev?.provider||null}};
}
export async function planPlacement(graph,text,options={}) {
  const result=await retrieve(graph,text,{...options,purpose:'placement'}),best=result.results[0];
  const censored=result.diagnostics.qualified_count>result.results.length||result.diagnostics.budget_omitted>0;
  let action='review';
  if(result.mode_used==='jev'&&!censored)action=best&&best.score>=.75?'append':(!best||best.score<.35?'create':'review');
  return {operation:'proposal-only',suggested_action:action,target_page_id:action==='append'?best.id:null,requires_write_authorization:true,uncertain:action==='review',reason:censored?'Not all qualified destinations fit the result limit or evidence budget; omitted evidence cannot establish that a new page is needed.':result.mode_used==='lexical'?'Offline candidates need semantic or human review before choosing a destination.':action==='append'?'The leading candidate met the placement threshold; review the cited page before writing.':action==='create'?'No returned candidate met the placement threshold; a new page may be appropriate.':'Placement confidence is insufficient for an automatic destination.',retrieval:result};
}
export async function semanticAudit(graph,{jev,mode='required',offline=false,maxSuggestions=10,maxPairs=40,threshold=.65,cache,signal,cacheTtlMs=300000,...auditOptions}={}) {
  checkInt(maxSuggestions,'maxSuggestions',1,100);checkInt(maxPairs,'maxPairs',1,100);
  if(typeof threshold!=='number'||threshold<0||threshold>1)throw new Error('threshold must be between 0 and 1');
  const structural=auditGraph(graph,auditOptions),useJev=!offline&&mode!=='off';
  if(!['required','off'].includes(mode))throw new Error('mode must be required or off');
  if(useJev&&(!jev||typeof jev.scorePairs!=='function'))throw new Error('Semantic audit requires a configured Jev client or explicit --offline.');
  if(!useJev)return {structural,semantic:{status:'skipped-offline',suggestions:[],observed_edges_changed:false,metrics:{jev_requests:0}}};
  const weakIds=new Set(structural.weakly_linked_pages.map(p=>p.id)),pairs=[],pairKeys=new Set(),byId=new Map(graph.pages.map(p=>[p.id,p]));
  for(const page of graph.pages.filter(p=>weakIds.has(p.id))) {
    const query=`${page.title.slice(0,512)}\n${page.content.slice(0,1200)}`;
    for(const candidate of candidates(graph,query,Math.min(6,graph.pages.length))) {
      const other=candidate.page;
      if(other.id===page.id||graph.edges.some(e=>(e.from===page.id&&e.to===other.id)||(e.to===page.id&&e.from===other.id)))continue;
      const key=[page.id,other.id].sort().join('\0');if(pairKeys.has(key))continue;
      pairKeys.add(key);pairs.push({id:`pair_${pairs.length}`,query,text:`${other.title.slice(0,512)}\n${sourceWindow(other,query,1200).text}`,content_digest:hash(page.content+'\0'+other.content),from:page.id,to:other.id});if(pairs.length>=maxPairs)break;
    }
    if(pairs.length>=maxPairs)break;
  }
  if(!pairs.length)return {structural,semantic:{status:'skipped-no-candidates',suggestions:[],observed_edges_changed:false,metrics:{jev_requests:0}}};
  const scored=await score(jev,pairs,{purpose:'relationship',cache,signal,cacheTtlMs});
  const suggestions=pairs.filter(p=>scored.scores.get(p.id)>=threshold).map(p=>({from:p.from,to:p.to,from_title:byId.get(p.from).title,to_title:byId.get(p.to).title,score:scored.scores.get(p.id),status:'unverified-suggestion',suggestion_type:byId.get(p.from).title.toLowerCase()===byId.get(p.to).title.toLowerCase()?'possible-duplicate':'possible-related-page',evidence:[{page_id:p.from,text:p.query},{page_id:p.to,text:p.text}],requires_review:true})).sort((a,b)=>b.score-a.score||a.from.localeCompare(b.from)||a.to.localeCompare(b.to)).slice(0,maxSuggestions);
  return {structural,semantic:{status:'scored',suggestions,observed_edges_changed:false,metrics:{candidate_pairs:pairs.length,jev_requests:scored.response.requests,jev_input_tokens:scored.response.usage?.input_tokens??null,cache_hits:scored.hits,cache_kind:cache===null?'disabled':cache?.cacheKind||'process-memory',model:scored.response.model,provider:scored.response.provider}}};
}
