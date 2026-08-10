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
// Le tableau de chiffres de la page CDC est injecté par JavaScript (absent du HTML brut) —
// on lit directement le CSV qui alimente son graphique comparatif, une vraie source
// structurée et stable. Il ne contient QUE les cas cumulés RDC 2026 (pas de décès) ;
// "date_updated" est la date de génération du fichier, utilisée comme date du relevé.
const CDC_CSV_URL = 'https://www.cdc.gov/wcms/vizdata/EBOLA/ebola_100_days.csv';

async function checkCDC(data) {
  try {
    const r = await fetchWithTimeout(CDC_CSV_URL, TIMEOUT_MS);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const csv = await r.text();
    const lines = csv.trim().split('\n').map(l => l.split(','));
    const header = lines[0].map(h => h.trim());
    const casIdx = header.indexOf('DRC (2026)');
    const dateIdx = header.indexOf('date_updated');
    if (casIdx === -1 || dateIdx === -1) {
      return { source: 'CDC', auto: true, status: 'failed', what: `CDC : colonnes attendues introuvables dans le CSV (format modifié) — vérification manuelle recommandée.` };
    }
    let lastCas = null, lastDate = null;
    for (let i = 1; i < lines.length; i++) {
      const row = lines[i];
      const v = (row[casIdx] || '').trim();
      if (v !== '') { lastCas = v; lastDate = (row[dateIdx] || '').trim(); }
    }
    if (lastCas == null || !lastDate) {
      return { source: 'CDC', auto: true, status: 'failed', what: `CDC : aucune valeur exploitable dans le CSV (colonne DRC 2026 vide) — vérification manuelle recommandée.` };
    }
    const d = parseEnDate(lastDate); // format ISO "YYYY-MM-DD", géré par parseEnDate
    const applied = d ? applyIfNewer(data, 'ebola_bdb|Dem. Rep. Congo', d, lastCas, null, `CDC — ebola_100_days.csv (auto) — ${lastDate}`) : false;
    return { source: 'CDC', auto: true, status: applied ? 'updated' : 'checked', what: applied
      ? `Ebola Bundibugyo / RDC mis à jour via le CSV CDC : ${lastCas} cas cumulés (${lastDate}).`
      : `CDC (CSV) vérifié pour Ebola Bundibugyo — valeur déjà publiée toujours la plus récente.` };
  } catch (err) {
    return { source: 'CDC', auto: true, status: 'failed', what: `Échec de connexion au CSV CDC (${err.message || err}).` };
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
    // Formulation ECDC (août 2026) : "On <date pub>, the Democratic Republic of the Congo (DRC)
    // published a situation update reporting a total of <cas> confirmed cases, including <décès>
    // related deaths (from data up until <date des chiffres>)." La date "up until" (sans année)
    // est celle des CHIFFRES ; la date "On …" est celle de PUBLICATION — on privilégie la 1ère.
    const m = text.match(/On\s+(\d{1,2}\s+[A-Za-z]+\s+\d{4}),?\s+the\s+(?:Democratic Republic of the Congo \(DRC\)|DRC)\s+published[\s\S]{0,100}?reporting\s+a\s+total\s+of\s+([\d,\s]{3,12})\s+confirmed\s+cases,?\s+including\s+([\d,\s]{2,10})\s+related\s+deaths(?:\s*\(from\s+data\s+up\s+until\s+(\d{1,2}\s+[A-Za-z]+)\))?/i);
    if (!m) return { source: 'ECDC', auto: true, status: 'failed', what: `Échec d'extraction sur ECDC (Ebola Bundibugyo) — motif non trouvé.` };

    const cas = m[2].replace(/[^\d]/g, '');
    const dec = m[3].replace(/[^\d]/g, '');
    const pubYear = (m[1].match(/\d{4}/) || [])[0] || String(new Date().getFullYear());
    const dateRaw = m[4] ? `${m[4]} ${pubYear}` : m[1];
    const d = parseEnDate(dateRaw);
    const applied = d ? applyIfNewer(data, 'ebola_bdb|Dem. Rep. Congo', d, cas, dec, `ECDC (auto) — "${dateRaw}"`) : false;
    return { source: 'ECDC', auto: true, status: applied ? 'updated' : 'checked', what: applied
      ? `Ebola Bundibugyo / RDC mis à jour via ECDC : ${cas} cas, ${dec} décès (${dateRaw}).`
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
      // Depuis ~juin 2026, les sitreps quotidiens Africa CDC n'ont plus de texte en page :
      // les chiffres sont uniquement dans le PDF téléchargeable (non parsable ici).
      return { source: 'Africa CDC', auto: true, status: 'failed', what: m
        ? `Motif trouvé sur Africa CDC mais ambigu (mélange cas confirmés / décès suspects dans la phrase) — rejeté par prudence, vérification manuelle recommandée.`
        : `Africa CDC : les derniers sitreps ne publient plus les chiffres en page (uniquement dans le PDF téléchargeable) — non exploitable automatiquement, vérification manuelle recommandée.` };
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
    // Formulation ESCMID (août 2026) : bloc "Summary: <date>" suivi d'un paragraphe
    // "The Ebola virus disease outbreak in the Democratic Republic of the Congo has reached
    // X confirmed cases and Y deaths across NN health zones" (l'ancien motif "as of DATE" a disparu).
    const m = text.match(/Summary:\s*(\d{1,2}\s+[A-Za-z]+\s+\d{4})[\s\S]{0,400}?Ebola virus disease\s+outbreak in the\s+Democratic Republic of the Congo\s+has reached\s+([\d,]{3,10})\s+confirmed cases and\s+([\d,]{2,8})\s+deaths/i);
    if (!m) return { source: 'ESCMID', auto: true, status: 'failed', what: `Échec d'extraction sur ESCMID Epi Alert (Ebola Bundibugyo) — motif non trouvé.` };

    const cas = m[2].replace(/[^\d]/g, '');
    const dec = m[3].replace(/[^\d]/g, '');
    const d = parseEnDate(m[1]);
    const applied = d ? applyIfNewer(data, 'ebola_bdb|Dem. Rep. Congo', d, cas, dec, `ESCMID Epi Alert (auto) — ${m[1]}`) : false;
    return { source: 'ESCMID', auto: true, status: applied ? 'updated' : 'checked', what: applied
      ? `Ebola Bundibugyo / RDC mis à jour via ESCMID Epi Alert : ${cas} cas, ${dec} décès (${m[1]}).`
      : `ESCMID Epi Alert vérifié pour Ebola Bundibugyo — valeur déjà publiée toujours la plus récente.` };
  } catch (err) {
    return { source: 'ESCMID', auto: true, status: 'failed', what: `Échec de connexion à ESCMID Epi Alert (${err.message || err}).` };
  }
}

// ── Source 6 : Bulletin hebdomadaire SpF Océan Indien (La Réunion) ──────────────
// Le check Mpox auto a été retiré (fin de l'urgence, plus de flux chiffré fiable).
// À la place, on détecte le BULLETIN HEBDOMADAIRE le plus récent de Santé publique
// France Océan Indien (date + lien) : il signale quand un nouveau bulletin paraît
// afin de garder à jour les indicateurs Réunion saisis à la main (leptospirose,
// mpox local, grippe, bronchiolite). Les chiffres dengue/chik restent auto via Odissé.
async function checkBulletinReunion(data) {
  const MOIS = { janvier:1, 'février':2, fevrier:2, mars:3, avril:4, mai:5, juin:6, juillet:7, 'août':8, aout:8, septembre:9, octobre:10, novembre:11, 'décembre':12, decembre:12 };
  const listUrls = [
    'https://www.santepubliquefrance.fr/regions-et-territoires/ocean-indien/bulletin-regional',
    'https://www.santepubliquefrance.fr/regions-et-territoires/ocean-indien/publications',
    'https://www.santepubliquefrance.fr/regions-et-territoires/ocean-indien',
  ];
  try {
    let html = '';
    for (const u of listUrls) {
      try { const r = await fetchWithTimeout(u, TIMEOUT_MS); if (r.ok) html += await r.text(); } catch (e) {}
    }
    if (!html) throw new Error('pages SpF Océan Indien inaccessibles');
    const re = /href="([^"]*surveillance-sanitaire-a-la-reunion-bulletin-du-(\d{1,2})-([a-zA-Zéûôùàè]+)-(\d{4})[^"]*)"/gi;
    let m, best = null;
    while ((m = re.exec(html)) !== null) {
      const day = +m[2], mon = MOIS[m[3].toLowerCase()], year = +m[4];
      if (!mon) continue;
      const d = new Date(year, mon - 1, day);
      let url = m[1]; if (url.startsWith('/')) url = 'https://www.santepubliquefrance.fr' + url;
      if (!best || d > best.d) best = { d, url, day, mon, year };
    }
    if (!best) {
      return { source: 'SpF Océan Indien (bulletin)', auto: true, status: 'failed', what: `Aucun bulletin hebdo Réunion détecté sur les pages SpF Océan Indien (mise en page variable) — indicateurs Réunion à vérifier manuellement.` };
    }
    const dd = String(best.day).padStart(2,'0'), mm = String(best.mon).padStart(2,'0');
    const dateFR = `${dd}/${mm}/${best.year}`;
    const prev = (data.reunionBulletin && data.reunionBulletin.date) || null;
    const prevD = prev ? parseFrDate(prev) : null;
    const isNew = !prevD || best.d > prevD;
    data.reunionBulletin = { date: dateFR, url: best.url, fetchedAt: nowStampFR() };
    return { source: 'SpF Océan Indien (bulletin)', auto: true, status: isNew ? 'updated' : 'checked', what: isNew
      ? `Nouveau bulletin hebdomadaire SpF Océan Indien détecté (${dateFR}) — reporter les indicateurs Réunion (leptospirose, mpox local, grippe, bronchiolite).`
      : `Bulletin SpF Océan Indien vérifié — dernier paru le ${dateFR}, déjà connu.` };
  } catch (err) {
    return { source: 'SpF Océan Indien (bulletin)', auto: true, status: 'failed', what: `Bulletin SpF Océan Indien inaccessible (${err.message || err}).` };
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
// Fait correspondre le nom d'une source dans data.sources[] au libellé renvoyé par son
// check ; sert à resynchroniser data.sources[].last (jusqu'ici jamais mis à jour) avec la
// date réelle du dernier passage réussi, pour que les pastilles "à jour / à réactualiser"
// reflètent l'activité réelle du moteur plutôt qu'une date saisie une fois pour toutes.
const SOURCE_NAME_MAP = {
  'CDC': 'CDC — Situation Summary',
  'OMS': 'OMS — Disease Outbreak News',
  'ECDC': 'ECDC — page de suivi Ebola RDC/Ouganda',
  'Africa CDC': 'Africa CDC',
  'ESCMID': 'ESCMID Epi Alert',
  'Odissé (SpF)': 'Odissé — Santé publique France (API JSON)',
  'ReliefWeb': 'ReliefWeb (API JSON)',
  'SpF Océan Indien (bulletin)': 'Santé publique France — Bulletin Océan Indien (La Réunion)',
};

function deriveDashboard(data, checkLogs = []) {
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
    if (al) {
      const z = (al.zones || []).find(z => z.zone === m.zone);
      if (z) { if (cas != null) z.cas = cas; if (dec != null) z.dec = dec; }
      // Resynchronise la date "arrêté au DD/MM/YYYY" affichée dans les KPI (period)
      // avec la date réelle du relevé — sinon elle reste figée même quand les chiffres bougent.
      if (rec.date && /arrêté au\s+\d{1,2}\/\d{1,2}\/\d{2,4}/.test(al.period || '')) {
        al.period = al.period.replace(/arrêté au\s+\d{1,2}\/\d{1,2}\/\d{2,4}/, `arrêté au ${rec.date}`);
      }
    }
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

  // Resynchronise la fraîcheur affichée des sources automatiques (data.sources[].last)
  // avec la date du jour, pour chaque check qui a réellement abouti (pas en échec).
  const today = new Date();
  const todayFR = `${String(today.getDate()).padStart(2,'0')}/${String(today.getMonth()+1).padStart(2,'0')}/${today.getFullYear()}`;
  for (const log of checkLogs) {
    if (!log || log.status === 'failed') continue;
    const srcName = SOURCE_NAME_MAP[log.source];
    const entry = (data.sources || []).find(s => s.name === srcName);
    if (entry) { entry.last = todayFR; entry.auto = true; }
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

  console.log('[REB RUN] Vérification bulletin SpF Océan Indien (Réunion)…');
  const bullLog = await checkBulletinReunion(data);
  console.log('[REB RUN]', bullLog.what);

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
    { date: stamp, auto: true, status: bullLog.status, what: bullLog.what, src: 'SpF Océan Indien (bulletin)' },
    { date: stamp, auto: true, status: escmidLog.status, what: escmidLog.what, src: 'ESCMID' },
    { date: stamp, auto: true, status: acdcLog.status, what: acdcLog.what, src: 'Africa CDC' },
    { date: stamp, auto: true, status: ecdcLog.status, what: ecdcLog.what, src: 'ECDC' },
    { date: stamp, auto: true, status: whoLog.status, what: whoLog.what, src: 'OMS' },
    { date: stamp, auto: true, status: cdcLog.status, what: cdcLog.what, src: 'CDC' },
    ...data.updates,
  ].slice(0, 30);

  // Propage les chiffres collectés vers tous les onglets + recalcule les KPI d'accueil
  deriveDashboard(data, [cdcLog, whoLog, ecdcLog, acdcLog, escmidLog, bullLog, arboLog, rwLog]);

  await writeFile(DATA_PATH, JSON.stringify(data, null, 2) + '\n', 'utf8');
  console.log('[REB RUN] donnees.json mis à jour.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
