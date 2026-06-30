// REB RUN — Moteur d'actualisation (V1 + extensions OMS, ECDC, Africa CDC, ESCMID)
// Cinq sources désormais automatisées pour Ebola Bundibugyo :
//   1. CDC — Situation Summary (page unique, toujours "à jour")
//   2. OMS — Disease Outbreak News (bulletins numérotés ; la liste OMS n'est pas
//      lisible directement — son contenu est chargé en JavaScript après coup —
//      on sonde donc les numéros de bulletin (DONxxx) à la suite du dernier connu,
//      et on ne retient que ceux qui mentionnent "Bundibugyo").
//   3. ECDC — page de suivi dédiée à ce foyer (mise à jour ~2×/semaine), notre
//      source de référence actuelle pour les chiffres déjà publiés.
//   4. Africa CDC — page de référence ; phrasé moins homogène d'un rapport à
//      l'autre. Garde-fou explicite : si la phrase mélange cas confirmés et décès
//      "suspected"/"probable", l'extraction est REJETÉE plutôt que publiée — on
//      préfère "pas de mise à jour" à "mise à jour avec la mauvaise statistique".
//   5. ESCMID Epi Alert — bulletin scientifique (ESCMID + Centre de médecine
//      tropicale d'Amsterdam), phrasé structuré et fiable.
//
// Important : ce script tourne CÔTÉ SERVEUR (Node, via la tâche planifiée GitHub
// Actions). Le blocage CORS rencontré dans le prototype navigateur (ECDC, Africa
// CDC, Santé publique France) ne s'applique PAS ici — un serveur peut interroger
// n'importe quelle de ces pages sans restriction.
//
// Santé publique France n'est PAS automatisée : leur page Ebola est une page de
// doctrine/conduite à tenir, pas un compteur de cas chiffré (ils renvoient aux
// ministères RDC/Ouganda pour les chiffres) — on la garde en source contextuelle,
// vérifiée manuellement, conformément à la règle du cadrage ("automatique sur le
// structuré, manuel pour le reste").
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

// ── Source 3 : ECDC — page de suivi dédiée, mise à jour hebdomadaire (~chaque mardi/jeudi)
// Pas bloquée par CORS ici : ce script tourne côté serveur (Node), pas dans un navigateur.
async function checkECDC(data) {
  const url = 'https://www.ecdc.europa.eu/en/ebola-outbreak-democratic-republic-congo-and-uganda';
  try {
    const r = await fetchWithTimeout(url, TIMEOUT_MS);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = stripTags(await r.text());
    const m = text.match(/On\s+(\d{1,2}\s+[A-Za-z]+),?\s+the\s+DRC\s+Ministry\s+of\s+Health\s+reported\s+a\s+total\s+of\s+([\d,\s]{3,10})\s+confirmed\s+cases,?\s+including\s+([\d,\s]{2,8})\s+confirmed\s+related\s+deaths/i);
    if (!m) return { source: 'ECDC', auto: true, what: `Échec d'extraction sur ECDC (Ebola Bundibugyo) — motif non trouvé.` };

    const quote = m[0].trim();
    const dateRaw = `${m[1]}, 2026`; // ECDC omet l'année dans cette phrase
    const cas = m[2].replace(/[^\d]/g, '');
    const dec = m[3].replace(/[^\d]/g, '');
    const d = parseEnDate(dateRaw);
    const applied = d ? applyIfNewer(data, 'ebola_bdb|Dem. Rep. Congo', d, cas, dec, `ECDC (auto) — "${m[1]}"`) : false;
    return { source: 'ECDC', auto: true, what: applied
      ? `Ebola Bundibugyo / RDC mis à jour via ECDC : ${cas} cas, ${dec} décès (${m[1]}).`
      : `ECDC vérifié pour Ebola Bundibugyo — valeur déjà publiée toujours la plus récente.` };
  } catch (err) {
    return { source: 'ECDC', auto: true, what: `Échec de connexion à ECDC (${err.message || err}).` };
  }
}

