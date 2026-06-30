// REB RUN — Moteur d'actualisation (V1 + extension OMS)
// Deux sources désormais automatisées pour Ebola Bundibugyo :
//   1. CDC — Situation Summary (page unique, toujours "à jour")
//   2. OMS — Disease Outbreak News (bulletins numérotés ; la liste OMS n'est pas
//      lisible directement — son contenu est chargé en JavaScript après coup —
//      on sonde donc les numéros de bulletin (DONxxx) à la suite du dernier connu,
//      et on ne retient que ceux qui mentionnent "Bundibugyo").
//
// Logique commune : extraire un motif numérique daté, comparer à la valeur déjà
// publiée, et appliquer la règle retenue au cadrage : "le bilan le plus récent gagne".

import { readFile, writeFile } from 'node:fs/promises';

const DATA_PATH = new URL('../donnees.json', import.meta.url);
const TIMEOUT_MS = 15000;
const CDC_URL = 'https://www.cdc.gov/ebola/situation-summary/index.html';
const WHO_DON_PROBE_AHEAD = 20; // nombre de bulletins à sonder après le dernier connu

function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseFrDate(d) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(d || '');
  if (!m) return null;
  return new Date(+m[3], +m[2] - 1, +m[1]);
}

function parseEnDate(d) {
  // "17 June 2026" -> Date
  const t = Date.parse(d);
  return isNaN(t) ? null : new Date(t);
}

async function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

function nowStampFR() {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${dd}/${mm} · ${hh}:${mi}`;
}

function applyIfNewer(data, key, candidateDate, candidateCas, candidateDec, sourceLabel) {
  const current = data.cases[key] || {};
  const currentDate = parseFrDate(current.date);
  const isNewer = !currentDate || (candidateDate && candidateDate > currentDate);
  if (isNewer) {
    const dd = String(candidateDate.getDate()).padStart(2, '0');
    const mm = String(candidateDate.getMonth() + 1).padStart(2, '0');
    data.cases[key] = {
      cas: candidateCas,
      dec: candidateDec ?? current.dec ?? null,
      date: `${dd}/${mm}/${candidateDate.getFullYear()}`,
      source: sourceLabel,
    };
  }
  return isNewer;
}

// ── Source 1 : CDC ────────────────────────────────────────────────────────────
async function checkCDC(data) {
  try {
    const r = await fetchWithTimeout(CDC_URL, TIMEOUT_MS);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = stripTags(await r.text());
    const m = text.match(/(?:As of|By)\s+([A-Z][a-z]+ \d{1,2}(?:, \d{4})?)[^.]{0,160}?([\d,]{3,8})\s*(?:confirmed\s+)?cases[^.]{0,80}/i);
    if (!m) return { source: 'CDC', auto: true, what: `Échec d'extraction sur CDC (Ebola Bundibugyo) — motif non trouvé.` };

    const quote = m[0].trim();
    const dateRaw = m[1].includes(',') ? m[1] : `${m[1]}, 2026`;
    const d = parseEnDate(dateRaw);
    const applied = d ? applyIfNewer(data, 'ebola_bdb|Dem. Rep. Congo', d, m[2], null, `CDC Situation Summary (auto) — "${m[1]}"`) : false;
    return { source: 'CDC', auto: true, what: applied
      ? `Ebola Bundibugyo / RDC mis à jour via CDC : ≈ ${m[2]} cas (${m[1]}).`
      : `CDC vérifié pour Ebola Bundibugyo — valeur déjà publiée toujours la plus récente.` };
  } catch (err) {
    return { source: 'CDC', auto: true, what: `Échec de connexion à CDC (${err.message || err}).` };
  }
}

// ── Source 2 : OMS — sonde les bulletins DON suivants, retient ceux sur Bundibugyo
async function checkWHO(data) {
  const startFrom = (data.meta && data.meta.who_last_don) || 600;
  let lastChecked = startFrom;
  let bestMatch = null;

  for (let n = startFrom; n <= startFrom + WHO_DON_PROBE_AHEAD; n++) {
    const url = `https://www.who.int/emergencies/disease-outbreak-news/item/2026-DON${n}`;
    try {
      const r = await fetchWithTimeout(url, TIMEOUT_MS);
      if (!r.ok) continue; // bulletin pas encore publié
      lastChecked = n;
      const text = stripTags(await r.text());
      if (!/Bundibugyo/i.test(text)) continue; // bulletin sur un autre pathogène
      const m = text.match(/As of\s+(\d{1,2}\s+\w+\s+\d{4}),?\s+a total of\s+([\d,]{2,8})\s+confirmed cases(?:[^.]*?including\s+([\d,]{2,8})\s+deaths)?/i);
      if (m) bestMatch = { n, quote: m[0].trim(), date: m[1], cas: m[2], dec: m[3] || null, url };
    } catch (e) { /* timeout ou réseau : on continue le sondage */ }
  }

  // Mémorise jusqu'où on a sondé, pour repartir de là la prochaine fois
  data.meta = data.meta || {};
  data.meta.who_last_don = lastChecked;

  if (!bestMatch) {
    return { source: 'OMS', auto: true, what: `Aucun nouveau bulletin OMS (DON) sur Ebola Bundibugyo depuis le dernier sondage (jusqu'à DON${lastChecked}).` };
  }

  const d = parseEnDate(bestMatch.date);
  const applied = d ? applyIfNewer(data, 'ebola_bdb|Dem. Rep. Congo', d, bestMatch.cas, bestMatch.dec, `OMS DON${bestMatch.n} (auto) — ${bestMatch.date}`) : false;
  return { source: 'OMS', auto: true, what: applied
    ? `Ebola Bundibugyo / RDC mis à jour via OMS DON${bestMatch.n} : ${bestMatch.cas} cas${bestMatch.dec ? `, ${bestMatch.dec} décès` : ''} (${bestMatch.date}).`
    : `OMS DON${bestMatch.n} vérifié (${bestMatch.date}) — valeur déjà publiée toujours la plus récente.` };
}

async function main() {
  const raw = await readFile(DATA_PATH, 'utf8');
  const data = JSON.parse(raw);
  data.updates = data.updates || [];
  data.cases = data.cases || {};

  console.log('[REB RUN] Vérification CDC…');
  const cdcLog = await checkCDC(data);
  console.log('[REB RUN]', cdcLog.what);

  console.log('[REB RUN] Vérification OMS (sondage des bulletins DON)…');
  const whoLog = await checkWHO(data);
  console.log('[REB RUN]', whoLog.what);

  const stamp = nowStampFR();
  data.updates = [
    { date: stamp, auto: true, what: whoLog.what, src: 'OMS' },
    { date: stamp, auto: true, what: cdcLog.what, src: 'CDC' },
    ...data.updates,
  ].slice(0, 30);

  await writeFile(DATA_PATH, JSON.stringify(data, null, 2) + '\n', 'utf8');
  console.log('[REB RUN] donnees.json mis à jour.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
