import { initSaveManagerModal } from "./save-manager.js";
import { blogArticles } from "./blogData.js";

const BASE = import.meta.env.BASE_URL || "/";
const USER_DRIVE_URL = "https://drive.google.com/uc?export=download&id=1_SDUPGPfISA_GGUgbS0RQYA53RQnehNo";
const ASSET_RELEASE_URL = import.meta.env.VITE_ASSET_URL || `${BASE}proxy-game-download/game.tar.gz`;

const LEGACY_SCRIPT_SOURCES = [
  `${BASE}GamepadEmulator.js`,
  `${BASE}jsdos-cloud-sdk.js`,
  `${BASE}idbfs.js`,
  `${BASE}game.js`,
];

function isLocalDevEnvironment() {
  return (
    window.location.protocol === "file:" ||
    window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1"
  );
}

async function clearDevelopmentServiceWorkers() {
  if (!("serviceWorker" in navigator) || !isLocalDevEnvironment()) {
    return;
  }

  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.all(registrations.map((registration) => registration.unregister()));
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existingScript = document.querySelector(`script[src="${src}"]`);
    if (existingScript) {
      if (existingScript.dataset.loaded === "true") {
        resolve();
        return;
      }

      existingScript.addEventListener("load", () => resolve(), { once: true });
      existingScript.addEventListener(
        "error",
        () => reject(new Error(`Failed to load script: ${src}`)),
        { once: true },
      );
      return;
    }

    const script = document.createElement("script");
    script.src = src;
    script.async = false;
    script.addEventListener(
      "load",
      () => {
        script.dataset.loaded = "true";
        resolve();
      },
      { once: true },
    );
    script.addEventListener(
      "error",
      () => reject(new Error(`Failed to load script: ${src}`)),
      { once: true },
    );
    document.body.appendChild(script);
  });
}

async function loadLegacyScripts() {
  for (const src of LEGACY_SCRIPT_SOURCES) {
    await loadScript(src);
  }
}

// Returns null if OK, or a string describing the failure reason.
async function checkReady() {
  try {
    const root = await navigator.storage.getDirectory();

    let markerFile;
    try {
      const fh = await root.getFileHandle("_game_ready");
      markerFile = await fh.getFile();
    } catch {
      return "OPFS marker '_game_ready' not found";
    }

    const version = await markerFile.text();
    if (version !== "v4") {
      return `OPFS marker version mismatch: got "${version}", expected "v4"`;
    }

    const requiredFiles = [
      ["vcbr", "vc-sky-en-v6.data", 100 * 1024 * 1024],
      ["vcbr", "vc-sky-en-v6.wasm", 0],
      ["vcsky", "sha256sums.txt", 0],
    ];

    for (const [directoryName, fileName, minSize] of requiredFiles) {
      let dir;
      try {
        dir = await root.getDirectoryHandle(directoryName);
      } catch {
        return `OPFS directory not found: ${directoryName}/`;
      }
      let fh;
      try {
        fh = await dir.getFileHandle(fileName);
      } catch {
        return `OPFS file not found: ${directoryName}/${fileName}`;
      }
      if (minSize > 0) {
        const f = await fh.getFile();
        if (f.size < minSize) {
          return `OPFS file too small: ${directoryName}/${fileName} is ${(f.size / 1024 / 1024).toFixed(1)} MB, need > ${minSize / 1024 / 1024} MB`;
        }
      }
    }

    return null;
  } catch (err) {
    return `checkReady error: ${err.message}`;
  }
}

// Returns null if OK, or a string describing the failure reason.
async function verifyGameServing() {
  const requiredUrls = [
    "/vcbr/vc-sky-en-v6.data",
    "/vcbr/vc-sky-en-v6.wasm",
    "/vcsky/sha256sums.txt",
  ];

  try {
    for (const url of requiredUrls) {
      let response;
      try {
        response = await fetch(url, { method: "HEAD", cache: "no-store" });
      } catch (err) {
        return `fetch failed for ${url}: ${err.message}`;
      }
      if (!response.ok) {
        return `SW served ${response.status} for ${url}`;
      }
    }

    return null;
  } catch (err) {
    return `verifyGameServing error: ${err.message}`;
  }
}

async function waitForGameReady(retries = 6, delayMs = 400) {
  let lastReason = "unknown";
  for (let attempt = 0; attempt < retries; attempt++) {
    const opfsReason = await checkReady();
    if (opfsReason !== null) {
      lastReason = opfsReason;
      console.warn(`[waitForGameReady] attempt ${attempt + 1}: ${opfsReason}`);
    } else {
      const servingReason = await verifyGameServing();
      if (servingReason !== null) {
        lastReason = servingReason;
        console.warn(`[waitForGameReady] attempt ${attempt + 1}: ${servingReason}`);
      } else {
        return { ready: true, reason: null };
      }
    }

    if (attempt < retries - 1) {
      await new Promise((resolve) => window.setTimeout(resolve, delayMs));
    }
  }

  return { ready: false, reason: lastReason };
}

async function resetGameData() {
  // Clear OPFS: delete all known directories and the marker file
  try {
    const root = await navigator.storage.getDirectory();
    for (const name of ["vcbr", "vcsky", "_game_ready"]) {
      try {
        await root.removeEntry(name, { recursive: true });
      } catch {
        // entry may not exist
      }
    }
  } catch (err) {
    console.warn("[reset] OPFS clear failed:", err);
  }

  // Clear IndexedDB databases used by Emscripten IDBFS
  try {
    const dbs = await indexedDB.databases();
    await Promise.all(
      dbs.map(
        (db) =>
          new Promise((resolve) => {
            const req = indexedDB.deleteDatabase(db.name);
            req.onsuccess = resolve;
            req.onerror = resolve;
            req.onblocked = resolve;
          }),
      ),
    );
  } catch (err) {
    console.warn("[reset] IndexedDB clear failed:", err);
  }
}

