const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ACTIVE_TAB = false;
const NAV_TIMEOUT_MS = 20000;
const READY_TIMEOUT_MS = 8000;

let batchRunning = false;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "startBatch") {
    if (batchRunning) {
      sendResponse({ ok: false, error: "A batch is already running." });
      return;
    }
    runBatch(msg.shipments).catch((err) => {
      console.error("[SW] batch failed: ", err);
      batchRunning = false;
    });
    sendResponse({ ok: true });
  }
});

// --------- Progress ---------------

async function setProgress(patch) {
  const { progress = {} } = await chrome.storage.local.get("progress");
  await chrome.storage.local.set({ progress: { ...progress, ...patch } });
}

async function setBadge(text) {
  await chrome.action.setBadgeBackgroundColor({ color: "#2563eb" });
  await chrome.action.setBadgeText({ text });
}

// ------------ navigation -----------

function navigate(tabId, url) {
  return new Promise((resolve, reject) => {
    let sawLoading = false;

    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(
        new Error(`Navigation timed out after ${NAV_TIMEOUT_MS}ms: ${url}`)
      );
    }, NAV_TIMEOUT_MS);

    function listener(id, info) {
      if (id !== tabId) return;
      if (info.status === "loading") sawLoading = true;
      if (info.status === "complete" && sawLoading) {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.update(tabId, { url }).catch((err) => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      reject(err);
    });
  });
}

async function prepareLabelPage(tabId) {
  // Must run AFTER the new document loads; CSS injected earlier is discarded
  await chrome.scripting.insertCSS({
    target: { tabId },
    css: `html {overflow-y: hidden !important;}`,
  });
}

/**
 * Poll until the expected number of #page-wrap elements exist AND everything
 * visual inside them has finished loading: <img>, <canvas> (non-empty),
 * CSS background images, and web fonts. Returns the label count found, which
 * may be lower than `expected` if the timeout hit.
 *
 * NOTE: kept synchronous so the whole wait cycle is driven from the service worker
 */
async function waitForLabelsReady(tabId, expected) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let last = 0;

  while (Date.now() < deadline) {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (expected) => {
        const wraps = Array.from(document.querySelectorAll("#page-wrap"));
        if (wraps.length < expected)
          return { count: wraps.length, ready: false };

        // <img>
        const imgs = Array.from(document.querySelectorAll("#page-wrap img"));
        const imgsReady = imgs.every(
          (img) => img.complete && img.naturalWidth > 0
        );

        // <canvas>: a zero-sized canvas means "not drawn yet"
        const canvases = Array.from(
          document.querySelectorAll("#page-wrap canvas")
        );
        const canvasesReady = canvases.every(
          (c) => c.width > 0 && c.height > 0
        );

        // CSS background images: preload each URL once, then check .complete on later polls
        window.__bgPreload = window.__bgPreload || {};
        let bgReady = true;
        for (const el of document.querySelectorAll(
          "#page-wrap, #page-wrap *"
        )) {
          const bg = getComputedStyle(el).backgroundImage;
          if (!bg || bg === "none") continue;
          const urls = bg.match(/url\(["']?[^"')]+["']?\)/g) || [];
          for (const u of urls) {
            const src = u.replace(/^url\(["']?|["']?\)$/g, "");
            if (!window.__bgPreload[src]) {
              const im = new Image();
              im.src = src;
              window.__bgPreload[src] = im;
            }
            const im = window.__bgPreload[src];
            if (!(im.complete && im.naturalWidth > 0)) bgReady = false;
          }
        }

        // Web fonts: status is "loading" while any font is still being fetched
        const fontsReady =
          !document.fonts || document.fonts.status === "loaded";

        return {
          count: wraps.length,
          ready: imgsReady && canvasesReady && bgReady && fontsReady,
        };
      },
      args: [expected],
    });

    const result = injection?.result;
    if (!result) {
      throw new Error(
        "Readiness check returned no result (injection failed or page not scriptable)"
      );
    }

    last = result.count;
    if (result.ready) {
      await sleep(150); // small settle for paint after decode
      return last;
    }
    await sleep(200);
  }
  return last;
}

