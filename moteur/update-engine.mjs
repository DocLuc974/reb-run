// REB RUN — Moteur d'actualisation (V1 + OMS, ECDC, Africa CDC, ESCMID, Mpox
//            + API structurées : Odissé/SpF (arboviroses Réunion), ReliefWeb (alertes))
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
import { fetchArboviroses } from './odisse.js';
import { fetchEpidemics } from './reliefweb.js';

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

function ddmmFromDate(d) {
  return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}`;
}

function pushSeriesPoint(data, pathogenId, dateLabel, totalCas, totalDec) {
  data.epiSeries = data.epiSeries || {};
  data.epiSeries[pathogenId] = data.epiSeries[pathogenId] || [];
  const series = data.epiSeries[pathogenId];
  const existing = series.find(p => p.date === dateLabel);
  if (existing) {
    existing.cas = totalCas;
    existing.dec = totalDec;
  } else {
    series.push({ date: dateLabel, cas: totalCas, dec: totalDec });
  }
  // Garde un historique raisonnable (30 derniers points)
  if (series.length > 30) data.epiSeries[pathogenId] = series.slice(series.length - 30);
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
    // Alimente automatiquement la série temporelle (courbe) du pathogène concerné,
    // en additionnant les autres zones connues (ex. Ouganda, statique pour l'instant).
    const [pathogenId, zone] = key.split('|');
    if (pathogenId === 'ebola_bdb') {
      const ugandaCas = +(data.cases['ebola_bdb|Uganda']?.cas) || 19;
      const ugandaDec = +(data.cases['ebola_bdb|Uganda']?.dec) || 2;
      const casNum = +String(candidateCas).replace(/[^\d]/g, '') || 0;
      const decNum = +String(data.cases[key].dec).replace(/[^\d]/g, '') || 0;
      const totalCas = zone === 'Uganda' ? casNum + (+(data.cases['ebola_bdb|Dem. Rep. Congo']?.cas) || 0) : casNum + ugandaCas;
      const totalDec = zone === 'Uganda' ? decNum + (+(data.cases['ebola_bdb|Dem. Rep. Congo']?.dec) || 0) : decNum + ugandaDec;
      pushSeriesPoint(data, 'ebola_bdb', ddmmFromDate(candidateDate), totalCas, totalDec);
    } else {
      // Autres pathogènes auto-suivis (une seule zone de référence) : on alimente
      // directement la série temporelle du pathogène avec les chiffres de cette zone.
      const casNum = +String(candidateCas).replace(/[^\d]/g, '') || 0;
      const decNum = +String(data.cases[key].dec).replace(/[^\d]/g, '') || 0;
      pushSeriesPoint(data, pathogenId, ddmmFromDate(candidateDate), casNum, decNum);
    }
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
    if (!m) return { source: 'CDC', auto: true, status: 'failed', what: `Échec d'extraction sur CDC (Ebola Bundibugyo) — motif non trouvé.` };

    const quote = m[0].trim();
    const dateRaw = m[1].includes(',') ? m[1] : `${m[1]}, 2026`;
    const d = parseEnDate(dateRaw);
    const applied = d ? applyIfNewer(data, 'ebola_bdb|Dem. Rep. Congo', d, m[2], null, `CDC Situation Summary (auto) — "${m[1]}"`) : false;
    return { source: 'CDC', auto: true, status: applied ? 'updated' : 'checked', what: applied
      ? `Ebola Bundibugyo / RDC mis à jour via CDC : ≈ ${m[2]} cas (${m[1]}).`
      : `CDC vérifié pour Ebola Bundibugyo — valeur déjà publiée toujours la plus récente.` };
  } catch (err) {
    return { source: 'CDC', auto: true, status: 'failed', what: `Échec de connexion à CDC (${err.message || err}).` };
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
    return { source: 'OMS', auto: true, status: 'checked', what: `Aucun nouveau bulletin OMS (DON) sur Ebola Bundibugyo depuis le dernier sondage (jusqu'à DON${lastChecked}).` };
  }

  const d = parseEnDate(bestMatch.date);
  const applied = d ? applyIfNewer(data, 'ebola_bdb|Dem. Rep. Congo', d, bestMatch.cas, bestMatch.dec, `OMS DON${bestMatch.n} (auto) — ${bestMatch.date}`) : false;
  return { source: 'OMS', auto: true, status: applied ? 'updated' : 'checked', what: applied
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
    if (!m) return { source: 'ECDC', auto: true, status: 'failed', what: `Échec d'extraction sur ECDC (Ebola Bundibugyo) — motif non trouvé.` };

    const quote = m[0].trim();
    const dateRaw = `${m[1]}, 2026`; // ECDC omet l'année dans cette phrase
    const cas = m[2].replace(/[^\d]/g, '');
    const dec = m[3].replace(/[^\d]/g, '');
    const d = parseEnDate(dateRaw);
    const applied = d ? applyIfNewer(data, 'ebola_bdb|Dem. Rep. Congo', d, cas, dec, `ECDC (auto) — "${m[1]}"`) : false;
    return { source: 'ECDC', auto: true, status: applied ? 'updated' : 'checked', what: applied
      ? `Ebola Bundibugyo / RDC mis à jour via ECDC : ${cas} cas, ${dec} décès (${m[1]}).`
      : `ECDC vérifié pour Ebola Bundibugyo — valeur déjà publiée toujours la plus récente.` };
  } catch (err) {
    return { source: 'ECDC', auto: true, status: 'failed', what: `Échec de connexion à ECDC (${err.message || err}).` };
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
      return { source: 'Africa CDC', auto: true, status: 'failed', what: m
        ? `Motif trouvé sur Africa CDC mais ambigu (mélange cas confirmés / décès suspects dans la phrase) — rejeté par prudence, vérification manuelle recommandée.`
        : `Aucun motif numérique exploitable trouvé sur Africa CDC (format de page variable) — vérification manuelle recommandée.` };
    }

    const cas = m[2].replace(/[^\d]/g, '');
    const dec = m[4].replace(/[^\d]/g, '');
    const d = parseEnDate(m[1]);
    const applied = d ? applyIfNewer(data, 'ebola_bdb|Dem. Rep. Congo', d, cas, dec, `Africa CDC (auto) — ${m[1]}`) : false;
    return { source: 'Africa CDC', auto: true, status: applied ? 'updated' : 'checked', what: applied
      ? `Ebola Bundibugyo / RDC mis à jour via Africa CDC : ${cas} cas, ${dec} décès (${m[1]}).`
      : `Africa CDC vérifié pour Ebola Bundibugyo — valeur déjà publiée toujours la plus récente.` };
  } catch (err) {
    return { source: 'Africa CDC', auto: true, status: 'failed', what: `Échec de connexion à Africa CDC (${err.message || err}).` };
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
    if (!m) return { source: 'ESCMID', auto: true, status: 'failed', what: `Échec d'extraction sur ESCMID Epi Alert (Ebola Bundibugyo) — motif non trouvé.` };

    const cas = m[1].replace(/[^\d]/g, '');
    const dec = m[2].replace(/[^\d]/g, '');
    const d = parseEnDate(m[3]);
    const applied = d ? applyIfNewer(data, 'ebola_bdb|Dem. Rep. Congo', d, cas, dec, `ESCMID Epi Alert (auto) — ${m[3]}`) : false;
    return { source: 'ESCMID', auto: true, status: applied ? 'updated' : 'checked', what: applied
      ? `Ebola Bundibugyo / RDC mis à jour via ESCMID Epi Alert : ${cas} cas, ${dec} décès (${m[3]}).`
      : `ESCMID Epi Alert vérifié pour Ebola Bundibugyo — valeur déjà publiée toujours la plus récente.` };
  } catch (err) {
    return { source: 'ESCMID', auto: true, status: 'failed', what: `Échec de connexion à ESCMID Epi Alert (${err.message || err}).` };
  }
}