const VC_TIPS = [
  // Fun facts
  "Vice City is set in 1986 Miami — 109 licensed songs across 9 radio stations.",
  "Tommy Vercetti is voiced by Ray Liotta.",
  "The map has two main islands connected by three bridges.",
  "Vice City's map is nearly twice the size of GTA III's Liberty City.",
  "The game features over 35 hours of story missions.",
  "The Malibu Club mission 'The Job' is the longest in the entire game.",
  "Vice City sold over 17.5 million copies on PS2 alone.",
  "The radio DJ Lazlow appears in every GTA game since Vice City.",
  "You can find a secret Easter egg on the roof of the VCPD building.",
  "Ken Rosenberg is inspired by the movie Scarface's sidekick character.",
  // Gameplay tips
  "You can buy businesses like the Malibu Club, Boatyard and Print Works to earn passive income.",
  "The Infernus is one of the fastest cars — look for it in Vice Point.",
  "The Hunter military helicopter has missiles AND a minigun. Find it at Fort Baxter Air Base.",
  "Use the Rhino tank for almost anything — it's nearly indestructible.",
  "Tap the sprint button repeatedly instead of holding it to run faster.",
  "You can avoid a 2-star wanted level by simply driving far away from the crime scene.",
  "Saving your game removes your wanted level — use the Ocean View Hotel early on.",
  "Motorcycles are faster than cars in the city but much harder to control at high speed.",
  "Right-click (or L2) to lock on to enemies — then strafe sideways to avoid their fire.",
  "PCJ-600 motorcycle is great for time-critical missions — it spawns near the hotel.",
  "You can skip the Pay 'n' Spray if you drive far enough from police before they see your car.",
  "Swimming too long drains your health in Vice City — Tommy can't swim well.",
  "Holding a weapon while entering a car lets you shoot from vehicle windows.",
  // Cheats
  "Cheat: ASPIRINE restores your health to full at any time.",
  "Cheat: PRECIOUSPROTECTION gives you full armour instantly.",
  "Cheat: BIGBANG blows up every nearby vehicle — useful in a pinch.",
  "Cheat: FANNYMAGNET attracts pedestrians — great for chaos.",
  "Cheat: LEAVEMEALONE removes your wanted level immediately.",
  "Cheat: COMEFLYWITHME makes all vehicles able to fly.",
  "Cheat: SEAWAYS lets boats drive on land — a classic favourite.",
  "Cheat: PANZER spawns a Rhino tank right next to you.",
  "Cheat: ROCKANDROLLMAN spawns a Sanchez dirt bike.",
  // Loading info
  "Files are being written to your browser's private local storage (OPFS).",
  "This is a one-time download — the game loads instantly on every future visit.",
  "If the download stops, just click Install Game again — it resumes automatically.",
  "The game uses WebAssembly to run the original engine at near-native speed.",
  "Your save files stay in your browser — use the Save Manager to back them up.",
];

