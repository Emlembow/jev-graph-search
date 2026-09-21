import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const digest = value => createHash('sha256').update(value).digest('hex');
const sorted = values => [...values].sort((a, b) => String(a).localeCompare(String(b), 'en'));
const fail = message => { throw new Error(message); };
const text = value => typeof value === 'string' ? value : '';
const relationNames = new Set(['related', 'related concepts', 'related pages', 'see also', 'depends on', 'implements', 'authority', 'parent']);
const stripCode = content => content.replace(/^\s*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s*\1\s*$/gm, '').replace(/`[^`\n]*`/g, '');
const norm = value => String(value).normalize('NFKC').trim().replace(/\\/g, '/').replace(/\.md$/i, '').replace(/_/g, ' ').replace(/\s+/g, ' ').toLocaleLowerCase('en');
const bounded = (value, name, min, max) => { if (!Number.isInteger(value) || value < min || value > max) fail(`${name} must be an integer between ${min} and ${max}`); return value; };

function identityKey(value) { return String(value).trim(); }
function aliasKey(value) {
  if (/^https?:\/\//i.test(String(value))) { try { const u = new URL(value); u.hash = ''; return u.toString().replace(/\/$/, ''); } catch {} }
  return norm(String(value).split('#')[0].split('^')[0]);
}
function splitValues(value) {
  const values = [];
  let start = 0, quote = '', depth = 0;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (quote) { if (char === quote && value[i - 1] !== '\\') quote = ''; }
    else if ((char === '"' || char === "'") && !value.slice(start, i).trim()) quote = char;
    else if (char === '[') depth++;
    else if (char === ']') depth--;
    else if (char === ',' && depth === 0) { values.push(value.slice(start, i).trim()); start = i + 1; }
  }
  values.push(value.slice(start).trim());
  return values.filter(Boolean);
}
function scalar(value) {
  const clean = value.trim();
  if (/^\[(?!\[).*\]$/.test(clean)) return splitValues(clean.slice(1, -1)).map(scalar);
  if (clean === 'true' || clean === 'false') return clean === 'true';
  return clean.replace(/^['"]|['"]$/g, '');
}
function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return { body: content, properties: {} };
  const properties = {};
  let listKey;
  for (const line of match[1].split(/\r?\n/)) {
    const entry = line.match(/^([^\s:#][^:]*):\s*(.*)$/);
    if (entry) {
      listKey = entry[2].trim() === '' ? entry[1].trim() : undefined;
      properties[entry[1].trim()] = listKey ? [] : scalar(entry[2]);
    } else if (listKey && /^\s*-\s+/.test(line)) {
      properties[listKey].push(scalar(line.replace(/^\s*-\s+/, '')));
    } else if (line.trim() && !/^\s*#/.test(line)) listKey = undefined;
  }
  return { body: content.slice(match[0].length), properties };
}
function list(value) { return Array.isArray(value) ? value.map(String) : typeof value === 'string' ? [value] : []; }
function propertyList(value) {
  const parsed = typeof value === 'string' ? scalar(value) : value;
  const values = Array.isArray(parsed) ? parsed : list(value).flatMap(splitValues);
  return values.map(value => String(scalar(String(value))).replace(/^\[\[([\s\S]*)\]\]$/, '$1').trim()).filter(Boolean);
}
function relationTargets(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(relationTargets);
  if (!value || typeof value !== 'object') return [];
  if (value.relation) return relationTargets(value.relation);
  for (const key of ['target', 'id', 'url', 'title']) if (typeof value[key] === 'string') return [value[key]];
  return [];
}
function extractLinks(content, properties) {
  const body = stripCode(content).replace(/^alias(?:es)?::.*$/gm, '');
  const links = [];
  const add = (target, relation, evidence, source) => { if (target?.trim()) links.push({ target: target.trim(), relation, evidence, source }); };
  for (const match of body.matchAll(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g)) add(match[1].split('#')[0].split('^')[0], 'link', match[0], 'wikilink');
  for (const match of body.matchAll(/\[[^\]]*\]\(<?([^\s)>]+)>?(?:\s+["'][^)]*)?\)/g)) {
    const target = match[1];
    add(target.split('#')[0], 'link', match[0], 'markdown-link');
  }
  let heading = null;
  for (const line of body.split(/\r?\n/)) {
    const h = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*$/);
    if (h) { heading = relationNames.has(h[1].toLowerCase()) ? h[1] : null; continue; }
    if (!heading) continue;
    const bullet = line.match(/^\s*[-*+]\s+(.+)$/); if (!bullet) continue;
    const value = bullet[1];
    const target = value.match(/\[\[([^\]|#]+)/)?.[1] || value.match(/\[[^\]]*\]\(([^)]+)\)/)?.[1] || value.match(/^\*\*([^*]+)\*\*/)?.[1] || value.split(/\s+[—–-]\s+|\s+:\s+/)[0];
    add(target, norm(heading).replace(/ /g, '-'), `${heading}: ${value}`, 'relationship-section');
  }
  for (const [name, value] of Object.entries(properties)) {
    if (!relationNames.has(name.toLowerCase()) && !(value && typeof value === 'object' && (value.type === 'relation' || Array.isArray(value.relation)))) continue;
    for (const target of relationTargets(value)) add(target, norm(name).replace(/ /g, '-'), `Relation property ${name}: ${target}`, 'relation-property');
  }
  return links;
}
function normalizePage(item, index) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) fail(`pages[${index}] must be an object`);
  for (const field of ['id','url','title','name','content','source_path','path']) if (item[field] !== undefined && item[field] !== null && typeof item[field] !== 'string') fail(`pages[${index}].${field} must be a string`);
  if (item.properties != null && (typeof item.properties !== 'object' || Array.isArray(item.properties))) fail(`pages[${index}].properties must be an object`);
  for (const field of ['links','unsupported_features']) if (item[field] != null && !Array.isArray(item[field])) fail(`pages[${index}].${field} must be an array`);
  for (const field of ['tags','aliases']) if (item[field] != null && !Array.isArray(item[field]) && typeof item[field] !== 'string') fail(`pages[${index}].${field} must be a string or array`);
  const parsed = parseFrontmatter(item.content || '');
  const properties = { ...parsed.properties, ...item.properties };
  // Unindented page properties are metadata; indented block properties remain
  // source text and must not override their containing page's tags or aliases.
  for (const match of stripCode(parsed.body).matchAll(/^([^\s:#-][^:\n]*?)::[ \t]*(.*)$/gm)) {
    const key = match[1].trim();
    if (!(key in properties)) properties[key] = ['alias', 'aliases', 'tags'].includes(key) ? propertyList(match[2]) : scalar(match[2]);
  }
  const sourcePath = item.source_path || item.path || '';
  const title = item.title || item.name || text(properties.title) || parsed.body.match(/^#\s+(.+)$/m)?.[1] || (sourcePath ? path.basename(sourcePath).replace(/\.md$/i, '') : `Untitled ${index + 1}`);
  const stable = item.id || item.url;
  if (!stable && !sourcePath) fail(`pages[${index}] requires an id, URL or source_path; titles are not stable identifiers`);
  const id = stable ? identityKey(stable) : `local:${digest(sourcePath.replace(/\\/g, '/')).slice(0, 24)}`;
  const tags = [...list(properties.tags), ...list(item.tags), ...[...stripCode(parsed.body).matchAll(/(?:^|\s)#([\p{L}\p{N}][\p{L}\p{N}_/-]*)/gu)].map(x => x[1]), ...[...stripCode(parsed.body).matchAll(/(?:^|\s)#\[\[([^\]]+)\]\]/g)].map(x => x[1])];
  const unsupported = list(item.unsupported_features);
  if (/\(\([^)]+\)\)/.test(parsed.body)) unsupported.push('block-references');
  if (/<table\b/i.test(parsed.body)) unsupported.push('table-links-require-explicit-snapshot');
  const links = extractLinks(parsed.body, properties);
  for (const value of item.links || []) {
    const link = typeof value === 'string' ? { target: value } : value;
    if (!link || typeof link !== 'object') fail(`pages[${index}].links contains invalid entry`);
    const target = link.target || link.id || link.url || link.title;
    if (typeof target !== 'string' || !target.trim()) fail(`pages[${index}].links requires a target`);
    links.push({ target, relation: text(link.relation) || 'link', evidence: text(link.evidence) || `Explicit snapshot target: ${target}`, source: text(link.source) || 'snapshot-link' });
  }
  return { ...item, id, title, url: item.url || null, source_path: sourcePath || id, source_kind: item.source_kind || 'local', content: parsed.body, properties, tags: sorted(new Set(tags.map(x => x.replace(/^#/, '')))), aliases: sorted(new Set([...list(properties.aliases), ...list(properties.alias), ...list(item.aliases)])), kind: item.kind || 'page', parent: item.parent ?? (sourcePath ? path.posix.dirname(sourcePath) : null), database: item.database || item.database_id || null, data_source: item.data_source || item.data_source_url || null, links, unsupported_features: sorted(new Set(unsupported)), content_digest: digest(parsed.body) };
}
function resolver(pages) {
  const exact = new Map(), aliases = new Map();
  const add = (key, id) => { if (!key) return; const ids = aliases.get(key) || new Set(); ids.add(id); aliases.set(key, ids); };
  for (const page of pages) {
    exact.set(identityKey(page.id), page.id);
    for (const value of [page.id, page.url, page.title, page.source_path, path.posix.basename(page.source_path), ...page.aliases]) if (value) add(aliasKey(value), page.id);
  }
  return (value, owner) => {
    if (exact.has(identityKey(value))) return { id: exact.get(identityKey(value)) };
    let decoded = value; try { decoded = decodeURIComponent(value); } catch {}
    const candidates = [];
    if (owner && !/^[a-z][a-z\d+.-]*:/i.test(decoded)) candidates.push(aliasKey(path.posix.normalize(path.posix.join(path.posix.dirname(owner.source_path), decoded.split('#')[0]))));
    candidates.push(aliasKey(decoded));
    for (const key of candidates) {
      const ids = aliases.get(key); if (!ids) continue;
      return ids.size === 1 ? { id: [...ids][0] } : { candidates: sorted(ids) };
    }
    return {};
  };
}
export function buildGraph(snapshot, options = {}) {
  if (Array.isArray(snapshot)) snapshot = { pages: snapshot };
  if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.pages)) fail('Snapshot must be an object with a pages array');
  if (snapshot.schema_version != null && snapshot.schema_version !== 1) fail('Unsupported snapshot schema_version; expected 1');
  const sourceFormat = snapshot.source_format || 'json';
  const pages = snapshot.pages.map((page, i) => normalizePage(page, i)).sort((a,b) => a.id.localeCompare(b.id));
  const seen = new Set(); for (const page of pages) { if (seen.has(page.id)) fail(`Duplicate page ID: ${page.id}`); seen.add(page.id); }
  const metadataWarnings=[...(snapshot.warnings||[])], ids=new Map(pages.map(p=>[identityKey(p.id),p.id])), urlOwners=new Map();
  for(const page of pages)if(page.url){const key=identityKey(page.url);const owner=ids.get(key);if(owner&&owner!==page.id)metadataWarnings.push('A page URL conflicts with another stable page ID; exact IDs take precedence.');const owners=urlOwners.get(key)||new Set();owners.add(page.id);urlOwners.set(key,owners);}
  if([...urlOwners.values()].some(owners=>owners.size>1))metadataWarnings.push('Multiple pages share a URL; URL aliases remain ambiguous unless an exact stable ID resolves them.');
  const resolve = resolver(pages), byId = new Map(pages.map(x => [x.id,x]));
  const edges = [], unresolved = [], ambiguous = [], edgeKeys = new Set(), missingKeys = new Set();
  for (const page of pages) for (const link of page.links) {
    const result = resolve(link.target, page);
    if (!result.id) {
      // External Markdown destinations stay in source content; only supplied
      // pages can turn those URLs into local graph edges. Never fetch them.
      if (!result.candidates && link.source === 'markdown-link' && /^[a-z][a-z\d+.-]*:/i.test(link.target)) continue;
      const key = `${page.id}\0${link.target}`;
      if (!missingKeys.has(key)) { missingKeys.add(key); const row = { from: page.id, target: link.target, evidence: link.evidence }; if (result.candidates) ambiguous.push({ ...row, candidates: result.candidates }); else unresolved.push(row); }
      continue;
    }
    // Preserve different relations; collapse duplicated syntactic detections of the same relation.
    const key = `${page.id}\0${result.id}\0${link.relation}`;
    if (edgeKeys.has(key)) continue;
    edgeKeys.add(key); edges.push({ from: page.id, to: result.id, relation: link.relation, evidence: link.evidence, source: link.source, from_url: page.url, to_url: byId.get(result.id).url });
  }
  edges.sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return { schema_version: 1, metadata: { snapshot_id: snapshot.snapshot_id || null, source_format: sourceFormat, inventory_complete: snapshot.inventory_complete === true, inventory_scope: snapshot.inventory_scope || null, warnings: [...new Set(metadataWarnings)] }, pages, edges, unresolved_links: unresolved, ambiguous_links: ambiguous, unsupported_features: sorted(new Set(pages.flatMap(p => p.unsupported_features))) };
}
export async function loadGraph(inputPath, options = {}) {
  if (typeof inputPath !== 'string' || !inputPath) fail('input path is required');
  const { stat } = await import('node:fs/promises');
  const info = await stat(inputPath);
  if (!info.isDirectory()) return buildGraph(JSON.parse(await readFile(inputPath, 'utf8')), options);
  const pages = [];
  const rootEntries = await readdir(inputPath, { withFileTypes: true });
  const rootDirectories = new Set(rootEntries.filter(entry => entry.isDirectory()).map(entry => entry.name));
  const fileGraph = rootDirectories.has('logseq') && (rootDirectories.has('pages') || rootDirectories.has('journals'));
  let databaseFile = rootEntries.some(entry => entry.isFile() && /^db\.sqlite(?:3)?$/i.test(entry.name));
  if (rootDirectories.has('logseq')) {
    const metadataEntries = await readdir(path.join(inputPath, 'logseq'), { withFileTypes: true });
    databaseFile ||= metadataEntries.some(entry => entry.isFile() && /^db\.sqlite(?:3)?$/i.test(entry.name));
  }
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((a,b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile() && /\.md$/i.test(entry.name)) pages.push({ source_path: path.relative(inputPath, file).split(path.sep).join('/'), content: await readFile(file, 'utf8') });
    }
  }
  if (fileGraph) {
    for (const directory of ['pages', 'journals']) if (rootDirectories.has(directory)) await walk(path.join(inputPath, directory));
  } else await walk(inputPath);
  if (databaseFile && !pages.length) fail('Database graphs are not supported; point --input to a local Markdown folder or file graph.');
  return buildGraph({ schema_version: 1, source_format: 'markdown', inventory_complete: true, inventory_scope: fileGraph ? 'supplied-pages-and-journals' : 'supplied-directory', pages }, options);
}
function adjacency(graph) {
  const outgoing = new Map(graph.pages.map(p => [p.id, new Set()])), incoming = new Map(graph.pages.map(p => [p.id,new Set()]));
  for (const edge of graph.edges) { outgoing.get(edge.from).add(edge.to); incoming.get(edge.to).add(edge.from); }
  return { outgoing, incoming };
}
export function auditGraph(graph, { minLinks = 3, excludeNumeric = false } = {}) {
  bounded(minLinks, 'minLinks', 0, 100000);
  const { outgoing, incoming } = adjacency(graph);
  const eligible = graph.pages.filter(p => !excludeNumeric || !/^\d+$/.test(p.title));
  const degree = id => new Set([...outgoing.get(id), ...incoming.get(id)]).size;
  const rows = pages => pages.map(p => ({ id: p.id, title: p.title, url: p.url }));
  const orphan = eligible.filter(p => degree(p.id) === 0), dead = eligible.filter(p => incoming.get(p.id).size && !outgoing.get(p.id).size), weak = eligible.filter(p => degree(p.id) < minLinks);
  const seen = new Set(), components = [], byId = new Map(graph.pages.map(p => [p.id,p]));
  for (const page of graph.pages) {
    if (seen.has(page.id)) continue;
    const queue = [page.id]; seen.add(page.id);
    for (let i = 0; i < queue.length; i++) for (const id of new Set([...outgoing.get(queue[i]), ...incoming.get(queue[i])])) if (!seen.has(id)) { seen.add(id); queue.push(id); }
    const ids = queue.sort((a,b) => degree(b)-degree(a) || a.localeCompare(b));
    components.push({ size: ids.length, hub: ids[0], pages: ids.map(id => ({ id, title: byId.get(id).title })) });
  }
  const titles = new Map(); for (const page of graph.pages) { const key=norm(page.title); titles.set(key,[...(titles.get(key)||[]),page.id]); }
  const duplicates = Object.fromEntries([...titles].filter(([,ids]) => ids.length > 1));
  const pathCounts=new Map();for(const p of graph.pages)pathCounts.set(p.source_path,(pathCounts.get(p.source_path)||0)+1);
  const duplicatePaths=[...pathCounts].filter(([,count])=>count>1).map(([name])=>name).sort();
  return { graph_overview: { page_count: graph.pages.length, link_count: graph.edges.length, block_count_estimate: graph.pages.reduce((n,p) => n+Math.max(1,(p.content.match(/^\s*(?:#{1,6} |[-*+] |\d+[.)] )/gm)||[]).length),0), orphan_count: orphan.length, dead_end_count: dead.length, weakly_linked_count: weak.length, component_count: components.length, unresolved_link_count: graph.unresolved_links.length, ambiguous_link_count: graph.ambiguous_links.length, duplicate_title_group_count: Object.keys(duplicates).length, inventory_complete: graph.metadata.inventory_complete, inventory_scope: graph.metadata.inventory_scope, source_format: graph.metadata.source_format, top_connected: graph.pages.map(p => ({id:p.id,title:p.title,degree:degree(p.id)})).sort((a,b) => b.degree-a.degree || a.id.localeCompare(b.id)).slice(0,10) }, orphan_pages: rows(orphan), dead_end_pages: rows(dead), weakly_linked_pages: rows(weak), topic_clusters: components.filter(c => c.size > 1), components, duplicate_title_groups: duplicates, duplicate_source_paths: duplicatePaths, unresolved_links: graph.unresolved_links, ambiguous_links: graph.ambiguous_links, unsupported_features: graph.unsupported_features, edges: graph.edges, warnings: [...graph.metadata.warnings, ...(!graph.metadata.inventory_complete ? ['Findings apply to the supplied partial snapshot, not the whole workspace.'] : [])] };
}
function endpoint(graph, value) {
  if (typeof value !== 'string' || !value) fail('Traversal endpoints must be nonempty page IDs, URLs or unique titles');
  const result = resolver(graph.pages)(value);
  if (!result.id) fail(result.candidates ? `Ambiguous page: ${value}; use a stable ID` : `Page not found: ${value}`);
  return result.id;
}
export function traverseGraph(graph, { from, to, maxHops = 4, maxVisited = 1000 } = {}) {
  bounded(maxHops, 'maxHops', 0, 100); bounded(maxVisited, 'maxVisited', 1, 1000000);
  const start = endpoint(graph,from), target=endpoint(graph,to), {outgoing}=adjacency(graph), byId=new Map(graph.pages.map(p=>[p.id,p]));
  const queue=[start], previous=new Map([[start,null]]), depths=new Map([[start,0]]); let truncated=false;
  for (let i=0;i<queue.length && !previous.has(target);i++) {
    const id=queue[i]; if(depths.get(id)>=maxHops) { if(outgoing.get(id).size) truncated=true; continue; }
    for(const next of sorted(outgoing.get(id))) {
      if(previous.has(next)) continue;
      if(previous.size>=maxVisited) { truncated=true; break; }
      previous.set(next,id);depths.set(next,depths.get(id)+1);queue.push(next); if(next===target) break;
    }
  }
  const ids=[]; if(previous.has(target)) { for(let id=target;id!==null;id=previous.get(id)) ids.push(id); ids.reverse(); }
  const details=ids.map(id=>({id,title:byId.get(id).title,url:byId.get(id).url}));
  const edgeDetails=ids.slice(1).map((id,i)=>graph.edges.find(e=>e.from===ids[i] && e.to===id));
  return { from:start,to:target,found:ids.length>0,paths:ids.length?[details.map(p=>p.title)]:[],path_details:ids.length?[details]:[],path_edge_details:ids.length?[edgeDetails]:[],max_hops:maxHops,max_visited:maxVisited,visited:previous.size,truncated:truncated && !ids.length,inventory_complete:graph.metadata.inventory_complete,unresolved_links:graph.unresolved_links,ambiguous_links:graph.ambiguous_links };
}
export function connectionsGraph(graph, { from, to, maxHops = 5, maxVisited = 1000 } = {}) {
  const result=traverseGraph(graph,{from,to,maxHops,maxVisited}), {outgoing,incoming}=adjacency(graph);
  const a=new Set([...outgoing.get(result.from),...incoming.get(result.from)]), b=new Set([...outgoing.get(result.to),...incoming.get(result.to)]);
  return {...result,directly_linked:outgoing.get(result.from).has(result.to),shared_connections:graph.pages.filter(p=>a.has(p.id)&&b.has(p.id)&&p.id!==result.from&&p.id!==result.to).map(p=>({id:p.id,title:p.title,url:p.url}))};
}
export function analysisHealth(graph, { pageTypes=['analysis','strategy','assessment'],minOutgoing=3 }={}) {
  bounded(minOutgoing,'minOutgoing',0,100000); if(!Array.isArray(pageTypes)||pageTypes.some(x=>typeof x!=='string')) fail('pageTypes must be an array of strings');
  const types=new Set(pageTypes.map(norm)),{outgoing}=adjacency(graph),healthy=[],unhealthy=[];
  for(const p of graph.pages) {
    const values=[p.title,...p.tags,...['type','Type','page_type','Page Type'].flatMap(k=>list(p.properties[k]))];
    if(!values.some(v=>types.has(norm(v)))) continue;
    const decision=p.tags.some(t=>norm(t)==='decision') || /^\s*(?:#decision\b|DECIDE\b|decision::)/im.test(p.content);
    const row={id:p.id,title:p.title,url:p.url,outgoing_count:outgoing.get(p.id).size,has_decision:decision};
    (row.outgoing_count>=minOutgoing||decision?healthy:unhealthy).push(row);
  }
  return {page_types:[...types],min_outgoing:minOutgoing,healthy_pages:healthy,unhealthy_pages:unhealthy,inventory_complete:graph.metadata.inventory_complete};
}
export function migrationPlan(graph) {
  const audit=auditGraph(graph);
  return {schema_version:1,version:1,operation:'proposal-only',requires_user_authorization_for_writes:true,duplicate_source_paths:audit.duplicate_source_paths,pages:graph.pages.map(p=>({source_id:p.id,title:p.title,source_path:p.source_path,source_kind:p.source_kind,content:p.content,properties:p.properties,tags:p.tags,aliases:p.aliases,kind:p.kind,parent:p.parent,database:p.database,data_source:p.data_source,unsupported_features:p.unsupported_features,target:{source_id_property:'Source ID',migration_status:'planned'}})),resolved_edges:graph.edges,unresolved_links:graph.unresolved_links,ambiguous_links:graph.ambiguous_links,requires_manual_resolution:!!(graph.unresolved_links.length||graph.ambiguous_links.length||Object.keys(audit.duplicate_title_groups).length||audit.duplicate_source_paths.length||graph.unsupported_features.length),audit:audit.graph_overview};
}
function contentSemantic(value, lookup) {
  return String(value).replace(/<page\b[^>]*url=["']([^"']+)["'][^>]*>([^<]*)<\/page>/gi,(match,url,_label)=>lookup(url)||match).replace(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g,(match,ref,_label)=>lookup(ref)||match).replace(/\[([^\]]+)\]\(([^)]+)\)/g,(match,_label,url)=>lookup(url)||match).replace(/\s+/g,' ').trim();
}
export function verifyMigration(plan, targetGraph) {
  if(!plan||!Array.isArray(plan.pages)||!Array.isArray(plan.resolved_edges)) fail('Migration plan requires pages and resolved_edges arrays');
  const mapping=new Map(),duplicates=[],unmapped=[],issues=[],edgeIssues=[],planned=new Map();
  for(const page of plan.pages) { if(typeof page.source_id!=='string'||planned.has(page.source_id)) fail('Plan source IDs must be nonempty and unique'); planned.set(page.source_id,page); }
  for(const p of targetGraph.pages) {
    let id=p.source_id||p.properties['Source ID']||p.properties.source_id;
    if(id&&typeof id==='object') id=id.rich_text?.map(t=>t.plain_text||t.text?.content||'').join('');
    if(!id) {unmapped.push(p.id);continue;} id=String(id);
    if(mapping.has(id)) duplicates.push(id); mapping.set(id,p);
  }
  const missing=[...planned.keys()].filter(id=>!mapping.has(id)), unexpected=[...mapping.keys()].filter(id=>!planned.has(id));
  const labels=new Map();
  for(const p of plan.pages) for(const key of [p.source_id,p.title,p.source_path,...(p.aliases||[])]) if(key) labels.set(aliasKey(key),p.title);
  for(const [source,p] of mapping) if(planned.has(source)) for(const key of [p.id,p.url]) if(key) labels.set(aliasKey(key),planned.get(source).title);
  const lookup=value=>labels.get(aliasKey(value));
  const stable=value=>JSON.stringify(value,(_key,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
  for(const [source,p] of mapping) {
    const expected=planned.get(source); if(!expected) continue;
    for(const field of ['title','kind','parent','database','data_source']) if(expected[field]!=null&&expected[field]!==''&&stable(expected[field])!==stable(p[field])) issues.push({source_id:source,field});
    if(contentSemantic(expected.content,lookup)!==contentSemantic(p.content,lookup)) issues.push({source_id:source,field:'content'});
    for(const [key,value] of Object.entries(expected.properties||{})) if(stable(value)!==stable(p.properties[key])) issues.push({source_id:source,field:`properties.${key}`});
    for(const field of ['tags','aliases']) if(stable(sorted(expected[field]||[]))!==stable(sorted(p[field]||[]))) issues.push({source_id:source,field});
  }
  for(const e of plan.resolved_edges) {const from=mapping.get(e.from)?.id,to=mapping.get(e.to)?.id;if(from&&to&&!targetGraph.edges.some(x=>x.from===from&&x.to===to&&x.relation===e.relation&&x.evidence.trim())) edgeIssues.push(e);}
  const unsupported=[...new Set([...targetGraph.unsupported_features,...plan.pages.flatMap(p=>p.unsupported_features||[])])];
  const result={verified:false,missing_pages:missing,duplicate_source_ids:sorted(duplicates),unmapped_target_pages:unmapped,unexpected_source_ids:unexpected,page_fidelity_issues:issues,edge_fidelity_issues:edgeIssues,unsupported_feature_issues:unsupported,snapshot_inventory_complete:targetGraph.metadata.inventory_complete,plan_inventory_complete:plan.audit?.inventory_complete===true,snapshot_unresolved_links:targetGraph.unresolved_links,snapshot_ambiguous_links:targetGraph.ambiguous_links,plan_unresolved_links:plan.unresolved_links||[],plan_ambiguous_links:plan.ambiguous_links||[]};
  result.verified=targetGraph.metadata.inventory_complete&&result.plan_inventory_complete&&Object.entries(result).filter(([k])=>!['verified','snapshot_inventory_complete','plan_inventory_complete'].includes(k)).every(([,v])=>Array.isArray(v)&&v.length===0);
  return result;
}
