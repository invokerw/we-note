const root = document.querySelector(".sync-entry");
const cover = root?.querySelector(".cover-panel");
const buttons = [...document.querySelectorAll("[data-auth-style]")];
const styles = ["paper", "night"];
const stored = localStorage.getItem("wenote-auth-style");

function choose(style) {
  if (!root || !cover || !styles.includes(style)) return;
  for (const name of styles) {
    root.classList.toggle(`auth-style-${name}`, name === style);
    cover.classList.toggle(`auth-style-${name}`, name === style);
  }
  const copy = {
    paper: ["CLEAR · KEEP", "从一页笔记\n开始", "记录、整理、回看，让每个想法都有位置。"],
    night: ["CALM · FOCUS", "把复杂的事，\n写清楚", "在安静的空间里，专注于正在发生的思考。"],
  }[style];
  const kicker = cover.querySelector(".cover-kicker");
  const title = cover.querySelector(".cover-copy h2");
  const description = cover.querySelector(".cover-copy > p:last-child");
  if (kicker) kicker.textContent = copy[0];
  if (title) title.textContent = copy[1];
  if (description) description.textContent = copy[2];
  for (const button of buttons) {
    button.setAttribute("aria-pressed", String(button.dataset.authStyle === style));
  }
  localStorage.setItem("wenote-auth-style", style);
}

for (const button of buttons) {
  button.addEventListener("click", () => choose(button.dataset.authStyle));
}
choose(styles.includes(stored) ? stored : "paper");
