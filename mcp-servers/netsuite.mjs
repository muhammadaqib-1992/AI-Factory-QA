#!/usr/bin/env node
// NetSuite MCP server — READ-ONLY backend access for test-data lookup and record-state checks.
// Auth: token-based authentication (OAuth 1.0a, HMAC-SHA256) from .env. Nothing here can
// create, update or delete a record: SuiteQL is SELECT-only and the REST calls are GETs.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { env, netsuiteAccount, netsuiteAppUrl } from '../lib/env.mjs';
import { oauth1Header } from '../lib/oauth1.mjs';

const MAX_ROWS = 1000;

function restBase() {
  return env('NS_REST_URL', `https://${netsuiteAccount().host}.suitetalk.api.netsuite.com`).replace(/\/+$/, '');
}

async function nsFetch(method, path, body) {
  const url = `${restBase()}${path}`;
  const headers = {
    Authorization: oauth1Header({
      method,
      url,
      consumerKey: env('NS_CONSUMER_KEY'),
      consumerSecret: env('NS_CONSUMER_SECRET'),
      token: env('NS_TOKEN_ID'),
      tokenSecret: env('NS_TOKEN_SECRET'),
      realm: netsuiteAccount().realm,
    }),
    Accept: 'application/json',
  };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    headers.Prefer = 'transient';
  }
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text.slice(0, 2000) };
  }
  if (!res.ok) {
    const detail = json?.['o:errorDetails']?.map((d) => d.detail).join(' | ') || json?.title || text.slice(0, 500);
    throw new Error(`NetSuite ${method} ${path} → HTTP ${res.status}: ${detail}`);
  }
  return json;
}

const ok = (data) => ({ content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] });
const fail = (err) => ({ isError: true, content: [{ type: 'text', text: String(err?.message || err) }] });

function assertReadOnlyQuery(q) {
  const stripped = q
    .replace(/--.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .trim();
  if (!/^(select|with)\b/i.test(stripped)) throw new Error('Only SELECT / WITH SuiteQL queries are allowed.');
  if (/;\s*\S/.test(stripped)) throw new Error('One statement per call.');
  return stripped.replace(/;\s*$/, '');
}

const server = new McpServer({ name: 'netsuite', version: '1.0.0' });

server.registerTool(
  'suiteql',
  {
    title: 'Run a SuiteQL query (read-only)',
    description:
      'Runs a SELECT SuiteQL query against the NetSuite account in NS_ACCOUNT_ID and returns the rows. ' +
      'Use it to find test data and to verify record state after a UI action. Always filter and keep ' +
      'the row limit small. Field ids: look them up with record_metadata first rather than guessing.',
    inputSchema: {
      query: z.string().describe('A single SELECT (or WITH … SELECT) SuiteQL statement.'),
      limit: z.number().int().min(1).max(MAX_ROWS).default(50).describe('Max rows to return.'),
      offset: z.number().int().min(0).default(0),
    },
  },
  async ({ query, limit, offset }) => {
    try {
      const q = assertReadOnlyQuery(query);
      const data = await nsFetch('POST', `/services/rest/query/v1/suiteql?limit=${limit}&offset=${offset}`, { q });
      const items = (data.items || []).map(({ links, ...row }) => row);
      return ok({
        account: netsuiteAccount().host,
        count: data.count,
        totalResults: data.totalResults,
        hasMore: data.hasMore,
        rows: items,
      });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'get_record',
  {
    title: 'Read one record',
    description:
      'Reads a single NetSuite record through the REST Record API, e.g. type "salesorder", "customer", ' +
      '"customrecord_xyz". Set expandSubResources to include sublists (lines). Read-only.',
    inputSchema: {
      type: z.string().describe('Record type id, e.g. salesorder, invoice, customer, customrecord_abc.'),
      id: z.string().describe('Internal id of the record.'),
      expandSubResources: z.boolean().default(false),
      fields: z.array(z.string()).optional().describe('Only return these body fields.'),
    },
  },
  async ({ type, id, expandSubResources, fields }) => {
    try {
      if (!/^[a-z0-9_]+$/i.test(type) || !/^[0-9A-Za-z_-]+$/.test(id)) throw new Error('Invalid record type or id.');
      const qs = new URLSearchParams();
      if (expandSubResources) qs.set('expandSubResources', 'true');
      if (fields?.length) qs.set('fields', fields.join(','));
      const data = await nsFetch('GET', `/services/rest/record/v1/${type}/${id}${qs.size ? `?${qs}` : ''}`);
      return ok({
        account: netsuiteAccount().host,
        // Any transaction opens at transaction.nl?id=; other types need their own UI path.
        transactionUiUrl: `${netsuiteAppUrl()}/app/accounting/transactions/transaction.nl?id=${id}`,
        record: data,
      });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'record_metadata',
  {
    title: 'Describe a record type',
    description:
      'Returns the field list (ids, labels, types) of a record type from the metadata catalog, so queries ' +
      'use real field ids. Custom fields (custbody_/custcol_/custentity_) show up here too.',
    inputSchema: { type: z.string().describe('Record type id, e.g. salesorder.') },
  },
  async ({ type }) => {
    try {
      if (!/^[a-z0-9_]+$/i.test(type)) throw new Error('Invalid record type.');
      const data = await nsFetch('GET', `/services/rest/record/v1/metadata-catalog/${type}`);
      const props = data.properties || {};
      const fields = Object.entries(props).map(([id, p]) => ({
        id,
        label: p.title,
        type: p.type || p.format || (p.$ref ? 'reference' : undefined),
      }));
      return ok({ type, fieldCount: fields.length, fields });
    } catch (e) {
      return fail(e);
    }
  },
);

await server.connect(new StdioServerTransport());
