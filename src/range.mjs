export const CHUNK = 512 * 1024;
export const CAP = 512 * 1024;

export function parseRange(range, size) {
  if (!Number.isSafeInteger(size) || size < 1) throw new Error('Tamanho total invalido');
  if (!range) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/i.exec(String(range).trim());
  if (!match || (!match[1] && !match[2])) return null;
  let start, end;
  if (!match[1]) {
    const count = Number(match[2]);
    if (!Number.isSafeInteger(count) || count <= 0) return null;
    start = Math.max(0, size - count);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) return null;
    end = Math.min(end, size - 1);
  }
  // Teto proposital do piloto. Respostas 206 podem ser menores que o intervalo pedido.
  return { start, end: Math.min(end, start + CAP - 1), partial: true };
}

export function validateManifest(value) {
  const m = typeof value === 'string' ? JSON.parse(value) : value;
  if (!m || typeof m !== 'object' || !Array.isArray(m.parts) || m.parts.length < 1 || m.parts.length > 64) {
    throw new Error('Manifesto: parts ausente/invalido');
  }
  let offset = 0;
  const parts = m.parts.map((p, i) => {
    if (!p || typeof p !== 'object' || !Number.isSafeInteger(p.messageId) || p.messageId < 1 || !Number.isSafeInteger(p.size) || p.size < 1 || p.size > 536870912) {
      throw new Error('Manifesto: parte invalida ' + i);
    }
    const channel = String(p.channel || '').trim();
    const accessHash = String(p.accessHash || '').trim();
    if (!/^@[A-Za-z0-9_]{5,32}$/.test(channel) && !(/^-100\d{5,20}$/.test(channel) && /^-?\d{1,22}$/.test(accessHash))) {
      throw new Error('Manifesto: canal invalido ' + i);
    }
    const out = { channel, accessHash, messageId: p.messageId, size: p.size, offset };
    offset += p.size;
    return out;
  });
  if (!Number.isSafeInteger(offset) || offset < 1 || offset > 32 * 1024 * 1024 * 1024) throw new Error('Manifesto: tamanho invalido');
  const filename = String(m.filename || 'video.mp4');
  if (!/^[a-zA-Z0-9._-]{1,160}\.mp4$/i.test(filename)) throw new Error('Manifesto: nome invalido');
  return { filename, size: offset, parts };
}

export function segmentsForRange(manifest, start, end) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= manifest.size) throw new Error('Intervalo invalido');
  const ret = [];
  for (const part of manifest.parts) {
    const globalEnd = part.offset + part.size - 1;
    if (globalEnd < start || part.offset > end) continue;
    const s = Math.max(start, part.offset);
    const e = Math.min(end, globalEnd);
    ret.push({ part, start: s - part.offset, end: e - part.offset });
  }
  if (ret.reduce((n, x) => n + x.end - x.start + 1, 0) !== end - start + 1) throw new Error('Intervalo com lacunas');
  return ret;
}
