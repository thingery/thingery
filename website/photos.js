// website/photos.js — frictionless item-photo capture + management (THI-308 PR 3/PR 4).
// Loaded only on item pages whose viewer is the owner (the #photo-zone panel
// is rendered owner-only server-side). All wiring is addEventListener on
// static-file scripts — zero inline handlers, CSP stays script-src 'self'.
// "Take photo" (capture="environment") opens the camera in one tap and the
// snap auto-uploads — first photo is addable in <= 2 taps. PR 4 adds the
// mutation wiring: thumbnail delete (×) with a warning before the last photo
// goes, drag-to-reorder, first = cover. No innerHTML anywhere: DOM updates
// use createElement/textContent only.
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
  var gallery = document.getElementById("item-gallery");
  var countLabel = document.getElementById("photo-count");
  var SERVER_PREFIX = "/img/items/";

  // The items.images array is the source of truth. Seeded from the
  // server-rendered data-images attribute (same array the gallery renders
  // from); every mutation below replaces it with the server's response.
  var images = [];
  try {
    var seeded = JSON.parse(zone.dataset.images || "[]");
    if (Array.isArray(seeded)) images = seeded;
  } catch (err) { /* corrupt seed — start from the rendered strip state */ }
  var pending = 0; // uploads in flight (cap check counts them too)

  function atCap() {
    return images.length + pending >= maxImages;
  }

  function syncInputs() {
    takeInput.disabled = atCap();
    chooseInput.disabled = atCap();
    zone.classList.toggle("at-cap", atCap());
    if (countLabel) countLabel.textContent = images.length + "/" + maxImages;
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

  function note(text) {
    var row = document.createElement("div");
    row.className = "photo-row";
    row.textContent = text;
    statusBox.appendChild(row);
  }

  function renderGallery() {
    if (!gallery) return;
    var nodes = [];
    if (images.length === 0) {
      var ph = document.createElement("img");
      ph.id = "item-placeholder";
      ph.src = "/assets/placeholder-item.svg";
      ph.alt = "No photos yet";
      ph.loading = "lazy";
      ph.referrerPolicy = "no-referrer";
      nodes.push(ph);
    } else {
      for (var i = 0; i < images.length; i++) {
        var img = document.createElement("img");
        img.src = images[i];
        img.alt = "";
        img.loading = "lazy";
        img.referrerPolicy = "no-referrer"; // THI-130: seller-controlled hosts
        nodes.push(img);
      }
    }
    gallery.replaceChildren.apply(gallery, nodes);
  }

  function removePendingBanner() {
    if (banner) {
      banner.remove();
      banner = null;
    }
  }

  function showPendingBanner() {
    if (banner) return;
    banner = document.createElement("p");
    banner.className = "banner-warn";
    banner.id = "pending-banner";
    banner.textContent = "This listing is hidden from search until you add a photo.";
    if (zone.parentNode) zone.parentNode.insertBefore(banner, zone);
  }

  var dragIndex = null; // HTML5 drag-and-drop source (desktop reorder)

  function addThumb(url, index) {
    var thumb = document.createElement("span");
    thumb.className = "thumb";
    thumb.draggable = true;
    thumb.addEventListener("dragstart", function () {
      dragIndex = index;
      thumb.classList.add("dragging");
    });
    thumb.addEventListener("dragend", function () {
      dragIndex = null;
      thumb.classList.remove("dragging");
    });
    thumb.addEventListener("dragover", function (e) {
      if (e && e.preventDefault) e.preventDefault(); // allow the drop
    });
    thumb.addEventListener("drop", function (e) {
      if (e && e.preventDefault) e.preventDefault();
      if (dragIndex !== null && dragIndex !== index) reorder(dragIndex, index);
      dragIndex = null;
    });
    if (index === 0) {
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
    var del = document.createElement("button");
    del.type = "button";
    del.className = "thumb-del";
    del.title = "Delete photo";
    del.textContent = "×";
    del.addEventListener("click", function () { deleteImage(index); });
    thumb.appendChild(del);
    strip.appendChild(thumb);
  }

  // Rebuilds the whole strip from the current array: cover badge, delete
  // buttons and drag handlers all rebind to fresh indexes after each mutation.
  function renderStrip() {
    strip.replaceChildren();
    for (var j = 0; j < images.length; j++) addThumb(images[j], j);
  }

  async function errorMessage(res) {
    var body = null;
    try { body = await res.json(); } catch (err) { /* non-JSON error body */ }
    return (body && body.error) || "HTTP " + res.status;
  }

  async function deleteImage(index) {
    // Last-photo warning (THI-308): deleting the final photo returns a
    // photo_required listing to pending — hidden from search. Confirm first.
    if (images.length === 1) {
      var message =
        "Deleting the last photo hides this listing from search until you add another photo. Delete it anyway?";
      if (typeof window.confirm === "function" && !window.confirm(message)) return;
    }
    var member = images[index];
    // Stored files are addressed by filename; external-URL members are sent
    // whole (the server matches them exactly against images[]).
    var ref = member.indexOf(SERVER_PREFIX) === 0 ? member.slice(SERVER_PREFIX.length) : member;
    try {
      var res = await fetch("/api/items/" + encodeURIComponent(itemId) + "/images/" + encodeURIComponent(ref), {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(await errorMessage(res));
      var body = await res.json();
      if (Array.isArray(body.images)) images = body.images;
      renderStrip();
      renderGallery();
      syncInputs();
      if (body.visible === false) showPendingBanner();
    } catch (err) {
      note("Could not delete the photo — " + err.message);
    }
  }

  async function reorder(from, to) {
    var next = images.slice();
    var moved = next.splice(from, 1)[0];
    next.splice(to, 0, moved);
    images = next; // optimistic — reverted to the server's array below
    renderStrip();
    try {
      var res = await fetch("/api/items/" + encodeURIComponent(itemId) + "/images/order", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ images: next }),
      });
      var body = null;
      try { body = await res.json(); } catch (err) { /* non-JSON error body */ }
      if (!res.ok) {
        // 409 carries the current set — show it and drop the optimistic order.
        if (body && Array.isArray(body.images)) {
          images = body.images;
          note("Photos changed since the page loaded — showing the current order.");
        } else {
          throw new Error((body && body.error) || "HTTP " + res.status);
        }
      } else if (body && Array.isArray(body.images)) {
        images = body.images;
      }
    } catch (err) {
      note("Could not save the new order — " + err.message);
    }
    renderStrip();
  }

  function showInGallery(url) {
    renderGallery(); // full re-render from the array state
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
    pending -= 1; // give the slot back so a retry can retake it
    ui.state.textContent = "failed — " + err.message;
    var retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = "Retry";
    retry.addEventListener("click", function () {
      retry.remove();
      run(file, ui);
    });
    ui.row.appendChild(retry);
    syncInputs();
  }

  async function run(file, ui) {
    pending += 1;
    syncInputs();
    try {
      var url = await uploadFile(file, ui);
      pending -= 1;
      images.push(url);
      ui.state.textContent = "done";
      ui.row.remove();
      renderStrip();
      showInGallery(url);
      removePendingBanner(); // first photo published the listing
      syncInputs();
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
      run(file, newRow(file.name)); // pending counts toward the cap optimistically
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

  // PR 4: rebuild the server-rendered strip with interactive controls
  // (delete ×, drag handles, cover badge) wired to the current array.
  renderStrip();
  syncInputs();
})();