// ── Source 6 : Mpox (clade Ib) — Africa CDC, foyer RDC ──────────────────────────
// Même principe que pour Ebola : on extrait un bilan chiffré daté pour la RDC
// (épicentre du clade Ib) et on n'applique que s'il est plus récent que la valeur
// publiée. Garde-fou identique : si la phrase mêle des cas "suspected"/"probable"
// au décompte de décès, l'extraction est REJETÉE (préférer "pas de MAJ" à une
// mauvaise statistique). Le motif ci-dessous est calé sur le phrasé courant
// d'Africa CDC ; comme pour les autres sources, il se peut qu'il doive être ajusté
// au premier run réel si la page change de formulation (échec tracé, non bloquant).
async function checkMpox(data) {
  const url = 'https://africacdc.org/disease-outbreak/mpox-outbreak/';
  try {
    const r = await fetchWithTimeout(url, TIMEOUT_MS);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = stripTags(await r.text());
    const re = /[Aa]s of\s+(\d{1,2}\s+[A-Za-z]+\s+\d{4}|[A-Za-z]+\s+\d{1,2},?\s+\d{4})[\s\S]{0,150}?([\d,]{3,9})\s+confirmed\s+(?:mpox\s+)?cases([\s\S]{0,90}?)([\d,]{1,7})\s+(?:confirmed\s+)?deaths/i;
    const m = text.match(re);
    const between = m ? m[3] : '';
    if (!m || /suspect|probable/i.test(between)) {
      return { source: 'Africa CDC (Mpox)', auto: true, status: 'failed', what: m
        ? `Motif Mpox trouvé sur Africa CDC mais ambigu (cas confirmés / décès suspects mêlés) — rejeté par prudence, vérification manuelle recommandée.`
        : `Aucun motif Mpox chiffré exploitable sur Africa CDC (format de page variable) — vérification manuelle recommandée.` };
    }
    const cas = m[2].replace(/[^\d]/g, '');
    const dec = m[4].replace(/[^\d]/g, '');
    const d = parseEnDate(m[1]);
    const applied = d ? applyIfNewer(data, 'mpox|Dem. Rep. Congo', d, cas, dec, `Africa CDC Mpox (auto) — ${m[1]}`) : false;
    return { source: 'Africa CDC (Mpox)', auto: true, status: applied ? 'updated' : 'checked', what: applied
      ? `Mpox / RDC mis à jour via Africa CDC : ${cas} cas, ${dec} décès (${m[1]}).`
      : `Africa CDC (Mpox) vérifié pour la RDC — valeur déjà publiée toujours la plus récente.` };
  } catch (err) {
    return { source: 'Africa CDC (Mpox)', auto: true, status: 'failed', what: `Échec de connexion à Africa CDC Mpox (${err.message || err}).` };
  }
}