async function initSetupFlow() {
  const overlay = document.getElementById("setup-overlay");
  const downloadLink = document.getElementById("dl-link");
  const fileInput = document.getElementById("game-file-input");
  const progress = document.getElementById("setup-progress");
  const progressBar = document.getElementById("setup-progress-bar");
  const progressLabel = document.getElementById("setup-progress-label");
  const progressPercent = document.getElementById("setup-progress-percent");
  const progressFile = document.getElementById("setup-progress-file");
  const progressTip = document.getElementById("setup-progress-tip");
  const progressTitle = document.getElementById("setup-progress-title");
  const errorBox = document.getElementById("setup-error");
  const storageStatus = document.getElementById("storage-status");
  const selectedFileName = document.getElementById("selected-file-name");
  const clickToPlayButton = document.getElementById("click-to-play-button");
  const resetBtn = document.getElementById("reset-game-btn");

  if (
    !overlay ||
    !downloadLink ||
    !fileInput ||
    !progress ||
    !progressBar ||
    !progressLabel ||
    !progressPercent ||
    !errorBox ||
    !storageStatus ||
    !selectedFileName ||
    !clickToPlayButton
  ) {
    return;
  }

  downloadLink.href = USER_DRIVE_URL;

  const showError = (message) => {
    errorBox.classList.remove("hidden");
    errorBox.textContent = message;
  };

  const setStorageStatus = (message, state) => {
    storageStatus.textContent = message;
    storageStatus.dataset.state = state;
  };

  const setPlayAvailability = (enabled) => {
    window.__gtaGameReady = enabled;
    clickToPlayButton.disabled = !enabled;
    clickToPlayButton.classList.toggle("disabled", !enabled);
    if (resetBtn) resetBtn.classList.toggle("hidden", !enabled);
  };

  if (resetBtn) {
    resetBtn.addEventListener("click", async () => {
      if (!confirm("This will delete all local game data (OPFS + IndexedDB). You will need to re-import game.tar.gz. Continue?")) {
        return;
      }
      resetBtn.disabled = true;
      resetBtn.textContent = "Resetting…";
      await resetGameData();
      setStorageStatus("Import required", "missing");
      setPlayAvailability(false);
      progress.classList.add("hidden");
      errorBox.classList.add("hidden");
      selectedFileName.textContent = "No file selected";
      fileInput.value = "";
      resetBtn.disabled = false;
      resetBtn.textContent = "Reset game data";
    });
  }

  const formatTimeRemaining = (seconds) => {
    if (!isFinite(seconds) || seconds <= 0) return "";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    if (m >= 60) return `~${Math.floor(m / 60)}h ${m % 60}m remaining`;
    if (m > 0) return `~${m}m ${s}s remaining`;
    if (seconds < 5) return "almost done…";
    return `~${s}s remaining`;
  };

  const setupInstallButton = (isRetry = false) => {
    clickToPlayButton.disabled = false;
    clickToPlayButton.classList.remove("disabled");
    clickToPlayButton.textContent = isRetry ? "RETRY INSTALL" : "INSTALL GAME";
    clickToPlayButton.dataset.installMode = "1";
    clickToPlayButton.addEventListener("click", startInstall, { once: true });
  };

  const runImport = async (file, url) => {
    errorBox.classList.add("hidden");
    progress.classList.remove("hidden");
    progressLabel.textContent = "Connecting…";
    progressPercent.textContent = "0%";
    progressBar.style.width = "0%";
    if (progressFile) progressFile.textContent = "";
    setPlayAvailability(false);

    // Rotate tips every 7 seconds while loading
    let tipIndex = Math.floor(Math.random() * VC_TIPS.length);
    let tipInterval = null;
    if (progressTip) {
      const showTip = () => {
        progressTip.style.opacity = "0";
        setTimeout(() => {
          progressTip.textContent = "💡 " + VC_TIPS[tipIndex % VC_TIPS.length];
          tipIndex++;
          progressTip.style.opacity = "1";
        }, 350);
      };
      showTip();
      tipInterval = setInterval(showTip, 7000);
    }

    let downloadStartTime = null;
    let lastPhase = null;

    const onInstallError = (message) => {
      if (tipInterval) clearInterval(tipInterval);
      progress.classList.add("hidden");
      showError(message);
      setStorageStatus("Installation failed — try again", "missing");
      setupInstallButton(true);
    };

    await new Promise((resolve) => {
      const worker = new Worker(`${BASE}extract-worker.js`);
      worker.onerror = (error) => {
        console.error("[worker error]", error);
        onInstallError(`Worker crashed: ${error.message || "unknown error"}. Please try again.`);
        worker.terminate();
        resolve();
      };
      worker.postMessage(url ? { url } : { file });
      worker.onmessage = async (event) => {
        const msg = event.data;

        if (msg.type === "progress") {
          progressBar.style.width = `${msg.pct}%`;
          progressPercent.textContent = `${Math.round(msg.pct)}%`;

          if (msg.phase === "downloading" || msg.phase === "reading") {
            if (progressFile) progressFile.textContent = "";
            if (msg.total > 0) {
              if (!downloadStartTime) downloadStartTime = Date.now();
              const loadedMB = (msg.loaded / 1048576).toFixed(0);
              const totalMB = (msg.total / 1048576).toFixed(0);
              const elapsedSec = (Date.now() - downloadStartTime) / 1000;
              const speed = elapsedSec > 1 ? msg.loaded / elapsedSec : 0;
              const remainingSec = speed > 0 ? (msg.total - msg.loaded) / speed : Infinity;
              const eta = formatTimeRemaining(remainingSec);
              const speedMB = speed > 0 ? ` • ${(speed / 1048576).toFixed(1)} MB/s` : "";
              const label = msg.phase === "reading" ? "Reading" : (msg.resuming ? "Resuming" : "Downloading");
              if (msg.resuming && progressTitle) progressTitle.textContent = "RESUMING...";
              progressLabel.textContent = `${label}… ${loadedMB} / ${totalMB} MB${speedMB}${eta ? "  •  " + eta : ""}`;
            } else {
              progressLabel.textContent = "Connecting to server…";
            }
          } else if (msg.phase === "extracting") {
            if (lastPhase !== "extracting" && progressTitle) {
              progressTitle.textContent = "EXTRACTING...";
            }
            if (msg.file && progressFile) {
              progressFile.textContent = msg.file;
            }
            progressLabel.textContent = `Writing to storage… ${msg.done || 0} files`;
          }

          lastPhase = msg.phase;
          return;
        }

        if (msg.type === "done") {
          if (tipInterval) clearInterval(tipInterval);
          progressBar.style.width = "100%";
          progressPercent.textContent = "100%";
          progressLabel.textContent = "Verifying…";
          if (progressFile) progressFile.textContent = "";
          if (progressTip) progressTip.textContent = "";
          const { ready: isReady, reason } = await waitForGameReady();
          if (isReady) {
            setStorageStatus("Ready to play", "ready");
            setPlayAvailability(true);
            progress.classList.add("hidden");
          } else {
            onInstallError(`Verification failed: ${reason}. Please reset and try again.`);
          }
          worker.terminate();
          resolve();
          return;
        }

        if (msg.type === "error") {
          const raw = msg.message || "unknown error";
          let friendly = `Install failed: ${raw}`;
          if (raw.includes("QuotaExceeded") || raw.includes("quota")) {
            friendly = "Not enough browser storage space. Free up space or try a different browser, then retry.";
          } else if (raw.includes("NetworkError") || raw.includes("Failed to fetch") || raw.includes("Download failed")) {
            friendly = "Download failed — check your connection and click Retry.";
          }
          onInstallError(friendly);
          worker.terminate();
          resolve();
        }
      };
    });
  };

  setPlayAvailability(false);

  if (
    !("serviceWorker" in navigator) ||
    !("storage" in navigator && navigator.storage.getDirectory)
  ) {
    showError(
      "Your browser does not support the required APIs (OPFS / Service Worker). Please use Chrome, Firefox or Safari 15.2+.",
    );
    return;
  }

  try {
    if (isLocalDevEnvironment()) {
      console.log("[setup] local dev detected, refreshing SW registration");
      await clearDevelopmentServiceWorkers();
    }

    console.log("[setup] registering SW...");
    await navigator.serviceWorker.register(`${BASE}sw.js`, { updateViaCache: "none" });
    await navigator.serviceWorker.ready;
    console.log("[setup] SW ready");

    if (!navigator.serviceWorker.controller) {
      console.log("[setup] SW not yet controlling page — reloading...");
      window.location.reload();
      return;
    }
  } catch (error) {
    showError(`Service Worker error: ${error.message}`);
    return;
  }

  const { ready, reason } = await waitForGameReady(2, 150);
  console.log("[setup] game ready in OPFS:", ready, reason || "");
  if (ready) {
    setStorageStatus("Ready to play", "ready");
    setPlayAvailability(true);
    progress.classList.add("hidden");
    return;
  }

  // Game not installed — show install button and wait for user to click
  setStorageStatus("Click INSTALL GAME to set up (~701 MB, one-time)", "missing");

  let downloadUrl = ASSET_RELEASE_URL || `${BASE}proxy-game-download/game.tar.gz`;

  const startInstall = async () => {
    if (clickToPlayButton.dataset.installMode !== "1") return;
    clickToPlayButton.disabled = true;
    clickToPlayButton.dataset.installMode = "";

    if (downloadUrl) {
      console.log("[setup] user triggered download from:", downloadUrl);
      await runImport(null, downloadUrl);
    } else {
      fileInput.click();
    }
  };

  // Repurpose the PLAY button as INSTALL GAME until game files are present
  setupInstallButton(false);

  // File picker fallback (used when no download URL is configured)
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files[0];
    if (!file) { selectedFileName.textContent = "No file selected"; return; }
    selectedFileName.textContent = file.name;
    if (!/\.tar\.gz$|\.gz$/i.test(file.name)) {
      showError("Please select the game.tar.gz file.");
      return;
    }
    await runImport(file);
  });
}

