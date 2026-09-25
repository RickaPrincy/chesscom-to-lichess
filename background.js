// Récupère le PGN d'une partie Chess.com puis l'importe sur Lichess.

const GAME_URL_RE = /chess\.com\/(?:analysis\/)?game\/(?:(live|daily)\/)?(\d+)/;

function parseGameUrl(url) {
  const m = url && url.match(GAME_URL_RE);
  if (!m) return null;
  const username = new URL(url).searchParams.get("username");
  return { type: m[1] || null, id: m[2], username: username ? username.toLowerCase() : null };
}

async function getJson(url) {
  const res = await fetch(url, { credentials: "omit" });
  if (!res.ok) throw new Error(`HTTP ${res.status} sur ${url}`);
  return res.json();
}

// Infos de base sur la partie (joueurs + date) via l'endpoint interne de chess.com.
async function getGameInfo(type, id) {
  for (const t of type ? [type] : ["live", "daily"]) {
    const info = await getGameInfoOfType(t, id);
    if (info.players.length) return info;
  }
  return { players: [], date: null };
}

async function getGameInfoOfType(type, id) {
  try {
    const data = await getJson(`https://www.chess.com/callback/${type}/game/${id}`);
    const h = (data.game && data.game.pgnHeaders) || {};
    const players = [h.White, h.Black].filter(Boolean).map((p) => p.toLowerCase());
    let date = null;
    if (h.Date) {
      const [y, mo] = h.Date.split(".").map(Number);
      if (y && mo) date = new Date(Date.UTC(y, mo - 1, 1));
    }
    return { players, date };
  } catch (e) {
    console.warn("[chesscom→lichess] callback indisponible :", e);
    return { players: [], date: null };
  }
}

function monthsToTry(date) {
  const base = date || new Date();
  const out = [];
  // mois de la partie, le suivant (partie finie après minuit en fin de mois) et le précédent
  for (const delta of [0, 1, -1]) {
    const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + delta, 1));
    if (d > new Date()) continue;
    out.push([d.getUTCFullYear(), String(d.getUTCMonth() + 1).padStart(2, "0")]);
  }
  return out;
}

// Cherche le PGN dans les archives publiques mensuelles (api.chess.com).
async function fetchPgn({ type, id, username }) {
  const info = await getGameInfo(type, id);
  const users = [...new Set([username, ...info.players].filter(Boolean))];
  if (users.length === 0) {
    throw new Error("Impossible de déterminer les joueurs de la partie.");
  }

  for (const user of users) {
    for (const [y, m] of monthsToTry(info.date)) {
      let archive;
      try {
        archive = await getJson(`https://api.chess.com/pub/player/${user}/games/${y}/${m}`);
      } catch (e) {
        continue;
      }
      const game = (archive.games || []).find((g) => g.url && g.url.endsWith(`/${id}`));
      if (game && game.pgn) {
        return { pgn: game.pgn, white: game.white.username.toLowerCase(), black: game.black.username.toLowerCase() };
      }
    }
  }
  throw new Error("Partie introuvable dans les archives Chess.com (elle est peut-être encore en cours ou toute récente, réessaie dans quelques secondes).");
}

async function importToLichess(pgn) {
  const res = await fetch("https://lichess.org/api/import", {
    method: "POST",
    headers: { Accept: "application/json" },
    body: new URLSearchParams({ pgn }),
    credentials: "omit",
  });
  if (res.status === 429) throw new Error("Lichess limite les imports, attends une minute puis réessaie.");
  if (!res.ok) throw new Error(`Import Lichess refusé (HTTP ${res.status}).`);
  const data = await res.json();
  return data.url || `https://lichess.org/${data.id}`;
}

function pgnHeader(pgn, name) {
  const m = pgn.match(new RegExp(`\\[${name} "([^"]*)"\\]`));
  return m ? m[1].toLowerCase() : null;
}

// pgn : PGN déjà récupéré par le content script (dialogue "Partager"), sinon archives API.
// me : pseudo du joueur connecté, pour orienter l'échiquier.
async function analyze(pageUrl, openerTabId, pgn, me) {
  const game = parseGameUrl(pageUrl);
  if (!game) throw new Error("Ce n'est pas une page de partie Chess.com.");

  if (!pgn) pgn = (await fetchPgn(game)).pgn;
  let url = await importToLichess(pgn);

  // Oriente l'échiquier du côté du joueur si on sait qui il est.
  const user = game.username || (me && me.toLowerCase());
  if (user && user === pgnHeader(pgn, "Black")) url += "/black";

  await browser.tabs.create({ url, openerTabId });
  return url;
}

browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.type === "analyze") {
    return analyze(msg.url, sender.tab && sender.tab.id, msg.pgn, msg.me)
      .then((url) => ({ ok: true, url }))
      .catch((e) => ({ ok: false, error: e.message }));
  }
});

// Clic sur l'icône de la barre d'outils = même action.
browser.browserAction.onClicked.addListener(async (tab) => {
  if (!parseGameUrl(tab.url)) {
    browser.tabs.sendMessage(tab.id, { type: "toast", text: "Ouvre une partie Chess.com d'abord." }).catch(() => {});
    return;
  }
  browser.tabs.sendMessage(tab.id, { type: "trigger" }).catch(async () => {
    // content script absent (page chargée avant l'installation) : on le fait quand même
    try { await analyze(tab.url, tab.id); } catch (e) { console.error(e); }
  });
});