// ── Source 7 : Arboviroses La Réunion — API Odissé (Santé publique France) ──────
// Déclaration obligatoire (dengue / chikungunya) servie en JSON par l'API
// OpenDataSoft de SpF, SANS authentification (donc pas de blocage CORS/serveur).
// Bien plus robuste que le scraping du bulletin hebdomadaire (PDF à URL datée).
// odisse.js auto-détecte les colonnes ; si la détection échoue, on trace un échec
// non bloquant plutôt que de publier des valeurs douteuses.
async function checkArboReunion(data) {
  const year = new Date().getFullYear();
  try {
    const { rows, mapping } = await fetchArboviroses({ pathologies: ['dengue', 'chikungunya'], region: 'La Réunion', yearFrom: year });
    if (!mapping.date || !mapping.cas) {
      return { source: 'Odissé (SpF)', auto: true, status: 'failed', what: `Auto-mapping des champs Odissé incomplet (colonnes date/cas non détectées) — arboviroses Réunion à saisir manuellement.` };
    }
    const isAuto = (s) => !mapping.statut || /autochtone/i.test(String(s || ''));
    const sumFor = (needle) => rows
      .filter(r => (r.pathologie || '').toLowerCase().includes(needle) && isAuto(r.statut))
      .reduce((a, r) => a + (Number(r.cas) || 0), 0);
    const items = [
      { key: 'dengue|La Réunion', pid: 'dengue', label: 'dengue', n: sumFor('dengue') },
      { key: 'chikv|La Réunion', pid: 'chikv', label: 'chikungunya', n: sumFor('chik') },
    ];
    const dd = String(new Date().getDate()).padStart(2, '0');
    const mm = String(new Date().getMonth() + 1).padStart(2, '0');
    const stampFR = `${dd}/${mm}/${year}`;
    const changed = [];
    for (const it of items) {
      if (it.n <= 0) continue;
      const prev = data.cases[it.key] ? String(data.cases[it.key].cas).replace(/[^\d]/g, '') : null;
      if (String(it.n) !== prev) {
        data.cases[it.key] = { cas: String(it.n), dec: null, date: stampFR, source: 'Odissé / SpF (DO arboviroses)' };
        pushSeriesPoint(data, it.pid, `${dd}/${mm}`, it.n, 0);
        changed.push(`${it.label} ${it.n}`);
      }
    }
    return { source: 'Odissé (SpF)', auto: true, status: changed.length ? 'updated' : 'checked', what: changed.length
      ? `Arboviroses Réunion mises à jour via Odissé/SpF : ${changed.join(', ')} cas autochtones cumulés ${year}.`
      : `Odissé/SpF interrogé — cas arboviroses Réunion inchangés depuis le dernier relevé.` };
  } catch (err) {
    return { source: 'Odissé (SpF)', auto: true, status: 'failed', what: `Odissé/SpF inaccessible (${err.message || err}).` };
  }
}