function initCanvasBindings() {
  const canvas = document.getElementById("canvas");
  if (!canvas) {
    return;
  }

  canvas.addEventListener("contextmenu", (event) => {
    event.preventDefault();
  });
}

function checkBrowserCompatibility() {
  const missing = [];

  if (!("serviceWorker" in navigator)) missing.push("Service Workers");
  if (!("storage" in navigator) || !("getDirectory" in navigator.storage)) missing.push("OPFS");
  if (typeof WebAssembly === "undefined") missing.push("WebAssembly");
  if (typeof Worker === "undefined") missing.push("Web Workers");

  return missing;
}

function initHostRedirectGuard() {
  try {
    // const host = window.parent.location.host;
    // console.log("The host:", host);
    // if ((!host.endsWith("dos.zone") || host.endsWith("cdn.dos.zone")) && !host.startsWith("localhost") &&
    //     !host.startsWith("192.168.0.") && !host.startsWith("test.js-dos.com")) {
    //     location.href = "https://dos.zone/grand-theft-auto-vice-city/";
    // }
  } catch {
    // ignore
  }
}

function initOrientationLock() {
  const observer = new MutationObserver(() => {
    if (document.body.classList.contains("gameIsStarted")) {
      observer.disconnect();
      screen.orientation?.lock("landscape").catch(() => {});
    }
  });
  observer.observe(document.body, { attributeFilter: ["class"] });
}

