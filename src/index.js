/**
 * TeleDrive | PILOTO DE VIDEO DIRETO Telegram MTProto -> Cloudflare Worker.
 * Nenhuma requisicao de video para a VPS. Sem credenciais no cliente.
 * Requer npm/Wrangler + Durable Object; NAO basta colar no editor online.
 */
import { DurableObject } from 'cloudflare:workers';
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions';
import bigInt from 'big-integer';
import { CHUNK, parseRange, validateManifest, segmentsForRange } from './range.mjs';

function replyJSON(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
}
function isAdmin(req, env) {
  return typeof env.TEST_ACCESS_KEY === 'string' && env.TEST_ACCESS_KEY.length >= 32 && req.headers.get('X-Test-Key') === env.TEST_ACCESS_KEY;
}
function authVideo(path, env) {
  const key = env.VIDEO_ACCESS_KEY;
  return typeof key === 'string' && /^[a-zA-Z0-9_-]{32,128}$/.test(key) && path === `/v/${key}.mp4`;
}
function cleanError(error) {
  const code = String(error?.errorMessage || '');
  if (/^(FLOOD_WAIT_\d+|FILE_REFERENCE_EXPIRED|FILE_REFERENCE_INVALID|FILE_MIGRATE_\d+|AUTH_KEY_UNREGISTERED|BOT_METHOD_INVALID)$/.test(code)) return code;
  return 'Falha na leitura MTProto. Consulte os logs do Worker.';
}
function buildHeaders(manifest, start, end, partial) {
  const h = new Headers({
    'content-type': 'video/mp4',
    'content-length': String(end - start + 1),
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-teledrive-source': 'telegram-mtproto-worker',
    'access-control-allow-origin': '*',
    'access-control-expose-headers': 'Content-Length,Content-Range,Accept-Ranges,X-TeleDrive-Source',
    'content-disposition': `inline; filename="${manifest.filename}"`,
  });
  if (partial) h.set('content-range', `bytes ${start}-${end}/${manifest.size}`);
  return h;
}
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;
    if (path === '/health') return replyJSON({ ok: true, project: 'teledrive-mtproto-direct-video', video: 'configurado-em-secret' });
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: {
      'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, HEAD, OPTIONS',
      'access-control-allow-headers': 'Range, X-Test-Key', 'access-control-max-age': '3600',
    }});
    if (!['GET', 'HEAD'].includes(req.method)) return replyJSON({ ok: false, error: 'Metodo nao permitido' }, 405);
    const video = authVideo(path, env);
    const admin = isAdmin(req, env);
    if (!video && !admin) return replyJSON({ ok: false, error: 'Nao autorizado' }, 401);
    if (!video && !['/probe', '/bytes'].includes(path)) return replyJSON({ ok: false, error: 'Rota inexistente' }, 404);
    if (video && url.search !== '') return replyJSON({ ok: false, error: 'Parametro nao permitido' }, 400);
    const id = env.MTPROTO_DO.idFromName('bot-piloto-01');
    // Encaminha corpo de resposta em streaming sem passar pela VPS.
    return env.MTPROTO_DO.get(id).fetch(req);
  },
};