// ── Source 8 : Alertes épidémies OI / Afrique de l'Est — API ReliefWeb ──────────
// Couche "signal précoce" (endpoint /disasters, type Epidemic), JSON structuré pour
// toute la zone de veille. La liste est stockée dans data.reliefweb pour affichage.
// ⚠️ Depuis 11/2025 l'appname ReliefWeb doit être PRÉ-APPROUVÉ : tant que APPNAME
// (dans reliefweb.js) n'est pas renseigné avec un nom approuvé, l'API refuse —
// l'échec est tracé, jamais bloquant.
async function checkReliefWeb(data) {
  try {
    const eps = await fetchEpidemics({ limit: 30 });
    data.reliefweb = { fetchedAt: nowStampFR(), alerts: eps.slice(0, 20) };
    return { source: 'ReliefWeb', auto: true, status: eps.length ? 'updated' : 'checked', what: eps.length
      ? `${eps.length} alerte(s) épidémie active(s) recensée(s) dans la zone (ReliefWeb).`
      : `ReliefWeb interrogé — aucune alerte épidémie active dans la zone de veille.` };
  } catch (err) {
    return { source: 'ReliefWeb', auto: true, status: 'failed', what: `ReliefWeb inaccessible (${err.message || err}). Rappel : appname à faire pré-approuver puis à renseigner dans reliefweb.js.` };
  }
}

