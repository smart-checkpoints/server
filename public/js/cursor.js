const cursorHoverSelectors = [
  "button",
  "a",
  "input",
  "select",
  ".is-hovered-on",
  ".project-card",
  ".new-project-card",
  ".modal-close",
  ".header-link",
  ".logo",
  ".copy-btn",
  ".endpoint-card",
];
let cursor = document.querySelector(".custom-cursor");

if (!cursor) {
  cursor = document.createElement("div");
  cursor.classList.add("custom-cursor");
  document.body.appendChild(cursor);
}

document.addEventListener("mousemove", (e) => {
  cursor.style.left = `${e.clientX}px`;
  cursor.style.top = `${e.clientY}px`;

  const target = e.target;
  if (target.disabled || target.closest("[disabled]")) {
    cursor.classList.remove("is-hovering");
  } else if (target.closest(cursorHoverSelectors.join(", "))) {
    cursor.classList.add("is-hovering");
  } else {
    cursor.classList.remove("is-hovering");
  }
});