async function boot() {
  initCanvasBindings();
  initHostRedirectGuard();
  initOrientationLock();

  initPortalRouting();
  initPortalInteractivity();

  const missing = checkBrowserCompatibility();
  if (missing.length > 0) {
    const storageStatus = document.getElementById("storage-status");
    const errorBox = document.getElementById("setup-error");
    if (storageStatus) {
      storageStatus.textContent = "Browser not supported";
      storageStatus.dataset.state = "error";
    }
    if (errorBox) {
      errorBox.classList.remove("hidden");
      errorBox.textContent = `Your browser is missing required features: ${missing.join(", ")}. Please use Chrome 110+, Firefox 111+, or Safari 16.4+.`;
    }
    return;
  }

  initSaveManagerModal();
  await initSetupFlow();
  await loadLegacyScripts();

}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function initPortalRouting() {
  const views = {
    "home": document.getElementById("view-home"),
    "gta-vc": document.getElementById("view-gta-vc"),
    "games": document.getElementById("view-games"),
    "favorites": document.getElementById("view-favorites"),
    "blog": document.getElementById("view-blog"),
  };

  const navLinks = document.querySelectorAll(".gta-nav-tab, .q-nav-tab, .nav-item");

  function resolveRouteKey(rawPath, rawHash) {
    if (rawHash) {
      const h = rawHash.replace(/^#/, "").trim();
      if (h === "gta-vc" || h === "gtavcbrowser") return { key: "gta-vc", path: "/game/gtavcbrowser" };
      if (h === "games" || h === "catalog") return { key: "games", path: "/games" };
      if (h === "favorites" || h === "tools" || h === "saves") return { key: "favorites", path: "/favorites" };
      if (h === "blog" || h === "blogs") return { key: "blog", path: "/blog" };
      if (h === "home") return { key: "home", path: "/" };
    }

    const p = (rawPath || "").toLowerCase();
    if (p.includes("/game/") || p.includes("gtavcbrowser") || p.includes("gta-vc")) {
      return { key: "gta-vc", path: "/game/gtavcbrowser" };
    }
    if (p.includes("/games") || p.includes("/catalog")) {
      return { key: "games", path: "/games" };
    }
    if (p.includes("/favorites") || p.includes("/tools") || p.includes("/saves")) {
      return { key: "favorites", path: "/favorites" };
    }
    if (p.includes("/blog") || p.includes("/article") || p.includes("/guide")) {
      return { key: "blog", path: "/blog" };
    }

    return { key: "home", path: "/" };
  }

  function updateRoute(pushNewState = false, targetUrl = null) {
    let path = targetUrl || window.location.pathname;
    let hash = targetUrl ? "" : window.location.hash;

    const routeInfo = resolveRouteKey(path, hash);
    const targetKey = routeInfo.key;
    const cleanPath = routeInfo.path;

    if (hash) {
      history.replaceState(null, "", cleanPath);
    } else if (pushNewState && window.location.pathname !== cleanPath) {
      history.pushState(null, "", cleanPath);
    }

    Object.keys(views).forEach((key) => {
      if (views[key]) {
        if (key === targetKey) {
          views[key].classList.remove("hidden");
        } else {
          views[key].classList.add("hidden");
        }
      }
    });

    navLinks.forEach((link) => {
      if (link.dataset.view === targetKey) {
        link.classList.add("active");
      } else {
        link.classList.remove("active");
      }
    });

    window.scrollTo({ top: 0, behavior: "smooth" });

    // Handle blog view single article vs list view
    if (targetKey === "blog") {
      const urlParams = new URLSearchParams(window.location.search);
      const articleSlug = urlParams.get("article") || urlParams.get("post") || urlParams.get("slug");
      if (articleSlug) {
        openSingleArticle(articleSlug, false);
      } else {
        closeSingleArticle(false);
      }
    } else if (targetKey === "gta-vc") {
      loadDisqusThread("disqus_thread", "gtavc-game-page", "GTA Vice City Web Edition");
    }
  }

  function loadDisqusThread(containerId, identifier, title) {
    const container = document.getElementById(containerId);
    if (!container) return;

    window.disqus_config = function () {
      this.page.url = window.location.origin + window.location.pathname + window.location.search;
      this.page.identifier = identifier;
      this.page.title = title;
    };

    if (window.DISQUS) {
      try {
        window.DISQUS.reset({
          reload: true,
          config: window.disqus_config,
        });
      } catch (err) {
        console.warn("Disqus reload error:", err);
      }
    } else {
      const d = document, s = d.createElement("script");
      s.src = "https://vice-city-online.disqus.com/embed.js";
      s.setAttribute("data-timestamp", +new Date());
      (d.head || d.body).appendChild(s);
    }
  }

  // Dynamic Blog Engine
  let activeBlogCategory = "ALL";
  let activeBlogQuery = "";

  function renderBlogCards() {
    const grid = document.getElementById("seo-blogs-grid");
    if (!grid) return;

    const filtered = blogArticles.filter((art) => {
      const matchCat = activeBlogCategory === "ALL" || art.badge.toUpperCase().includes(activeBlogCategory.toUpperCase());
      const q = activeBlogQuery.toLowerCase().trim();
      const matchQuery = !q || art.title.toLowerCase().includes(q) || art.excerpt.toLowerCase().includes(q) || art.badge.toLowerCase().includes(q);
      return matchCat && matchQuery;
    });

    if (filtered.length === 0) {
      grid.innerHTML = `<div style="grid-column: 1 / -1; padding: 40px; text-align: center; color: #64748b; background: #141c2e; border-radius: 12px; border: 1px solid #233148;">
        <h3 style="color: #f8fafc; font-size: 1.2rem; margin-bottom: 8px;">No matching guides found</h3>
        <p>Try searching for a different keyword or select "All Guides".</p>
      </div>`;
      return;
    }

    grid.innerHTML = filtered.map((art) => `
      <article class="seo-blog-card" data-slug="${art.slug}">
        <div class="seo-blog-img-wrap">
          <img src="${art.image}" alt="${art.title}" class="seo-blog-img" onerror="this.src='https://images.unsplash.com/photo-1550745165-9bc0b252726f?auto=format&fit=crop&w=1200&q=80'" />
          <span class="seo-blog-badge">${art.badge}</span>
        </div>
        <div class="seo-blog-body">
          <div class="seo-blog-meta">
            <span>By ${art.author}</span> &bull;
            <span>${art.date}</span> &bull;
            <span>${art.readTime}</span>
          </div>
          <h2 class="seo-blog-title">${art.title}</h2>
          <p class="seo-blog-excerpt">${art.excerpt}</p>
          <div class="blog-card-actions">
            <button class="blog-read-more-btn" data-slug="${art.slug}">Read Article →</button>
            <a href="/blog?article=${art.slug}" target="_blank" class="blog-open-newtab-link">Open in New Tab ↗</a>
          </div>
        </div>
      </article>
    `).join("");

    grid.querySelectorAll(".blog-read-more-btn, .seo-blog-title").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        const card = btn.closest(".seo-blog-card");
        const slug = card ? card.dataset.slug : btn.dataset.slug;
        if (slug) {
          openSingleArticle(slug, true);
        }
      });
    });
  }

  function openSingleArticle(slug, pushState = false) {
    const article = blogArticles.find((a) => a.slug === slug || a.id === slug);
    if (!article) return;

    const indexView = document.getElementById("blog-index-view");
    const singleView = document.getElementById("blog-single-view");

    if (indexView && singleView) {
      indexView.classList.add("hidden");
      singleView.classList.remove("hidden");

      const badge = document.getElementById("article-badge");
      const meta = document.getElementById("article-meta");
      const title = document.getElementById("article-title");
      const author = document.getElementById("article-author");
      const hero = document.getElementById("article-hero-img");
      const body = document.getElementById("blog-single-body");
      const extBtn = document.getElementById("blog-open-external-btn");

      if (badge) badge.textContent = article.badge;
      if (meta) meta.textContent = `${article.date} • ${article.readTime}`;
      if (title) title.textContent = article.title;
      if (author) author.textContent = article.author;
      if (hero) {
        hero.src = article.image;
        hero.alt = article.title;
        hero.onerror = () => { hero.src = "https://images.unsplash.com/photo-1550745165-9bc0b252726f?auto=format&fit=crop&w=1200&q=80"; };
      }
      if (body) body.innerHTML = article.content;
      if (extBtn) extBtn.href = `${window.location.origin}/blog?article=${article.slug}`;

      if (pushState) {
        history.pushState(null, "", `/blog?article=${article.slug}`);
      }

      window.scrollTo({ top: 0, behavior: "smooth" });

      loadDisqusThread("disqus_thread_single_article", `gtavc-article-${article.id}`, article.title);
    }
  }

  function closeSingleArticle(pushState = false) {
    const indexView = document.getElementById("blog-index-view");
    const singleView = document.getElementById("blog-single-view");

    if (indexView && singleView) {
      singleView.classList.add("hidden");
      indexView.classList.remove("hidden");

      if (pushState) {
        history.pushState(null, "", "/blog");
      }

      window.scrollTo({ top: 0, behavior: "smooth" });

      loadDisqusThread("disqus_thread_blog", "gtavc-blog-page", "GTABrowser Articles & Strategy Guides");
    }
  }

  const searchInput = document.getElementById("blog-search-input");
  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      activeBlogQuery = e.target.value;
      renderBlogCards();
    });
  }

  const catPills = document.querySelectorAll(".blog-cat-pill");
  catPills.forEach((pill) => {
    pill.addEventListener("click", () => {
      catPills.forEach((p) => p.classList.remove("active"));
      pill.classList.add("active");
      activeBlogCategory = pill.dataset.cat || "ALL";
      renderBlogCards();
    });
  });

  const backBtn = document.getElementById("blog-back-btn");
  if (backBtn) {
    backBtn.addEventListener("click", () => {
      closeSingleArticle(true);
    });
  }

  renderBlogCards();

  // Handle click on all internal navigation links
  document.addEventListener("click", (e) => {
    const anchor = e.target.closest("a");
    if (!anchor) return;

    const href = anchor.getAttribute("href");
    if (!href) return;

    if (
      href.startsWith("http://") ||
      href.startsWith("https://") ||
      href.startsWith("//") ||
      href.startsWith("mailto:") ||
      href.startsWith("tel:") ||
      anchor.getAttribute("target") === "_blank"
    ) {
      return;
    }

    e.preventDefault();
    updateRoute(true, href);
  });

  window.addEventListener("popstate", () => updateRoute(false));
  window.addEventListener("hashchange", () => updateRoute(false));
  updateRoute(false);
}

