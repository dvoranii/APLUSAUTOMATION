(async () => {
  const { batchResult } = await chrome.storage.local.get("batchResult");
  const summary = document.getElementById("summary");
  const zipBtn = document.getElementById("zip-btn");
  const table = document.getElementById("table");
  const previews = document.getElementById("previews");

  if (!batchResult) {
    summary.textContent = "No batch result in storage.";
    return;
  }

  const { stamp, results, files } = batchResult;
  const okCount = results.filter((r) => r.status === "ok").length;
  const problems = results.length - okCount;
  summary.textContent =
    `${results.length} shipment(s), ${files.length} label(s) captured` +
    (problems ? ` — ${problems} need attention` : "");

  // ---- Result table (textContent only; no HTML parsing of untrusted strings) ----
  function addRow(cells, header = false, statusClass = "") {
    const tr = document.createElement("tr");
    cells.forEach((text, i) => {
      const td = document.createElement(header ? "th" : "td");
      td.textContent = text;
      if (statusClass && i === cells.length - 1) td.className = statusClass;
      tr.appendChild(td);
    });
    table.appendChild(tr);
  }

  addRow(["Order", "AWB", "Labels", "Status"], true);
  for (const r of results) {
    addRow(
      [
        r.orderId,
        r.awb ?? "—",
        `${r.captured}/${r.expected}`,
        r.error ? `${r.status}: ${r.error}` : r.status,
      ],
      false,
      r.status
    );
  }

  // ---- Previews ----
  for (const f of files) {
    const img = new Image();
    img.src = "data:image/png;base64," + f.base64;
    img.title = f.path;
    previews.appendChild(img);
  }

  // ---- ZIP ----
  zipBtn.disabled = files.length === 0;
  zipBtn.addEventListener("click", async () => {
    zipBtn.disabled = true;
    zipBtn.textContent = "Building ZIP…";

    const zip = new JSZip();
    const root = zip.folder(`labels_${stamp}`);
    for (const f of files) root.file(f.path, f.base64, { base64: true });
    root.file(
      "_manifest.json",
      JSON.stringify({ created: stamp, results }, null, 2)
    );

    const blob = await zip.generateAsync({
      type: "blob",
      compression: "DEFLATE",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `labels_${stamp}.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);

    zipBtn.textContent = "Download ZIP";
    zipBtn.disabled = false;
  });
})();