// ── Dérivation finale : propage les chiffres collectés vers TOUT le tableau de bord ─
// Le moteur écrit ses relevés dans data.cases / data.epiSeries. Cette étape reporte
// ces nombres dans les structures que lisent les onglets (alerts, synth) et recalcule
// les indicateurs de la page d'accueil (data.kpi). Les NIVEAUX de gravité des cartes
// (data.regional / data.world) restent éditoriaux : ils ne se déduisent pas d'un simple
// comptage et ne sont donc pas touchés ici.
function deriveDashboard(data) {
  const num = (v) => v == null ? null : (+String(v).replace(/[^\d]/g, '') || 0);
  // caseKey (pathogen|zoneEN) -> ligne à mettre à jour dans alerts et synth
  const MAP = {
    'ebola_bdb|Dem. Rep. Congo': { alert: 'Ebola Bundibugyo', synth: 'Ebola Bundibugyo', zone: 'RDC' },
    'ebola_bdb|Uganda':          { alert: 'Ebola Bundibugyo', synth: 'Ebola Bundibugyo', zone: 'Ouganda' },
    'dengue|La Réunion':         { alert: 'Dengue',           synth: 'Dengue (La Réunion)', zone: 'La Réunion' },
    'chikv|La Réunion':          { alert: 'Chikungunya',      synth: 'Chikungunya (La Réunion)', zone: 'La Réunion' },
  };
  for (const [key, m] of Object.entries(MAP)) {
    const rec = data.cases && data.cases[key];
    if (!rec) continue;
    const cas = num(rec.cas), dec = num(rec.dec);
    const al = (data.alerts || []).find(a => a.name === m.alert);
    if (al) { const z = (al.zones || []).find(z => z.zone === m.zone); if (z) { if (cas != null) z.cas = cas; if (dec != null) z.dec = dec; } }
    const sy = (data.synth || []).find(s => s.name === m.synth);
    if (sy) {
      const r = (sy.rows || []).find(r => r.zone === m.zone);
      if (r) { if (cas != null) r.conf = cas; if (dec != null) r.dec = dec; }
      if (rec.date) sy.date = rec.date;
    }
  }
  // Recalcule le TOTAL du bloc Ebola (RDC + Ouganda)
  const eb = (data.synth || []).find(s => s.name === 'Ebola Bundibugyo');
  if (eb) {
    const rows = eb.rows.filter(r => !r.total);
    const tc = rows.reduce((a, r) => a + (r.conf || 0), 0);
    const td = rows.reduce((a, r) => a + (r.dec || 0), 0);
    const tot = eb.rows.find(r => r.total);
    if (tot) { tot.conf = tc; tot.dec = td; }
  }
  // Indicateurs de la page d'accueil, recalculés depuis alerts
  const alerts = data.alerts || [];
  const LBL = { 0: 'Aucun signal', 1: 'Surveillance', 2: 'Veille renforcée', 3: 'Alerte', 4: 'Urgence' };
  let deces = 0, maxL = 0, maxWhat = '';
  const foyers = new Set();
  for (const a of alerts) {
    for (const z of (a.zones || [])) {
      if (z.dec) deces += z.dec;
      if ((z.l || 0) >= 3) foyers.add(z.zone);
    }
    if ((a.lvl || 0) > maxL) { maxL = a.lvl; maxWhat = a.name + ((a.zones && a.zones[0]) ? ' · ' + a.zones[0].zone : ''); }
  }
  data.kpi = {
    foyersActifs: foyers.size,
    foyersLabel: [...foyers].join(' · ') || '—',
    deces,
    pathogenesEnAlerte: alerts.length,
    pathogenesTotal: 12,
    niveauMaxLabel: LBL[maxL] || '—',
    niveauMaxWhat: maxWhat || '—',
  };
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

  console.log('[REB RUN] Vérification Mpox (Africa CDC)…');
  const mpoxLog = await checkMpox(data);
  console.log('[REB RUN]', mpoxLog.what);

  console.log('[REB RUN] Vérification arboviroses Réunion (Odissé/SpF)…');
  const arboLog = await checkArboReunion(data);
  console.log('[REB RUN]', arboLog.what);

  console.log('[REB RUN] Vérification alertes ReliefWeb…');
  const rwLog = await checkReliefWeb(data);
  console.log('[REB RUN]', rwLog.what);

  const stamp = nowStampFR();
  data.updates = [
    { date: stamp, auto: true, status: rwLog.status, what: rwLog.what, src: 'ReliefWeb' },
    { date: stamp, auto: true, status: arboLog.status, what: arboLog.what, src: 'Odissé (SpF)' },
    { date: stamp, auto: true, status: mpoxLog.status, what: mpoxLog.what, src: 'Africa CDC (Mpox)' },
    { date: stamp, auto: true, status: escmidLog.status, what: escmidLog.what, src: 'ESCMID' },
    { date: stamp, auto: true, status: acdcLog.status, what: acdcLog.what, src: 'Africa CDC' },
    { date: stamp, auto: true, status: ecdcLog.status, what: ecdcLog.what, src: 'ECDC' },
    { date: stamp, auto: true, status: whoLog.status, what: whoLog.what, src: 'OMS' },
    { date: stamp, auto: true, status: cdcLog.status, what: cdcLog.what, src: 'CDC' },
    ...data.updates,
  ].slice(0, 30);

  // Propage les chiffres collectés vers tous les onglets + recalcule les KPI d'accueil
  deriveDashboard(data);

  await writeFile(DATA_PATH, JSON.stringify(data, null, 2) + '\n', 'utf8');
  console.log('[REB RUN] donnees.json mis à jour.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