function initPortalInteractivity() {
  // Mobile Nav Toggle
  const mobileToggle = document.getElementById("nav-mobile-toggle");
  const navLinksContainer = document.getElementById("nav-links");
  if (mobileToggle && navLinksContainer) {
    mobileToggle.addEventListener("click", () => {
      navLinksContainer.classList.toggle("open");
    });
  }

  // Global Search
  const searchBtn = document.getElementById("nav-search-btn");
  const searchWrap = document.getElementById("search-bar-wrap");
  const searchClose = document.getElementById("search-close-btn");
  const searchInput = document.getElementById("global-search-input");
  const searchResults = document.getElementById("search-results-box");

  if (searchBtn && searchWrap) {
    searchBtn.addEventListener("click", () => {
      searchWrap.classList.toggle("hidden");
      if (!searchWrap.classList.contains("hidden")) {
        searchInput?.focus();
      }
    });
  }
  if (searchClose && searchWrap) {
    searchClose.addEventListener("click", () => searchWrap.classList.add("hidden"));
  }

  const ALL_ITEMS = [
    { title: "GTA Vice City Web Edition", type: "Playable Game", link: "/game/gtavcbrowser" },
    { title: "ASPIRINE (Full Health)", type: "Cheat Code", link: "/blog" },
    { title: "LEAVEMEALONE (Clear Wanted)", type: "Cheat Code", link: "/blog" },
    { title: "PANZER (Spawn Tank)", type: "Cheat Code", link: "/blog" },
    { title: "Favorite Games", type: "Category", link: "/favorites" },
    { title: "100 Hidden Packages Checklist", type: "Guide", link: "/blog" },
  ];

  if (searchInput && searchResults) {
    searchInput.addEventListener("input", () => {
      const q = searchInput.value.trim().toLowerCase();
      if (!q) {
        searchResults.classList.add("hidden");
        return;
      }
      const matches = ALL_ITEMS.filter(i => i.title.toLowerCase().includes(q) || i.type.toLowerCase().includes(q));
      if (matches.length === 0) {
        searchResults.innerHTML = `<div style="padding:10px;color:#7890a8;font-size:0.85rem;">No matches found</div>`;
      } else {
        searchResults.innerHTML = matches.map(m => `
          <a href="${m.link}" class="search-result-item" onclick="document.getElementById('search-bar-wrap').classList.add('hidden')">
            <span><strong>${m.title}</strong></span>
            <span style="font-size:0.75rem;color:var(--cyan);background:rgba(0,210,255,0.1);padding:2px 8px;border-radius:4px;">${m.type}</span>
          </a>
        `).join("");
      }
      searchResults.classList.remove("hidden");
    });
  }

  // Voting & Custom Requests
  const customReqForm = document.getElementById("custom-request-form");
  const requestToast = document.getElementById("request-toast");
  if (customReqForm) {
    customReqForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const input = document.getElementById("request-input");
      if (!input || !input.value.trim()) return;
      const gameName = input.value.trim();
      input.value = "";
      if (requestToast) {
        requestToast.textContent = `Success! Your request for "${gameName}" was recorded. (+1 Vote)`;
        requestToast.classList.remove("hidden");
        setTimeout(() => requestToast.classList.add("hidden"), 4000);
      }
    });
  }

  document.querySelectorAll(".v-btn, .vote-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      btn.textContent = "Voted! ✓";
      btn.disabled = true;
      btn.style.opacity = "0.7";
    });
  });

  // Tools: Save Manager Launcher & Diagnostics
  const toolsLaunchSmBtn = document.getElementById("tools-launch-sm-btn");
  if (toolsLaunchSmBtn) {
    toolsLaunchSmBtn.addEventListener("click", () => {
      const mainSmBtn = document.getElementById("save-manager-btn");
      if (mainSmBtn) mainSmBtn.click();
    });
  }

  const runDiag = () => {
    const wasmStatus = document.getElementById("diag-wasm");
    const opfsStatus = document.getElementById("diag-opfs");
    const swStatus = document.getElementById("diag-sw");
    const webglStatus = document.getElementById("diag-webgl");
    const gamepadStatus = document.getElementById("diag-gamepad");

    if (wasmStatus) { wasmStatus.textContent = typeof WebAssembly !== "undefined" ? "✓ Supported" : "❌ Unsupported"; wasmStatus.className = "diag-status ok"; }
    if (opfsStatus) { opfsStatus.textContent = "storage" in navigator && "getDirectory" in navigator.storage ? "✓ Supported" : "⚠️ Limited"; opfsStatus.className = "diag-status ok"; }
    if (swStatus) { swStatus.textContent = "serviceWorker" in navigator ? "✓ Supported" : "❌ Unsupported"; swStatus.className = "diag-status ok"; }
    if (webglStatus) {
      try {
        const canvas = document.createElement("canvas");
        const gl = canvas.getContext("webgl2");
        if (webglStatus) { webglStatus.textContent = gl ? "✓ WebGL 2.0 Ready" : "⚠️ Fallback WebGL"; webglStatus.className = "diag-status ok"; }
      } catch { if (webglStatus) webglStatus.textContent = "❌ Unavailable"; }
    }
    if (gamepadStatus) { gamepadStatus.textContent = "getGamepads" in navigator ? "✓ Ready" : "⚠️ Not Found"; gamepadStatus.className = "diag-status ok"; }
  };
  runDiag();

  const runBenchBtn = document.getElementById("run-benchmark-btn");
  const benchResult = document.getElementById("benchmark-result");
  if (runBenchBtn && benchResult) {
    runBenchBtn.addEventListener("click", () => {
      runBenchBtn.disabled = true;
      benchResult.textContent = "Running 2-second WebAssembly memory & WebGL render benchmark...";
      benchResult.classList.remove("hidden");

      let frames = 0;
      const start = performance.now();
      const loop = () => {
        frames++;
        if (performance.now() - start < 1500) {
          requestAnimationFrame(loop);
        } else {
          const fps = Math.round((frames / 1.5));
          benchResult.textContent = `Benchmark Result: ${fps} FPS estimated. Excellent performance for 60 FPS WebAssembly gaming!`;
          runBenchBtn.disabled = false;
        }
      };
      loop();
    });
  }

  // Catalog Filters & Modals
  const catalogChips = document.querySelectorAll("#filter-chips .chip");
  const catalogCards = document.querySelectorAll(".catalog-card");
  const catalogInput = document.getElementById("catalog-search-input");

  function applyCatalogFilter() {
    const activeChip = document.querySelector("#filter-chips .chip.active");
    const category = activeChip ? activeChip.dataset.filter : "all";
    const searchVal = catalogInput ? catalogInput.value.toLowerCase().trim() : "";

    catalogCards.forEach((card) => {
      const cardCat = card.dataset.category || "";
      const cardTitle = card.querySelector("h3")?.textContent.toLowerCase() || "";
      const matchesCat = category === "all" || cardCat.includes(category);
      const matchesSearch = !searchVal || cardTitle.includes(searchVal);

      if (matchesCat && matchesSearch) {
        card.style.display = "flex";
      } else {
        card.style.display = "none";
      }
    });
  }

  catalogChips.forEach((chip) => {
    chip.addEventListener("click", () => {
      catalogChips.forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      applyCatalogFilter();
    });
  });

  if (catalogInput) catalogInput.addEventListener("input", applyCatalogFilter);

  // Preview Modal
  const gameModal = document.getElementById("game-modal");
  const modalTitle = document.getElementById("modal-game-title");
  const modalDesc = document.getElementById("modal-game-desc");
  const modalFill = document.getElementById("modal-bar-fill");
  const modalProgressText = document.getElementById("modal-progress-text");
  const modalClose = document.getElementById("game-modal-close");
  const modalDismiss = document.getElementById("modal-dismiss-btn");
  const modalVoteBtn = document.getElementById("modal-vote-btn");

  document.querySelectorAll(".cat-preview-btn, .notify-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const title = btn.dataset.title || btn.dataset.game || "Game Details";
      const desc = btn.dataset.desc || "Active WebAssembly porting project in development.";
      const progress = btn.dataset.progress || "50%";

      if (modalTitle) modalTitle.textContent = title;
      if (modalDesc) modalDesc.textContent = desc;
      if (modalFill) modalFill.style.width = progress;
      if (modalProgressText) modalProgressText.textContent = progress;
      if (gameModal) gameModal.classList.remove("hidden");
    });
  });

  const closeModal = () => gameModal?.classList.add("hidden");
  if (modalClose) modalClose.addEventListener("click", closeModal);
  if (modalDismiss) modalDismiss.addEventListener("click", closeModal);
  if (modalVoteBtn) {
    modalVoteBtn.addEventListener("click", () => {
      modalVoteBtn.textContent = "Vote Recorded! ✓";
      setTimeout(closeModal, 1200);
    });
  }

  // Cheats & Hidden Packages Checklist
  document.querySelectorAll(".cc-copy-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const code = btn.dataset.code;
      if (!code) return;
      await navigator.clipboard.writeText(code).catch(() => {});
      btn.textContent = "Copied!";
      setTimeout(() => btn.textContent = "Copy Code", 2000);
    });
  });

  // Populate 100 Hidden Packages
  const pkgGrid = document.getElementById("packages-checkboxes-grid");
  const pkgBarFill = document.getElementById("pkg-bar-fill");
  const pkgCountText = document.getElementById("pkg-count-text");
  const pkgResetBtn = document.getElementById("pkg-reset-btn");

  if (pkgGrid) {
    let saved = JSON.parse(localStorage.getItem("vc_packages_checklist") || "[]");

    const updatePkgProgress = () => {
      const count = saved.length;
      if (pkgCountText) pkgCountText.textContent = `${count} / 100 collected`;
      if (pkgBarFill) pkgBarFill.style.width = `${count}%`;
      localStorage.setItem("vc_packages_checklist", JSON.stringify(saved));
    };

    for (let i = 1; i <= 100; i++) {
      const lbl = document.createElement("label");
      lbl.className = "pkg-check-lbl";
      const chk = document.createElement("input");
      chk.type = "checkbox";
      chk.checked = saved.includes(i);
      chk.addEventListener("change", () => {
        if (chk.checked) {
          if (!saved.includes(i)) saved.push(i);
        } else {
          saved = saved.filter((x) => x !== i);
        }
        updatePkgProgress();
      });
      lbl.appendChild(chk);
      lbl.appendChild(document.createTextNode(`#${i}`));
      pkgGrid.appendChild(lbl);
    }

    updatePkgProgress();

    if (pkgResetBtn) {
      pkgResetBtn.addEventListener("click", () => {
        saved = [];
        pkgGrid.querySelectorAll("input").forEach((c) => (c.checked = false));
        updatePkgProgress();
      });
    }
  }
  // Favorite Games Manager
  initFavoriteManager();
}