// ── Source 4 : Africa CDC — page de référence (texte moins structuré, motif souple)
// Avertissement assumé : les rapports Africa CDC sont publiés sur des URLs datées
// au format peu cohérent (fautes de frappe observées dans leurs propres liens) —
// on se limite donc à leur page de référence fixe, avec repli silencieux si le
// motif n'est pas trouvé (pas d'erreur bloquante).
async function checkAfricaCDC(data) {
  const url = 'https://africacdc.org/download/situation-report-bundibugyo-virus-disease-outbreak-in-the-drc-and-uganda/';
  try {
    const r = await fetchWithTimeout(url, TIMEOUT_MS);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = stripTags(await r.text());
    const re = /[Aa]s of\s+([A-Za-z]+\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+[A-Za-z]+\s+\d{4})[\s\S]{0,90}?(\d{1,8})\s+confirmed(?:\s+B?VD)?\s+cases([\s\S]{0,60}?)(\d{1,8})\s+(?:confirmed\s+)?deaths/i;
    const m = text.match(re);
    // Garde-fou : si "suspected"/"probable" apparaît entre le nombre de cas et le nombre de décès,
    // le chiffre de décès capturé risque de désigner des décès SUSPECTS, pas confirmés — on rejette
    // plutôt que de publier une valeur potentiellement fausse.
    const between = m ? m[3] : '';
    if (!m || /suspect|probable/i.test(between)) {
      return { source: 'Africa CDC', auto: true, what: m
        ? `Motif trouvé sur Africa CDC mais ambigu (mélange cas confirmés / décès suspects dans la phrase) — rejeté par prudence, vérification manuelle recommandée.`
        : `Aucun motif numérique exploitable trouvé sur Africa CDC (format de page variable) — vérification manuelle recommandée.` };
    }

    const cas = m[2].replace(/[^\d]/g, '');
    const dec = m[4].replace(/[^\d]/g, '');
    const d = parseEnDate(m[1]);
    const applied = d ? applyIfNewer(data, 'ebola_bdb|Dem. Rep. Congo', d, cas, dec, `Africa CDC (auto) — ${m[1]}`) : false;
    return { source: 'Africa CDC', auto: true, what: applied
      ? `Ebola Bundibugyo / RDC mis à jour via Africa CDC : ${cas} cas, ${dec} décès (${m[1]}).`
      : `Africa CDC vérifié pour Ebola Bundibugyo — valeur déjà publiée toujours la plus récente.` };
  } catch (err) {
    return { source: 'Africa CDC', auto: true, what: `Échec de connexion à Africa CDC (${err.message || err}).` };
  }
}

// ── Source 5 : ESCMID Epi Alert — bulletin scientifique structuré
// "X confirmed cases and Y deaths reported ... as of DATE" — la date arrive APRÈS
// les chiffres (contrairement aux autres sources), d'où un motif dédié.
async function checkESCMID(data) {
  const url = 'https://www.escmid.org/science-research/emerging-infections/epi-alert/';
  try {
    const r = await fetchWithTimeout(url, TIMEOUT_MS);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = stripTags(await r.text());
    const m = text.match(/(\d{1,8})\s+confirmed cases and\s+(\d{1,8})\s+deaths reported[\s\S]{0,80}?as of\s+(\d{1,2}\s+[A-Za-z]+\s+\d{4})/i);
    if (!m) return { source: 'ESCMID', auto: true, what: `Échec d'extraction sur ESCMID Epi Alert (Ebola Bundibugyo) — motif non trouvé.` };

    const cas = m[1].replace(/[^\d]/g, '');
    const dec = m[2].replace(/[^\d]/g, '');
    const d = parseEnDate(m[3]);
    const applied = d ? applyIfNewer(data, 'ebola_bdb|Dem. Rep. Congo', d, cas, dec, `ESCMID Epi Alert (auto) — ${m[3]}`) : false;
    return { source: 'ESCMID', auto: true, what: applied
      ? `Ebola Bundibugyo / RDC mis à jour via ESCMID Epi Alert : ${cas} cas, ${dec} décès (${m[3]}).`
      : `ESCMID Epi Alert vérifié pour Ebola Bundibugyo — valeur déjà publiée toujours la plus récente.` };
  } catch (err) {
    return { source: 'ESCMID', auto: true, what: `Échec de connexion à ESCMID Epi Alert (${err.message || err}).` };
  }
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

  console.log('[REB RUN] Vérification ECDC…');
  const ecdcLog = await checkECDC(data);
  console.log('[REB RUN]', ecdcLog.what);

  console.log('[REB RUN] Vérification Africa CDC…');
  const acdcLog = await checkAfricaCDC(data);
  console.log('[REB RUN]', acdcLog.what);

  console.log('[REB RUN] Vérification ESCMID Epi Alert…');
  const escmidLog = await checkESCMID(data);
  console.log('[REB RUN]', escmidLog.what);

  const stamp = nowStampFR();
  data.updates = [
    { date: stamp, auto: true, what: escmidLog.what, src: 'ESCMID' },
    { date: stamp, auto: true, what: acdcLog.what, src: 'Africa CDC' },
    { date: stamp, auto: true, what: ecdcLog.what, src: 'ECDC' },
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
