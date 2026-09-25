// Injecte un bouton "Analyser sur Lichess" sur les pages de partie Chess.com.
// Chess.com est une SPA : on surveille les changements d'URL.

(() => {
  const GAME_URL_RE = /chess\.com\/(?:analysis\/)?game\/(?:(live|daily)\/)?(\d+)/;
  const BTN_ID = "c2l-analyze-btn";
  const BTN_LABEL = "♞ Analyser sur Lichess";
  let busy = false;

  function toast(text, isError = false) {
    let el = document.getElementById("c2l-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "c2l-toast";
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.classList.toggle("c2l-error", isError);
    el.classList.add("c2l-show");
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove("c2l-show"), isError ? 6000 : 3000);
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(fn, timeout = 4000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(100);
    }
    return null;
  }

  const isVisible = (el) => el && el.getClientRects().length > 0;

  function findPgnText() {
    for (const el of document.querySelectorAll("textarea")) {
      if (/\[Event\s+"/.test(el.value) && /\d+\.\s*\S/.test(el.value)) return el.value;
    }
    return null;
  }

  function findShareButton() {
    const candidates = document.querySelectorAll(
      '[aria-label*="share" i], [title*="share" i], [data-cy*="share" i], [aria-label*="partager" i], [title*="partager" i], .icon-font-chess.share'
    );
    for (const el of candidates) {
      if (el.closest("#" + BTN_ID)) continue;
      const clickable = el.closest("button, a, [role='button']") || el;
      if (isVisible(clickable)) return clickable;
    }
    return null;
  }

  function findDialog() {
    const dialogs = [...document.querySelectorAll("[role='dialog'], [class*='modal' i]")].filter(isVisible);
    return dialogs.find((d) => /share|partager/i.test(d.textContent)) || dialogs[0] || null;
  }

  function findPgnTab(root) {
    for (const el of root.querySelectorAll("button, [role='tab'], a, span, div")) {
      if (el.children.length === 0 && el.textContent.trim() === "PGN" && isVisible(el)) {
        return el.closest("button, [role='tab'], a") || el;
      }
    }
    return null;
  }

  function closeDialog(dialog) {
    const close = dialog && dialog.querySelector(
      '[aria-label*="close" i], [aria-label*="fermer" i], [class*="close" i], [data-cy*="close" i]'
    );
    if (close) close.click();
    else document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  }

  // Ouvre Partager → PGN, lit le PGN, referme le dialogue. Renvoie null si échec.
  async function scrapePgn() {
    const already = findPgnText();
    if (already) return already;

    const share = findShareButton();
    if (!share) return null;

    document.documentElement.classList.add("c2l-scraping"); // masque le dialogue pendant la lecture
    let dialog = null;
    try {
      share.click();
      dialog = await waitFor(findDialog, 3000);
      if (!dialog) return null;
      const tab = await waitFor(() => findPgnTab(dialog), 1500);
      if (tab) tab.click();
      return await waitFor(findPgnText, 3000);
    } finally {
      closeDialog(dialog || findDialog());
      await sleep(150);
      document.documentElement.classList.remove("c2l-scraping");
    }
  }

  // Pseudo du joueur connecté (exposé par chess.com dans la page).
  function currentUser() {
    try {
      const ctx = window.wrappedJSObject && window.wrappedJSObject.context;
      return (ctx && ctx.user && ctx.user.username) || null;
    } catch (e) {
      return null;
    }
  }

  async function run() {
    if (busy) return;
    busy = true;
    const btn = document.getElementById(BTN_ID);
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Import en cours…";
    }
    try {
      let pgn = null;
      try {
        pgn = await scrapePgn();
      } catch (e) {
        console.warn("[chesscom→lichess] lecture du PGN depuis la page impossible :", e);
      }
      const res = await browser.runtime.sendMessage({ type: "analyze", url: location.href, pgn, me: currentUser() });
      if (res.ok) toast("Partie importée sur Lichess ✔");
      else toast(res.error, true);
    } catch (e) {
      toast(e.message, true);
    } finally {
      busy = false;
      if (btn) {
        btn.disabled = false;
        btn.textContent = BTN_LABEL;
      }
    }
  }

  function update() {
    const onGame = GAME_URL_RE.test(location.href);
    let btn = document.getElementById(BTN_ID);
    if (onGame && !btn) {
      btn = document.createElement("button");
      btn.id = BTN_ID;
      btn.type = "button";
      btn.textContent = BTN_LABEL;
      btn.title = "Importer cette partie sur Lichess et ouvrir l'analyse";
      btn.addEventListener("click", run);
      document.body.appendChild(btn);
    } else if (!onGame && btn) {
      btn.remove();
    }
  }

  browser.runtime.onMessage.addListener((msg) => {
    if (msg.type === "trigger") run();
    else if (msg.type === "toast") toast(msg.text, true);
  });

  let lastUrl = "";
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      update();
    }
  }, 500);
  update();
})();
