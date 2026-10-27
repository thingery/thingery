// website/photos.js — frictionless item-photo capture (THI-308 PR 3).
// Loaded only on item pages whose viewer is the owner (the #photo-zone panel
// is rendered owner-only server-side). All wiring is addEventListener on
// static-file scripts — zero inline handlers, CSP stays script-src 'self'.
// "Take photo" (capture="environment") opens the camera in one tap and the
// snap auto-uploads — first photo is addable in <= 2 taps. No innerHTML
// anywhere: DOM updates use createElement/textContent only.
(function () {
  "use strict";

  var zone = document.getElementById("photo-zone");
  if (!zone) return; // not the owner / panel absent — nothing to wire

  var imaging = window.ThingeryImaging; // /imaging.js loads before this file
  var itemId = zone.dataset.itemId;
  var maxImages = Number(zone.dataset.maxImages || 12);
  var takeInput = document.getElementById("photo-take");
  var chooseInput = document.getElementById("photo-choose");
  var statusBox = document.getElementById("photo-status");
  var strip = document.getElementById("photo-strip");
  var banner = document.getElementById("pending-banner");
  var placeholder = document.getElementById("item-placeholder");
  var gallery = document.getElementById("item-gallery");
  var countLabel = document.getElementById("photo-count");
  var imageCount = Number(zone.dataset.imageCount || 0);

  function atCap() {
    return imageCount >= maxImages;
  }

  function syncInputs() {
    takeInput.disabled = atCap();
    chooseInput.disabled = atCap();
    zone.classList.toggle("at-cap", atCap());
    if (countLabel) countLabel.textContent = imageCount + "/" + maxImages;
  }

  function newRow(fileName) {
    var row = document.createElement("div");
    row.className = "photo-row";
    var name = document.createElement("span");
    name.className = "photo-name";
    name.textContent = fileName;
    var state = document.createElement("span");
    state.className = "photo-state";
    state.textContent = "compressing…";
    row.appendChild(name);
    row.appendChild(state);
    statusBox.appendChild(row);
    return { row: row, state: state };
  }

  function addThumb(url) {
    var thumb = document.createElement("span");
    thumb.className = "thumb";
    if (strip.children.length === 0) {
      var badge = document.createElement("span");
      badge.className = "cover-badge";
      badge.textContent = "cover"; // first photo = cover
      thumb.appendChild(badge);
    }
    var img = document.createElement("img");
    img.src = url;
    img.alt = "";
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer"; // THI-130: seller-controlled hosts
    thumb.appendChild(img);
    strip.appendChild(thumb);
  }

  function showInGallery(url) {
    if (placeholder) placeholder.remove(); // pending -> live, in place
    var img = document.createElement("img");
    img.src = url;
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    gallery.appendChild(img);
  }

  async function uploadFile(file, ui) {
    var payload = file;
    if (imaging) payload = await imaging.compressImage(file);
    ui.state.textContent = "uploading…";
    var res = await fetch("/api/items/" + encodeURIComponent(itemId) + "/images", {
      method: "POST",
      headers: { "content-type": file.type },
      body: payload,
    });
    if (!res.ok) {
      var detail = await res.json().catch(function () { return null; });
      throw new Error((detail && detail.error) || "HTTP " + res.status);
    }
    var body = await res.json();
    return body.url;
  }

  function markFailed(ui, file, err) {
    imageCount -= 1; // give the slot back so a retry can retake it
    ui.state.textContent = "failed — " + err.message;
    var retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = "Retry";
    retry.addEventListener("click", function () {
      retry.remove();
      imageCount += 1;
      syncInputs();
      run(file, ui);
    });
    ui.row.appendChild(retry);
    syncInputs();
  }

  async function run(file, ui) {
    try {
      var url = await uploadFile(file, ui);
      ui.state.textContent = "done";
      ui.row.remove();
      addThumb(url);
      showInGallery(url);
      if (banner) banner.remove(); // first photo published the listing
    } catch (err) {
      markFailed(ui, file, err);
    }
  }

  function handleFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    for (var i = 0; i < files.length; i++) {
      var file = files[i];
      if (!file.type || file.type.indexOf("image/") !== 0) continue;
      if (atCap()) break;
      imageCount += 1; // optimistic; decremented again on failure
      syncInputs();
      run(file, newRow(file.name));
    }
  }

  function onPick(input) {
    input.addEventListener("change", function () {
      handleFiles(input.files);
      input.value = ""; // same snap is re-pickable after a failed upload
    });
  }
  onPick(takeInput);
  onPick(chooseInput);

  zone.addEventListener("dragover", function (e) {
    e.preventDefault();
    zone.classList.add("drag");
  });
  zone.addEventListener("dragleave", function () {
    zone.classList.remove("drag");
  });
  zone.addEventListener("drop", function (e) {
    e.preventDefault();
    zone.classList.remove("drag");
    handleFiles(e.dataTransfer.files);
  });

  document.addEventListener("paste", function (e) {
    var available = (e.clipboardData && e.clipboardData.files) || [];
    var files = Array.prototype.filter.call(available, function (f) {
      return f.type && f.type.indexOf("image/") === 0;
    });
    if (files.length) handleFiles(files);
  });

  syncInputs();
})();