async function measureLabels(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const wraps = Array.from(document.querySelectorAll("#page-wrap"));
      return {
        dpr: window.devicePixelRatio || 1,
        labels: wraps.map((el) => {
          const r = el.getBoundingClientRect();
          return {
            x: r.left + window.scrollX,
            y: r.top + window.scrollY,
            width: r.width,
            height: r.height,
          };
        }),
      };
    },
  });
  return result;
}

async function captureLabels(target, { dpr, labels }) {
  const shots = [];
  for (const b of labels) {
    const { data } = await chrome.debugger.sendCommand(
      target,
      "Page.captureScreenshot",
      {
        format: "png",
        captureBeyondViewport: true,
        clip: {
          x: b.x,
          y: b.y,
          width: b.width,
          height: b.height,
          scale: dpr,
        },
      }
    );
    shots.push(data); // raw base64, no data: prefix
  }
  return shots;
}

/** Capture; if the debugger was detached mid-batch, re-attach once and retry. */
async function captureWithRecovery(target, info) {
  try {
    return await captureLabels(target, info);
  } catch (err) {
    if (/detached|not attached|no target/i.test(String(err))) {
      console.warn("[SW] debugger detached, re-attaching once");
      await chrome.debugger.attach(target, "1.0").catch(() => {});
      return await captureLabels(target, info);
    }
    throw err;
  }
}

// ---------- naming ----------

const sanitize = (s) =>
  String(s)
    .replace(/[\\/:*?"<>|\s]+/g, "_")
    .replace(/^_+|_+$/g, "");

function shipmentFolder(s) {
  return s.awbNumber
    ? `${sanitize(s.orderId)}_${sanitize(s.awbNumber)}`
    : sanitize(s.orderId);
}

function labelFilename(s, index, count) {
  return `${shipmentFolder(s)}_${index + 1}of${count}.png`;
}

function batchStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(
    d.getHours()
  )}${p(d.getMinutes())}`;
}

// ---------- orchestration ----------

async function runBatch(shipments) {
  batchRunning = true;
  const stamp = batchStamp();
  const results = [];
  const files = [];

  await chrome.storage.local.remove(["batchResult"]);
  await setProgress({
    state: "running",
    done: 0,
    total: shipments.length,
    current: null,
  });
  await setBadge(`0/${shipments.length}`);

  const tab = await chrome.tabs.create({
    url: "about:blank",
    active: ACTIVE_TAB,
  });
  const target = { tabId: tab.id };
  let attached = false;

  try {
    await chrome.debugger.attach(target, "1.0");
    attached = true;

    for (let i = 0; i < shipments.length; i++) {
      const s = shipments[i];
      await setProgress({ done: i, current: s.orderId });
      await setBadge(`${i + 1}/${shipments.length}`);
      console.log(`[SW] ${i + 1}/${shipments.length} — order ${s.orderId}`);

      try {
        await navigate(tab.id, s.labelUrl);
        await prepareLabelPage(tab.id);

        const found = await waitForLabelsReady(tab.id, s.total);
        if (found < s.total) {
          throw new Error(
            `Only ${found}/${s.total} labels rendered before timeout`
          );
        }

        const info = await measureLabels(tab.id);
        if (info.labels.length === 0)
          throw new Error("No #page-wrap elements found");

        const shots = await captureWithRecovery(target, info);
        const folder = shipmentFolder(s);
        const names = shots.map((data, n) => {
          const name = labelFilename(s, n, shots.length);
          files.push({ path: `${folder}/${name}`, base64: data });
          return name;
        });

        results.push({
          orderId: s.orderId,
          awb: s.awbNumber,
          expected: s.total,
          captured: shots.length,
          // More labels than expected is worth flagging; fewer already threw above.
          status: shots.length === s.total ? "ok" : "count-mismatch",
          files: names,
        });
      } catch (err) {
        console.error(`[SW] order ${s.orderId} failed:`, err);
        results.push({
          orderId: s.orderId,
          awb: s.awbNumber,
          expected: s.total,
          captured: 0,
          status: "failed",
          error: String(err),
          files: [],
        });
      }
    }
  } finally {
    if (attached) await chrome.debugger.detach(target).catch(() => {});
    await chrome.tabs.remove(tab.id).catch(() => {});
    batchRunning = false;
  }

  await chrome.storage.local.set({ batchResult: { stamp, results, files } });
  await setProgress({ state: "done", done: shipments.length, current: null });
  await setBadge("");

  await chrome.tabs.create({ url: chrome.runtime.getURL("results.html") });
}
