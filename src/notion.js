import { createHash } from 'node:crypto';

const DEFAULT_BASE_URL = 'https://api.notion.com';
const DEFAULT_VERSION = '2026-03-11';
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504, 529]);
const SUPPORTED_TEXT_BLOCKS = new Set([
  'paragraph', 'heading_1', 'heading_2', 'heading_3', 'bulleted_list_item',
  'numbered_list_item', 'to_do', 'toggle', 'quote', 'callout', 'code',
  'child_page', 'child_database', 'link_to_page', 'equation', 'divider',
  'table_of_contents', 'breadcrumb', 'synced_block', 'template', 'column_list',
  'column', 'table', 'table_row',
]);

export class NotionError extends Error {
  constructor(message, { code = 'notion_error', status, retryable = false, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'NotionError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

export class NotionAuthError extends NotionError {
  constructor(message = 'Notion authentication is not configured') {
    super(message, { code: 'notion_auth_required', status: 401 });
    this.name = 'NotionAuthError';
  }
}

export class NotionTimeoutError extends NotionError {
  constructor(message = 'Notion request timed out', options = {}) {
    super(message, { ...options, code: 'notion_timeout' });
    this.name = 'NotionTimeoutError';
  }
}

function asPositiveInteger(value, name, { max = Number.MAX_SAFE_INTEGER, fallback } = {}) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new TypeError(`${name} must be a positive safe integer${max < Number.MAX_SAFE_INTEGER ? ` no greater than ${max}` : ''}`);
  }
  return value;
}

function asNonNegativeInteger(value, name, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
  return value;
}

function canonicalUuid(value) {
  if (typeof value !== 'string') return value;
  let decoded;
  try {
    decoded = decodeURIComponent(value).trim();
  } catch {
    decoded = value.trim();
  }
  decoded = decoded.replace(/[?#].*$/u, '').replace(/[),.;]+$/u, '');
  const candidate = decoded.match(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/iu)?.[0]
    ?? decoded.match(/[0-9a-f]{32}/iu)?.[0];
  if (!candidate) return decoded;
  const compact = candidate.replaceAll('-', '').toLowerCase();
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

function notionTarget(value) {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const trimmed = value.trim();
  const normalized = canonicalUuid(trimmed);
  return normalized === trimmed && !/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/iu.test(trimmed)
    ? trimmed
    : normalized;
}

function pageTitle(page) {
  if (!page || typeof page !== 'object') return '';
  if (typeof page.title === 'string') return page.title;
  if (Array.isArray(page.title)) return richText(page.title);
  const properties = page.properties && typeof page.properties === 'object' ? page.properties : {};
  for (const property of Object.values(properties)) {
    if (!property || typeof property !== 'object') continue;
    if (property.type === 'title' && Array.isArray(property.title)) return richText(property.title);
    if (property.type === 'title' && typeof property.title === 'string') return property.title;
  }
  return '';
}

function richText(items) {
  if (!Array.isArray(items)) return '';
  return items.map((item) => {
    if (typeof item === 'string') return item;
    if (!item || typeof item !== 'object') return '';
    return item.plain_text ?? item.text?.content ?? item.equation?.expression ?? '';
  }).join('');
}

function plainTextFromValue(value) {
  if (Array.isArray(value)) return richText(value);
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  for (const key of ['plain_text', 'content', 'expression']) {
    if (typeof value[key] === 'string') return value[key];
  }
  for (const key of ['title', 'rich_text', 'caption']) {
    if (Array.isArray(value[key])) return richText(value[key]);
  }
  return '';
}

function blockText(block) {
  if (!block || typeof block !== 'object') return '';
  if (typeof block.type === 'string' && block[block.type]) {
    const value = block[block.type];
    const parts = [];
    for (const key of ['rich_text', 'caption', 'title']) {
      if (Array.isArray(value[key])) parts.push(richText(value[key]));
      else if (typeof value[key] === 'string') parts.push(value[key]);
    }
    for (const key of ['text', 'expression', 'url']) {
      if (typeof value[key] === 'string') parts.push(value[key]);
    }
    if (block.type === 'table_row' && Array.isArray(value.cells)) parts.push(value.cells.map(richText).join('\t'));
    if (value.type === 'emoji' && value.emoji) parts.push(value.emoji);
    return parts.filter(Boolean).join(' ');
  }
  return '';
}

function objectUrl(page) {
  if (typeof page?.url === 'string' && page.url) return page.url;
  if (typeof page?.public_url === 'string' && page.public_url) return page.public_url;
  if (page?.id) return `https://www.notion.so/${canonicalUuid(String(page.id)).replaceAll('-', '')}`;
  return undefined;
}

function sourcePath(page) {
  return page?.parent?.type === 'database_id' ? undefined : undefined;
}

function relationLabel(name) {
  return String(name).trim().replace(/\s+/gu, '-').toLowerCase() || 'related';
}

function digest(value) {
  return createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

function ensureSignal(signal) {
  if (signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError');
}

function extractRelationLinks(properties, pageId, warnings) {
  const links = [];
  if (!properties || typeof properties !== 'object') return links;
  for (const [name, property] of Object.entries(properties)) {
    if (!property || typeof property !== 'object') continue;
    const values = property.type === 'relation' ? property.relation : property.relation;
    if (!Array.isArray(values)) continue;
    for (const relation of values) {
      const target = notionTarget(relation?.id ?? relation?.url);
      if (!target) continue;
      links.push({
        target,
        relation: relationLabel(name),
        evidence: `Property ${name} contains ${target}`,
        source: 'relation-property',
        from: pageId,
      });
    }
    if (property.has_more === true) warnings.push(`relation_property_truncated:${name}`);
  }
  return links;
}

function extractRichTextLinks(items, pageId, location, links) {
  if (!Array.isArray(items)) return;
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const href = item.href ?? item.text?.link?.url;
    if (href) {
      links.push({
        target: notionTarget(href),
        relation: 'link',
        evidence: `${location}: ${item.plain_text ?? href}`,
        source: 'rich-text',
        from: pageId,
      });
    }
    if (item.type === 'mention' && item.mention) {
      const mention = item.mention.page ?? item.mention.database ?? item.mention.data_source;
      const target = notionTarget(mention?.id ?? mention?.url);
      if (target) {
        links.push({
          target,
          relation: 'mention',
          evidence: `${location}: ${item.plain_text ?? target}`,
          source: 'page-mention',
          from: pageId,
        });
      }
    }
  }
}

function extractBlockLinks(block, pageId, location, links) {
  if (!block || typeof block !== 'object') return;
  const type = block.type;
  const value = type && block[type];
  if (value && typeof value === 'object') {
    for (const key of ['rich_text', 'caption']) extractRichTextLinks(value[key], pageId, location, links);
    if (type === 'table_row' && Array.isArray(value.cells)) value.cells.forEach((cell, index) => extractRichTextLinks(cell, pageId, `${location}/cell-${index + 1}`, links));
    if (type === 'link_to_page') {
      const target = notionTarget(value.page_id ?? value.database_id ?? value.data_source_id);
      if (target) links.push({ target, relation: 'link', evidence: `${location}: link_to_page`, source: 'block-link', from: pageId });
    }
    if (type === 'child_page' || type === 'child_database') {
      const target = notionTarget(block.id);
      if (target) links.push({ target, relation: 'child', evidence: `${location}: ${type}`, source: 'block-link', from: pageId });
    }
  }
}

function addWarning(page, warning) {
  if (!page.warnings.includes(warning)) page.warnings.push(warning);
  page.content_complete = false;
}

function makePage(raw, { source = 'notion-api', content = '', links = [], warnings = [], unsupported = [], contentComplete = false } = {}) {
  const id = notionTarget(raw?.id ?? raw?.url) ?? String(raw?.id ?? '');
  const normalizedLinks = links.filter((link) => link?.target).map((link) => ({
    ...link,
    target: notionTarget(link.target),
    from: link.from ?? id,
  }));
  return {
    id,
    title: pageTitle(raw),
    url: objectUrl(raw),
    source_path: sourcePath(raw),
    source_kind: source,
    last_edited_time: raw?.last_edited_time,
    content,
    properties: raw?.properties && typeof raw.properties === 'object' ? raw.properties : {},
    tags: [],
    aliases: [],
    kind: raw?.parent?.type === 'database_id' ? 'database-entry' : raw?.object === 'database' ? 'database' : 'page',
    parent: raw?.parent?.page_id ?? raw?.parent?.database_id ?? raw?.parent?.data_source_id ?? null,
    database: raw?.parent?.database_id ?? null,
    data_source: raw?.parent?.data_source_id ?? null,
    links: normalizedLinks,
    unsupported_features: [...new Set(unsupported)],
    warnings: [...new Set(warnings)],
    content_complete: Boolean(contentComplete),
    content_digest: digest(content),
  };
}

function requestStatusWarning(response) {
  if (response?.request_status?.type === 'incomplete') {
    const reason = response.request_status.incomplete_reason ?? 'unknown';
    return `request_incomplete:${reason}`;
  }
  return undefined;
}

function parseRetryAfter(response) {
  const header = response?.headers?.get?.('retry-after');
  const value = Number(header);
  return Number.isFinite(value) && value >= 0 ? value * 1000 : undefined;
}

function sleep(ms, signal) {
  ensureSignal(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (!signal) return;
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException('The operation was aborted', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

function fullUrl(baseUrl, pathOrUrl) {
  let base, target;
  try { base = new URL(baseUrl); target = new URL(pathOrUrl, `${baseUrl.replace(/\/$/u, '')}/`); }
  catch { throw new NotionError('Invalid Notion pagination URL', { code: 'invalid_pagination_url' }); }
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password ||
      target.origin !== base.origin || target.protocol !== base.protocol || target.username || target.password) {
    throw new NotionError('Notion pagination URL is outside the configured origin or contains credentials', { code: 'unsafe_pagination_url' });
  }
  return target.toString();
}

function joinQuery(pathname, query) {
  const url = new URL(pathname, 'https://notion.invalid');
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return `${url.pathname}${url.search}`;
}

export function createNotionClient({
  token = process.env.NOTION_TOKEN ?? process.env.NOTION_API_TOKEN,
  fetchImpl = globalThis.fetch,
  baseUrl = DEFAULT_BASE_URL,
  apiVersion = DEFAULT_VERSION,
  timeoutMs = 10000,
  maxRetries = 2,
  backoffMs = 100,
  sleepImpl = sleep,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  asPositiveInteger(timeoutMs, 'timeoutMs');
  asNonNegativeInteger(maxRetries, 'maxRetries', 2);
  asNonNegativeInteger(backoffMs, 'backoffMs', 100);
  const base = String(baseUrl).replace(/\/$/u, '');

  // Validate the caller-selected base before any token-bearing request.
  fullUrl(base, '/');
  async function request(pathOrUrl, { method = 'GET', body, signal } = {}) {
    if (!token) throw new NotionAuthError();
    ensureSignal(signal);
    const url = fullUrl(base, pathOrUrl);
    for (let attempt = 0; ; attempt += 1) {
      ensureSignal(signal);
      const controller = new AbortController();
      let rejectAbort;
      const aborted = new Promise((_resolve, reject) => { rejectAbort = reject; });
      const onAbort = () => {
        controller.abort();
        rejectAbort(new NotionError('Notion request cancelled', { code: 'request_cancelled' }));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => {
        controller.abort();
        rejectAbort(new NotionTimeoutError());
      }, timeoutMs);
      let response, payload, failure;
      try {
        const completed = await Promise.race([
          (async () => {
            const fetched = await fetchImpl(url, {
              method,
              headers: {
                Authorization: `Bearer ${token}`,
                'Notion-Version': apiVersion,
                ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
              },
              ...(body === undefined ? {} : { body: JSON.stringify(body) }),
              signal: controller.signal,
              redirect: 'error',
            });
            let data;
            try { data = await fetched.json(); }
            catch (error) {
              if (controller.signal.aborted || error?.name === 'AbortError') throw new NotionTimeoutError();
              if (fetched.ok) throw new NotionError('Notion returned an invalid JSON response', { code: 'invalid_json', status: fetched.status });
              data = {};
            }
            return { response: fetched, payload: data };
          })(),
          aborted,
        ]);
        response = completed.response;
        payload = completed.payload;
      } catch (error) {
        failure = signal?.aborted ? new NotionError('Notion request cancelled', { code: 'request_cancelled' })
          : error instanceof NotionError ? error
          : error?.name === 'AbortError' ? new NotionTimeoutError()
          : new NotionError('Notion network request failed', { code: 'network_error' });
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }
      if (failure) {
        if (!signal?.aborted && ['notion_timeout', 'network_error'].includes(failure.code) && attempt < maxRetries) {
          await sleepImpl(Math.min(30000, backoffMs * (2 ** attempt)), signal);
          continue;
        }
        throw failure;
      }
      if (response.ok) return payload;
      if (RETRYABLE_STATUSES.has(response.status) && attempt < maxRetries) {
        await sleepImpl(Math.min(30000, parseRetryAfter(response) ?? backoffMs * (2 ** attempt)), signal);
        continue;
      }
      // Server code/message fields are untrusted and must never become diagnostic strings.
      const code = `http_${response.status}`;
      throw new NotionError(`Notion request failed (HTTP ${response.status})`, {
        code, status: response.status, retryable: RETRYABLE_STATUSES.has(response.status),
      });
    }
  }

  async function paginated(path, { bodyFactory, method = 'GET', limit = Infinity, signal, maxPages = 1000 } = {}) {
    const pages = [];
    const warnings = [];
    let cursor;
    let nextCursor;
    const seen = new Set();
    let pageCount = 0;
    let response;
    while (pageCount < maxPages && pages.length < limit) {
      ensureSignal(signal);
      const body = bodyFactory ? bodyFactory(cursor) : undefined;
      const requestPath = method === 'GET' && cursor && !bodyFactory
        ? joinQuery(path, { start_cursor: cursor })
        : path;
      response = await request(requestPath, { method, body, signal });
      pageCount += 1;
      const result = Array.isArray(response?.results) ? response.results : [];
      if (!Array.isArray(response?.results)) warnings.push('pagination_missing_results');
      if (result.length > limit - pages.length) warnings.push('result_limit_reached');
      pages.push(...result.slice(0, Math.max(0, limit - pages.length)));
      const warning = requestStatusWarning(response);
      if (warning) warnings.push(warning);
      nextCursor = typeof response?.next_cursor === 'string' && response.next_cursor.trim() ? response.next_cursor : null;
      if (!response?.has_more) break;
      if (!nextCursor) { warnings.push('pagination_missing_cursor'); break; }
      if (seen.has(nextCursor)) {
        warnings.push('pagination_cursor_cycle');
        break;
      }
      seen.add(nextCursor);
      cursor = nextCursor;
    }
    if (pageCount >= maxPages && response?.has_more) warnings.push('pagination_limit_reached');
    if (Number.isFinite(limit) && pages.length >= limit && response?.has_more) warnings.push('result_limit_reached');
    return { results: pages, has_more: Boolean(response?.has_more || warnings.includes('result_limit_reached')), next_cursor: nextCursor ?? null, warnings };
  }

  async function search(query, { limit = 20, signal } = {}) {
    asPositiveInteger(limit, 'limit', 10000);
    const response = await paginated('/v1/search', {
      method: 'POST',
      limit,
      signal,
      bodyFactory: (cursor) => ({
        ...(query ? { query: String(query) } : {}),
        ...(cursor ? { start_cursor: cursor } : {}),
        page_size: Math.min(100, limit),
      }),
    });
    const pages = response.results.map((item) => ({
      id: notionTarget(item?.id),
      title: pageTitle(item),
      url: objectUrl(item),
      last_edited_time: item?.last_edited_time,
      object: item?.object,
      parent: item?.parent,
    })).filter((item) => item.id);
    return { pages, has_more: response.has_more, next_cursor: response.next_cursor, warnings: response.warnings };
  }

  async function fetchPropertyItems(pageId, propertyId, { signal, maxPages = 100 } = {}) {
    const results = [];
    const warnings = [];
    let cursor;
    let nextUrl;
    const seen = new Set();
    for (let count = 0; count < maxPages; count += 1) {
      const path = nextUrl ?? joinQuery(`/v1/pages/${encodeURIComponent(pageId)}/properties/${encodeURIComponent(propertyId)}`, cursor ? { start_cursor: cursor } : {});
      const response = await request(path, { signal });
      results.push(...(Array.isArray(response?.results) ? response.results : []));
      const warning = requestStatusWarning(response);
      if (warning) warnings.push(warning);
      const rawNextUrl = response?.next_url ?? response?.property_item?.next_url;
      const rawCursor = response?.next_cursor;
      nextUrl = typeof rawNextUrl === 'string' && rawNextUrl.trim() ? rawNextUrl : undefined;
      cursor = typeof rawCursor === 'string' && rawCursor.trim() ? rawCursor : undefined;
      if ((rawNextUrl != null && !nextUrl) || (rawCursor != null && !cursor)) { warnings.push('relation_property_invalid_cursor'); break; }
      if (!Array.isArray(response?.results)) warnings.push('relation_property_missing_results');
      if ((!response?.has_more && !nextUrl && !cursor)) break;
      if (response?.has_more && !nextUrl && !cursor) {
        warnings.push('relation_property_missing_cursor');
        break;
      }
      if ((nextUrl && seen.has(nextUrl)) || (cursor && seen.has(cursor))) {
        warnings.push('relation_property_cursor_cycle');
        break;
      }
      if (nextUrl) seen.add(nextUrl);
      if (cursor) seen.add(cursor);
    }
    if (nextUrl || cursor) warnings.push('relation_property_pagination_limit');
    return { results, warnings };
  }

  async function fetchPage(id, { maxBlocks = 1000, maxDepth = 20, signal } = {}) {
    asPositiveInteger(maxBlocks, 'maxBlocks');
    asNonNegativeInteger(maxDepth, 'maxDepth', 20);
    const pageId = notionTarget(id);
    if (!pageId) throw new TypeError('page id is required');
    const raw = await request(`/v1/pages/${encodeURIComponent(pageId)}`, { signal });
    const warnings = [];
    const unsupported = [];
    const links = extractRelationLinks(raw?.properties, pageId, warnings);
    const properties = raw?.properties && typeof raw.properties === 'object' ? structuredClone(raw.properties) : {};

    for (const [name, property] of Object.entries(properties)) {
      if (property?.type !== 'relation' || property.has_more !== true) continue;
      const propertyId = property.id ?? name;
      try {
        const complete = await fetchPropertyItems(pageId, propertyId, { signal });
        const relations = complete.results.map((item) => item.relation?.id).filter(Boolean).map((target) => ({ id: notionTarget(target) }));
        properties[name] = { ...property, relation: relations, has_more: Boolean(complete.warnings.length), property_items_complete: complete.warnings.length === 0 };
        for (const relation of relations) {
          const target = notionTarget(relation.id);
          links.push({ target, relation: relationLabel(name), evidence: `Property ${name} contains ${target}`, source: 'relation-property', from: pageId });
        }
        warnings.push(...complete.warnings);
        if (complete.warnings.length === 0) {
          const warningIndex = warnings.indexOf(`relation_property_truncated:${name}`);
          if (warningIndex >= 0) warnings.splice(warningIndex, 1);
        }
      } catch (error) {
        if (error instanceof NotionError && (error.status === 403 || error.status === 404)) {
          addWarning({ warnings, content_complete: true }, `relation_property_unavailable:${name}`);
          continue;
        }
        throw error;
      }
    }

    let blockCount = 0;
    const lines = [];
    async function walk(blockId, depth, location) {
      if (depth > maxDepth) {
        warnings.push('max_depth_reached');
        return;
      }
      let cursor;
      const seenCursors = new Set();
      while (blockCount < maxBlocks) {
        const path = joinQuery(`/v1/blocks/${encodeURIComponent(blockId)}/children`, cursor ? { start_cursor: cursor } : {});
        let response;
        try {
          response = await request(path, { signal });
        } catch (error) {
          if (error instanceof NotionError && (error.status === 403 || error.status === 404)) {
            warnings.push(`block_children_unavailable:${blockId}`);
            return;
          }
          throw error;
        }
        const warning = requestStatusWarning(response);
        if (warning) warnings.push(warning);
        if (response?.truncated === true) {
          warnings.push('block_subtree_truncated');
          for (const unknown of response.unknown_block_ids ?? []) warnings.push(`unknown_block:${unknown}`);
        }
        if (!Array.isArray(response?.results)) warnings.push('block_pagination_missing_results');
        for (const block of Array.isArray(response?.results) ? response.results : []) {
          if (blockCount >= maxBlocks) break;
          blockCount += 1;
          const childLocation = `${location}/${blockCount}`;
          extractBlockLinks(block, pageId, childLocation, links);
          const type = block?.type;
          if (!type || !SUPPORTED_TEXT_BLOCKS.has(type)) { unsupported.push(`block:${type || 'unknown'}`); warnings.push('unsupported_block_content'); }
          if (type === 'table_row' && (!Array.isArray(block.table_row?.cells) || block.table_row.cells.some(cell => !Array.isArray(cell)))) {unsupported.push('malformed-table-row');warnings.push('unsupported_block_content');}
          const text = blockText(block);
          if (text) lines.push(`${'  '.repeat(depth)}${text}`);
          if (block?.has_children && block?.id) await walk(block.id, depth + 1, childLocation);
        }
        if (blockCount >= maxBlocks) {
          warnings.push('max_blocks_reached');
          return;
        }
        const next = typeof response?.next_cursor === 'string' && response.next_cursor.trim() ? response.next_cursor : null;
        if (!response?.has_more) return;
        if (!next) {warnings.push(`block_pagination_missing_cursor:${blockId}`);return;}
        if (seenCursors.has(next)) {
          warnings.push(`block_pagination_cursor_cycle:${blockId}`);
          return;
        }
        seenCursors.add(next);
        cursor = next;
      }
    }
    await walk(pageId, 0, 'blocks');
    const rawWithProperties = { ...raw, properties };
    const page = makePage(rawWithProperties, {
      content: lines.join('\n'),
      links,
      warnings,
      unsupported,
      contentComplete: warnings.length === 0 && unsupported.length === 0,
    });
    page.block_count = blockCount;
    page.content_digest = digest(page.content);
    return page;
  }

  async function queryDataSource(id, { filter, sorts, pageSize = 100, limit = 10000, isArchived, signal } = {}) {
    const dataSourceId = notionTarget(id);
    if (!dataSourceId) throw new TypeError('data source id is required');
    asPositiveInteger(pageSize, 'pageSize', 100);
    asPositiveInteger(limit, 'limit', 10000);
    const response = await paginated(`/v1/data_sources/${encodeURIComponent(dataSourceId)}/query`, {
      method: 'POST',
      limit,
      signal,
      bodyFactory: (cursor) => ({
        ...(filter === undefined ? {} : { filter }),
        ...(sorts === undefined ? {} : { sorts }),
        ...(isArchived === undefined ? {} : { is_archived: Boolean(isArchived) }),
        page_size: Math.min(pageSize, 100),
        ...(cursor ? { start_cursor: cursor } : {}),
      }),
    });
    const pages = response.results.map((item) => makePage(item, {
      source: 'notion-api',
      content: '',
      contentComplete: false,
      warnings: ['content_not_fetched'],
    }));
    const incomplete = response.warnings.length > 0;
    return {
      data_source: dataSourceId,
      pages,
      has_more: response.has_more,
      next_cursor: response.next_cursor,
      incomplete,
      warnings: response.warnings,
      inventory_complete: false,
    };
  }

  async function snapshot({ pageIds = [], query, dataSourceIds = [], maxPages = 100, maxBlocks = 1000, maxDepth = 20, signal } = {}) {
    asPositiveInteger(maxPages, 'maxPages');
    asPositiveInteger(maxBlocks, 'maxBlocks');
    asNonNegativeInteger(maxDepth, 'maxDepth', 20);
    if (!Array.isArray(pageIds) || !Array.isArray(dataSourceIds)) throw new TypeError('pageIds and dataSourceIds must be arrays');
    const warnings = [];
    const incompleteReasons = [];
    const ids = [];
    const seen = new Set();
    let scopeLimited = false;
    let inventoryScope;
    if (pageIds.length > 0) {
      inventoryScope = { type: 'page_ids', requested: pageIds.map((id) => notionTarget(id)).filter(Boolean) };
      if (inventoryScope.requested.length > maxPages) scopeLimited = true;
      for (const id of pageIds) {
        const normalized = notionTarget(id);
        if (normalized && !seen.has(normalized)) { seen.add(normalized); ids.push(normalized); }
      }
    }
    if (query !== undefined) {
      inventoryScope = { type: 'search', query: String(query) };
      const searchResult = await search(query, { limit: Math.min(maxPages, 10000), signal });
      warnings.push(...searchResult.warnings);
      warnings.push('search_results_not_full_inventory');
      incompleteReasons.push('search_ranked');
      if (searchResult.has_more) scopeLimited = true;
      for (const item of searchResult.pages) if (!seen.has(item.id) && ids.length < maxPages) { seen.add(item.id); ids.push(item.id); }
    }
    for (const dataSourceId of dataSourceIds) {
      inventoryScope = { type: 'data_sources', ids: dataSourceIds.map((item) => notionTarget(item)).filter(Boolean) };
      const result = await queryDataSource(dataSourceId, { limit: maxPages, signal });
      warnings.push(...result.warnings);
      warnings.push('data_source_rows_not_full_inventory');
      incompleteReasons.push('data_source_scope');
      if (result.has_more) scopeLimited = true;
      for (const item of result.pages) if (!seen.has(item.id) && ids.length < maxPages) { seen.add(item.id); ids.push(item.id); }
    }
    if (!inventoryScope) {
      warnings.push('scope_required');
      incompleteReasons.push('no_scope');
      return {
        schema_version: 1,
        snapshot_id: `notion-${Date.now()}`,
        source_format: 'notion-api',
        inventory_complete: false,
        content_complete: false,
        inventory_scope: { type: 'none' },
        incomplete_reasons: incompleteReasons,
        warnings,
        pages: [],
      };
    }
    if (scopeLimited || ids.length > maxPages) {
      warnings.push('max_pages_reached');
      incompleteReasons.push('max_pages');
    }
    const pages = [];
    for (const id of ids.slice(0, maxPages)) {
      try {
        const page = await fetchPage(id, { maxBlocks, maxDepth, signal });
        pages.push(page);
        warnings.push(...page.warnings.map((warning) => `${id}:${warning}`));
        if (!page.content_complete) incompleteReasons.push(...page.warnings);
      } catch (error) {
        if (error instanceof NotionError && (error.status === 403 || error.status === 404)) {
          warnings.push(`${id}:page_unavailable`);
          incompleteReasons.push('page_unavailable');
          continue;
        }
        throw error;
      }
    }
    const contentComplete = pages.length > 0
      && pages.length === ids.slice(0, maxPages).length
      && pages.every((page) => page.content_complete);
    const explicitRequested = [...new Set(pageIds.map((id) => notionTarget(id)).filter(Boolean))];
    const explicitComplete = pageIds.length > 0 && query === undefined && dataSourceIds.length === 0
      && pages.length === explicitRequested.length
      && explicitRequested.length <= maxPages
      && pages.every((page) => page.content_complete);
    return {
      schema_version: 1,
      snapshot_id: `notion-${Date.now()}`,
      source_format: 'notion-api',
      inventory_complete: explicitComplete,
      content_complete: contentComplete,
      inventory_scope: inventoryScope,
      incomplete_reasons: [...new Set(incompleteReasons)],
      warnings: [...new Set(warnings)],
      pages,
    };
  }

  return Object.freeze({ search, fetchPage, queryDataSource, snapshot });
}

export async function notionSearch(query, options = {}) {
  return createNotionClient(options).search(query, options);
}

export async function notionSnapshot(options = {}) {
  return createNotionClient(options).snapshot(options);
}

export { canonicalUuid };
