// Public feedback form script. Loaded as an external file so the site can run
// under a strict CSP (no 'unsafe-inline' for scripts).

const form = document.getElementById("feedback-form");
const bodyInput = document.getElementById("body");
const statusEl = document.getElementById("status");
const submitButton = document.getElementById("submit-button");

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const body = bodyInput.value.trim();
  statusEl.textContent = "";
  statusEl.className = "status";

  if (body.length < 10) {
    statusEl.textContent = "Feedback must be at least 10 characters.";
    statusEl.classList.add("error");
    return;
  }

  submitButton.disabled = true;

  try {
    const response = await fetch("/api/feedback", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ body })
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || "Unable to submit feedback.");
    }

    form.reset();
    statusEl.textContent = "Feedback received.";
    statusEl.classList.add("success");
  } catch (error) {
    statusEl.textContent = error.message || "Something went wrong.";
    statusEl.classList.add("error");
  } finally {
    submitButton.disabled = false;
  }
});
