const statusEl = document.getElementById("status");
const btn = document.getElementById("capture-btn");

function setStatus(text) {
  statusEl.textContent = text;
}

// Runs inside the portal tab. Must be self-contained (no outer references).
function scrapeSelectedShipments() {
  const rows = document.querySelectorAll("#projects-tbl tr.card-hovera");
  const shipments = [];

  rows.forEach((row) => {
    const checkbox = row.querySelector("input.bulk-check");
    if (!checkbox || !checkbox.checked) return;

    const orderId = checkbox.value;
    const awbLink = row.querySelector('a[href*="courier_view.php"]');
    const awbNumber = awbLink ? awbLink.textContent.trim() : null;
    const labelButton = row.querySelector(".mt-1 a");
    if (!labelButton) return;

    const hrefAttr = labelButton.getAttribute("href");
    const isMultiPiece = !hrefAttr || hrefAttr === "#";
    const searchText = isMultiPiece
      ? labelButton.getAttribute("onclick") || ""
      : labelButton.href;

    const match = searchText.match(
      /print_label_ship\.php\?id=(\d+)&(?:amp;)?piece=(\d+)&(?:amp;)?total=(\d+)/
    );
    if (!match) return;

    const id = match[1];
    const total = Number(match[3]);
    shipments.push({
      orderId,
      awbNumber,
      total,
      labelUrl: `https://huuneh.com/dashboard/print_label_ship.php?id=${id}&piece=1&total=${total}`,
    });
  });

  return shipments;
}

btn.addEventListener("click", async () => {
  btn.disabled = true;
  setStatus("Scraping selection…");

  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    const [{ result: shipments }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: scrapeSelectedShipments,
    });

    if (!shipments || shipments.length === 0) {
      setStatus("No valid shipments selected.");
      btn.disabled = false;
      return;
    }

    // Fire-and-forget: the worker owns the batch from here on.
    chrome.runtime.sendMessage({ type: "startBatch", shipments });
    window.close();
  } catch (err) {
    console.error(err);
    setStatus("Error: " + err.message);
    btn.disabled = false;
  }
});