export class MtprotoPiloto extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.client = null;
    this.connectPromise = null;
    this.cachedManifest = null;
    this.documentCache = new Map();
  }
  manifest() {
    if (!this.cachedManifest) this.cachedManifest = validateManifest(this.env.TG_VIDEO_MANIFEST_JSON);
    return this.cachedManifest;
  }
  async getClient() {
    if (this.client) return this.client;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.connect();
    try { return await this.connectPromise; } finally { this.connectPromise = null; }
  }
  async connect() {
    const id = Number(this.env.TG_API_ID);
    const hash = String(this.env.TG_API_HASH || '');
    const token = String(this.env.TG_BOT_TOKEN || '');
    if (!Number.isSafeInteger(id) || id < 1 || !/^[0-9a-f]{32}$/i.test(hash) || !/^\d+:[A-Za-z0-9_-]+$/.test(token)) {
      throw new Error('Credenciais MTProto nao configuradas');
    }
    const saved = String(await this.ctx.storage.get('botStringSession') || '');
    const client = new TelegramClient(new StringSession(saved), id, hash, {
      connectionRetries: 1, requestRetries: 1, autoReconnect: false, useWSS: false, timeout: 15000,
    });
    // GramJS em Workers depende de nodejs_compat e conexoes TCP de saida.
    await client.start({ botAuthToken: token });
    const who = await client.getMe();
    if (!who?.bot) throw new Error('A conta MTProto nao e bot');
    const session = client.session.save();
    if (typeof session === 'string' && session !== saved) await this.ctx.storage.put('botStringSession', session);
    this.client = client;
    return client;
  }
  async document(client, part) {
    const cacheKey = `${part.channel}:${part.messageId}`;
    const cacheEntry = this.documentCache.get(cacheKey);
    if (cacheEntry && cacheEntry.expires > Date.now()) return cacheEntry.doc;
    let channel;
    if (part.channel.startsWith('@')) {
      const peer = await client.getInputEntity(part.channel);
      channel = new Api.InputChannel({ channelId: peer.channelId, accessHash: peer.accessHash });
    } else {
      channel = new Api.InputChannel({
        channelId: bigInt(part.channel.slice(4)), accessHash: bigInt(part.accessHash),
      });
    }
    const result = await client.invoke(new Api.channels.GetMessages({
      channel, id: [new Api.InputMessageID({ id: part.messageId })],
    }));
    const msg = result?.messages?.find(x => x?.id === part.messageId);
    const doc = msg?.media?.document;
    if (!(doc instanceof Api.Document)) throw new Error('Mensagem nao contem documento');
    const actual = Number(doc.size?.toString?.() ?? doc.size);
    if (actual !== part.size) throw new Error('Tamanho do documento difere do manifesto');
    this.documentCache.set(cacheKey, { doc, expires: Date.now() + 4 * 60_000 });
    return doc;
  }
  async *readDocument(client, doc, start, end) {
    // Cada consulta usa <=512KiB; em seek desalinhado descartamos apenas bytes locais.
    const aligned = Math.floor(start / CHUNK) * CHUNK;
    const needed = end - aligned + 1;
    const chunks = Math.ceil(needed / CHUNK);
    let offset = aligned;
    let delivered = 0;
    const wanted = end - start + 1;
    for await (const raw of client.iterDownload({
      file: doc, offset: bigInt(aligned), requestSize: CHUNK, chunkSize: CHUNK, limit: chunks,
    })) {
      const b = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
      const from = Math.max(0, start - offset);
      const take = Math.min(b.byteLength - from, wanted - delivered);
      if (take > 0) { delivered += take; yield b.subarray(from, from + take); }
      offset += b.byteLength;
      if (delivered === wanted) break;
    }
    if (delivered !== wanted) throw new Error('Download Telegram incompleto');
  }
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    const video = authVideo(path, this.env);
    if (!video && !isAdmin(req, this.env)) return replyJSON({ error: 'Nao autorizado' }, 401);
    try {
      const manifest = this.manifest();
      if (path === '/probe') {
        const client = await this.getClient();
        // Validamos todas as partes existentes antes de iniciar a reproducao.
        for (const part of manifest.parts) await this.document(client, part);
        return replyJSON({ ok: true, size: manifest.size, parts: manifest.parts.length, video: 'ready', source: 'telegram-mtproto' });
      }
      if (path !== '/bytes' && !video) return replyJSON({ error: 'Rota inexistente' }, 404);
      const ranged = parseRange(req.headers.get('range') || (path === '/bytes' ? 'bytes=0-65535' : null), manifest.size);
      if (!ranged) return new Response(null, { status: 416, headers: {
        'content-range': `bytes */${manifest.size}`, 'content-length': '0', 'accept-ranges': 'bytes',
        'access-control-allow-origin': '*', 'cache-control': 'no-store',
      }});
      const { start, end, partial } = ranged;
      const headers = buildHeaders(manifest, start, end, partial);
      if (req.method === 'HEAD') return new Response(null, { status: partial ? 206 : 200, headers });
      const client = await this.getClient();
      const segments = segmentsForRange(manifest, start, end);
      const self = this;
      async function* bytes() {
        for (const seg of segments) {
          const doc = await self.document(client, seg.part);
          yield* self.readDocument(client, doc, seg.start, seg.end);
        }
      }
      // ReadableStream entrega dados gradualmente, sem manter o MP4 na memoria.
      const iterator = bytes();
      const body = new ReadableStream({
        async pull(controller) {
          try {
            const result = await iterator.next();
            if (result.done) controller.close();
            else controller.enqueue(result.value);
          } catch (error) { console.error('Erro no stream MTProto', error?.name || 'Error'); controller.error(error); }
        },
        async cancel() { if (typeof iterator.return === 'function') await iterator.return(); },
      });
      return new Response(body, { status: partial ? 206 : 200, headers });
    } catch (error) {
      console.error('Falha Worker MTProto:', error?.name || 'Error', String(error?.errorMessage || '').slice(0, 60));
      return replyJSON({ ok: false, error: cleanError(error) }, 502);
    }
  }
}
