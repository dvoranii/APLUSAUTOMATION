(async () => {
  const { lastCapture = [] } = await chrome.storage.local.get("lastCapture");
  const root = document.getElementById("root");
  const count = document.getElementById("count");

  if (lastCapture.length === 0) {
    count.textContent = "";
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No capture in storage yet.";
    root.appendChild(empty);
    return;
  }

  count.textContent = `${lastCapture.length} label${
    lastCapture.length === 1 ? "" : "s"
  } captured`;

  for (const dataUrl of lastCapture) {
    const img = new Image();
    img.src = dataUrl;
    root.appendChild(img);
  }
})();
