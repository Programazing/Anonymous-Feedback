// Admin UI script.
//
// Feedback text coming from the database is untrusted and is always rendered
// through `textContent` (never `innerHTML`). Combined with the strict CSP
// served by src/server.js (no 'unsafe-inline' for scripts), this prevents
// stored XSS payloads submitted through the public form from executing here.

const unreviewedStatus = document.getElementById("unreviewed-status");
const unreviewedList = document.getElementById("unreviewed-list");
const reviewedList = document.getElementById("reviewed-list");

// The admin token is never read from the URL. It is kept only in memory
// for the lifetime of this page (sessionStorage), so it does not appear
// in browser history, server access logs, or Referer headers.
let adminToken = sessionStorage.getItem("adminToken") || "";
if (!adminToken) {
  adminToken = window.prompt("Enter admin token:") || "";
  if (adminToken) {
    sessionStorage.setItem("adminToken", adminToken);
  }
}

function adminFetch(url, options = {}) {
  const headers = Object.assign({}, options.headers || {}, {
    "x-admin-token": adminToken
  });
  return fetch(url, Object.assign({}, options, { headers }));
}

function renderItems(container, items, reviewedSection) {
  container.textContent = "";

  if (!items.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No feedback in this section.";
    container.appendChild(empty);
    return;
  }

  for (const item of items) {
    const wrapper = document.createElement("article");
    wrapper.className = "item";

    const text = document.createElement("div");
    // IMPORTANT: use textContent, never innerHTML, for user-submitted feedback.
    text.textContent = item.body;
    wrapper.appendChild(text);

    if (!reviewedSection) {
      const button = document.createElement("button");
      button.textContent = "Mark reviewed";
      button.addEventListener("click", async () => {
        button.disabled = true;

        const response = await adminFetch(`/api/admin/feedback/${item.id}/review`, {
          method: "POST"
        });

        const result = await response.json();

        if (!response.ok) {
          button.disabled = false;
          alert(result.error || "Could not mark reviewed.");
          return;
        }

        await loadAll();
      });

      wrapper.appendChild(button);
    }

    container.appendChild(wrapper);
  }
}

async function loadUnreviewed() {
  unreviewedStatus.textContent = "";
  unreviewedList.textContent = "";

  const response = await adminFetch("/api/admin/feedback/unreviewed");
  const result = await response.json();

  if (response.status === 403) {
    const locked = document.createElement("p");
    locked.className = "locked";
    locked.textContent = result.error || "Locked until Sunday.";
    unreviewedStatus.appendChild(locked);
    return;
  }

  if (!response.ok) {
    const error = document.createElement("p");
    error.className = "locked";
    error.textContent = result.error || "Could not load unread feedback.";
    unreviewedStatus.appendChild(error);
    return;
  }

  renderItems(unreviewedList, result.items, false);
}

async function loadReviewed() {
  reviewedList.textContent = "";

  const response = await adminFetch("/api/admin/feedback/reviewed");
  const result = await response.json();

  if (!response.ok) {
    const error = document.createElement("p");
    error.className = "locked";
    error.textContent = result.error || "Could not load reviewed feedback.";
    reviewedList.appendChild(error);
    return;
  }

  renderItems(reviewedList, result.items, true);
}

async function loadAll() {
  await loadUnreviewed();
  await loadReviewed();
}

loadAll();
