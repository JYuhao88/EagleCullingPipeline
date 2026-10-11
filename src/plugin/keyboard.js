export function keyboardAction(event, inInput = false, reasonsOpen = false) {
  if (inInput || event.metaKey || event.ctrlKey || event.altKey) {
    if (!inInput && event.key.toLowerCase() === "z" && (event.metaKey || event.ctrlKey)) return { type: "undo" };
    return null;
  }
  if (reasonsOpen && /^[1-9]$/.test(event.key)) return { type: "rejectReason", index: Number(event.key) - 1 };
  if (reasonsOpen && ["Enter", "Escape"].includes(event.key)) return { type: "closeReasons" };
  if (event.key.toLowerCase() === "f" && !event.metaKey && !event.ctrlKey && !event.altKey) return { type: "faceCompare" };
  if (event.key.toLowerCase() === "l") return { type: event.shiftKey ? "nativeNextFace" : "nativeMagnifier" };
  if (event.key.toLowerCase() === "e") return { type: "nativeRegion" };
  if (event.key.toLowerCase() === "m") return { type: "moveUnit", delta: event.shiftKey ? 1 : -1 };
  if (event.key.toLowerCase() === "g") return { type: "newGroup" };
  if (event.key === "1") return { type: "decision", action: "selected" };
  if (event.key === "2") return { type: "decision", action: "candidate" };
  if (event.key === "3") return { type: "decision", action: "rejected" };
  if (event.key === "ArrowLeft") return { type: "unit", delta: -1 };
  if (event.key === "ArrowRight") return { type: "unit", delta: 1 };
  if (event.key === "Enter") return { type: "group", delta: event.shiftKey ? -1 : 1 };
  if (event.key.toLowerCase() === "s") return { type: "selectBest" };
  if ((event.key.toLowerCase() === "z" && (event.metaKey || event.ctrlKey)) || event.key.toLowerCase() === "u") {
    return { type: "undo" };
  }
  if (event.key.toLowerCase() === "z") return { type: "syncZoom" };
  if (event.key === " ") return { type: "zoom" };
  if (event.key.toLowerCase() === "a") return { type: "selectAll" };
  if (event.key === "Escape") return { type: "clearSelection" };
  if (event.key === "?" || (event.key === "/" && event.shiftKey)) return { type: "help" };
  return null;
}