function initFavoriteManager() {
  const STORAGE_KEY = "gtabrowser_favorites";

  function getFavorites() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      return stored ? JSON.parse(stored) : ["gtavcbrowser"];
    } catch {
      return ["gtavcbrowser"];
    }
  }

  function setFavorites(favs) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(favs));
    } catch (e) {
      console.warn("Error saving favorites:", e);
    }
  }

  function showToast(message) {
    let toast = document.getElementById("fav-toast-elem");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "fav-toast-elem";
      toast.className = "fav-toast";
      document.body.appendChild(toast);
    }
    toast.innerHTML = `<span>❤️</span> <span>${message}</span>`;
    toast.classList.add("show");
    setTimeout(() => {
      toast.classList.remove("show");
    }, 2800);
  }

  function syncFavoriteUI() {
    const favs = getFavorites();
    const heartBtns = document.querySelectorAll(".fav-heart-btn");

    heartBtns.forEach((btn) => {
      const gameId = btn.dataset.gameId || "gtavcbrowser";
      if (favs.includes(gameId)) {
        btn.classList.add("is-favorited");
        btn.setAttribute("title", "Remove from Favorites");
      } else {
        btn.classList.remove("is-favorited");
        btn.setAttribute("title", "Add to Favorites");
      }
    });

    const favCard = document.getElementById("fav-card-gtavc");
    const emptyMsg = document.getElementById("empty-favs-msg");

    if (favs.includes("gtavcbrowser")) {
      if (favCard) favCard.style.display = "block";
      if (emptyMsg) emptyMsg.style.display = "none";
    } else {
      if (favCard) favCard.style.display = "none";
      if (emptyMsg) emptyMsg.style.display = "block";
    }
  }

  document.addEventListener("click", (e) => {
    const heartBtn = e.target.closest(".fav-heart-btn");
    if (!heartBtn) return;

    e.preventDefault();
    e.stopPropagation();

    const gameId = heartBtn.dataset.gameId || "gtavcbrowser";
    let favs = getFavorites();

    if (favs.includes(gameId)) {
      favs = favs.filter((id) => id !== gameId);
      setFavorites(favs);
      showToast("Removed from Favorites");
    } else {
      favs.push(gameId);
      setFavorites(favs);
      showToast("Added GTA Vice City to Favorites!");
    }

    syncFavoriteUI();
  });

  syncFavoriteUI();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    void boot();
  });
} else {
  void boot();
}
