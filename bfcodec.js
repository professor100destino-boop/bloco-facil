/* Bloco Fácil — codificação dos dados trocados entre a extensão e o celular.
 * Tudo vai dentro do QR Code / do código; nada passa por servidor.
 */
(function (root) {
  'use strict';

  function b64urlFromBytes(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function bytesFromB64url(s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const bin = atob(s), out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  async function pipe(bytes, stream) {
    const rs = new Blob([bytes]).stream().pipeThrough(stream);
    return new Uint8Array(await new Response(rs).arrayBuffer());
  }

  /** objeto -> texto compacto (z = comprimido, j = sem compressão) */
  async function pack(obj) {
    const raw = new TextEncoder().encode(JSON.stringify(obj));
    if (typeof CompressionStream !== 'undefined') {
      try { return 'z' + b64urlFromBytes(await pipe(raw, new CompressionStream('deflate-raw'))); } catch (e) { /* segue */ }
    }
    return 'j' + b64urlFromBytes(raw);
  }
  async function unpack(txt) {
    txt = String(txt || '').trim();
    const kind = txt[0], body = txt.slice(1);
    let bytes = bytesFromB64url(body);
    if (kind === 'z') bytes = await pipe(bytes, new DecompressionStream('deflate-raw'));
    else if (kind !== 'j') throw new Error('Código inválido');
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  /** nome de disciplina normalizado para comparar ("História" == "HISTORIA") */
  function normDisc(s) {
    return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
  }

  const RESULT_PREFIX = 'BF1:';

  root.BFCodec = { pack, unpack, normDisc, RESULT_PREFIX };
})(typeof window !== 'undefined' ? window : globalThis);
