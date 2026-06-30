// REB RUN — Moteur d'actualisation (V1)
// Périmètre volontairement minimal, conforme au cadrage : UNE source / UN pathogène
// pour prouver le principe de bout en bout : CDC Situation Summary -> Ebola Bundibugyo.
//
// Ce script reprend EXACTEMENT la logique déjà testée et validée dans le prototype
// navigateur ("Moteur d'actualisation - Prototype.dc.html") : connexion, lecture,
// extraction par motif, comparaison "le plus récent gagne", écriture du résultat.
// Seule différence : il tourne ici côté serveur (Node.js), donc PAS bloqué par CORS —
// c'est la "brique serveur" du document de cadrage.
//
// Exécuté chaque jour par .github/workflows/update-reb.yml (tâche planifiée GitHub Actions).

import { readFile, writeFile } from 'node:fs/promises';

const DATA_PATH = new URL('../donnees.json', import.meta.url);
const SOURCE_URL = 'https://www.cdc.gov/ebola/situation-summary/index.html';
const TIMEOUT_MS = 15000;

function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseFrDate(d) {
  // "24/06/2026" -> Date
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(d || '');
  if (!m) return null;
  return new Date(+m[3], +m[2] - 1, +m[1]);
}

async function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    return r;
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

async function main() {
  const raw = await readFile(DATA_PATH, 'utf8');
  const data = JSON.parse(raw);
  data.updates = data.updates || [];
  data.cases = data.cases || {};

  let logEntry;

  try {
    console.log(`[REB RUN] Connexion à ${SOURCE_URL}…`);
    const r = await fetchWithTimeout(SOURCE_URL, TIMEOUT_MS);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const html = await r.text();
    console.log(`[REB RUN] ${html.length} caractères reçus.`);

    const text = stripTags(html);
    const m = text.match(/(?:As of|By)\s+([A-Z][a-z]+ \d{1,2}(?:, \d{4})?)[^.]{0,160}?([\d,]{3,8})\s*(?:confirmed\s+)?cases[^.]{0,80}/i);

    if (!m) {
      console.log('[REB RUN] Aucun motif numérique trouvé — pas de mise à jour automatique possible aujourd\'hui.');
      logEntry = { date: nowStampFR(), auto: true, what: `Échec d'extraction sur CDC (Ebola Bundibugyo) — motif non trouvé.`, src: 'CDC' };
    } else {
      const quote = m[0].trim();
      const extractedDateRaw = m[1]; // ex: "June 22"
      const extractedVal = m[2];

      const key = 'ebola_bdb|Dem. Rep. Congo';
      const current = data.cases[key] || {};
      const currentDate = parseFrDate(current.date);

      // Date CDC -> approximation au jour près dans le mois courant (cohérent avec le prototype navigateur)
      const dayMatch = extractedDateRaw.match(/(\d{1,2})/);
      const extractedDay = dayMatch ? +dayMatch[1] : null;
      const currentDay = currentDate ? currentDate.getDate() : null;
      const isNewer = extractedDay != null && currentDay != null && extractedDay > currentDay;

      if (isNewer) {
        const today = new Date();
        const dd = String(today.getDate()).padStart(2, '0');
        const mmth = String(today.getMonth() + 1).padStart(2, '0');
        data.cases[key] = {
          cas: extractedVal,
          dec: current.dec ?? null,
          date: `${dd}/${mmth}/${today.getFullYear()}`,
          source: `CDC Situation Summary (auto) — mention "${extractedDateRaw}"`,
        };
        console.log(`[REB RUN] Mise à jour appliquée : ${extractedVal} cas (CDC, ${extractedDateRaw}).`);
        logEntry = { date: nowStampFR(), auto: true, what: `Ebola Bundibugyo / RDC mis à jour : ≈ ${extractedVal} cas (source plus récente trouvée sur CDC).`, src: 'CDC' };
      } else {
        console.log('[REB RUN] La valeur déjà publiée reste la plus récente — aucune modification.');
        logEntry = { date: nowStampFR(), auto: true, what: `Vérification CDC effectuée pour Ebola Bundibugyo — valeur déjà publiée toujours la plus récente, aucun changement.`, src: 'CDC' };
      }
    }
  } catch (err) {
    console.error('[REB RUN] Échec :', err.message || err);
    logEntry = { date: nowStampFR(), auto: true, what: `Échec de connexion à CDC (${err.message || err}).`, src: 'CDC' };
  }

  // Journal : on garde les 20 dernières entrées
  data.updates = [logEntry, ...data.updates].slice(0, 20);

  await writeFile(DATA_PATH, JSON.stringify(data, null, 2) + '\n', 'utf8');
  console.log('[REB RUN] donnees.json mis à jour.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
