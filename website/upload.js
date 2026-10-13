// Item-page photo upload. Only loaded on item pages when the viewer is the
// item's owner (the upload form is rendered owner-only). Binds via
// data-item-id on the form — no inline script, CSP stays 'self'-only.
const form = document.getElementById("upload-form");
if (form) {
  form.onsubmit = async (e) => {
    e.preventDefault();
    const file = document.getElementById("file").files[0];
    const status = document.getElementById("upload-status");
    if (!file) return;
    status.textContent = "Uploading…";
    const res = await fetch(`/api/items/${encodeURIComponent(form.dataset.itemId)}/images`, {
      method: "POST",
      headers: { "content-type": file.type },
      body: file,
    });
    if (res.ok) location.reload();
    else status.textContent = "Failed: " + ((await res.json()).error || res.status);
  };
}
