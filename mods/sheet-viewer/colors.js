// Excel colors: ARGB, theme slots with tint, the indexed palette, as "#rrggbb".

// Excel's default 64-color indexed palette (index 64 = system foreground, 65 = background).
export const INDEXED = [
  "#000000", "#ffffff", "#ff0000", "#00ff00", "#0000ff", "#ffff00", "#ff00ff", "#00ffff",
  "#000000", "#ffffff", "#ff0000", "#00ff00", "#0000ff", "#ffff00", "#ff00ff", "#00ffff",
  "#800000", "#008000", "#000080", "#808000", "#800080", "#008080", "#c0c0c0", "#808080",
  "#9999ff", "#993366", "#ffffcc", "#ccffff", "#660066", "#ff8080", "#0066cc", "#ccccff",
  "#000080", "#ff00ff", "#ffff00", "#00ffff", "#800080", "#800000", "#008080", "#0000ff",
  "#00ccff", "#ccffff", "#ccffcc", "#ffff99", "#99ccff", "#ff99cc", "#cc99ff", "#ffcc99",
  "#3366ff", "#33cccc", "#99cc00", "#ffcc00", "#ff9900", "#ff6600", "#666699", "#969696",
  "#003366", "#339966", "#003300", "#333300", "#993300", "#993366", "#333399", "#333333",
  "#000000", "#ffffff",
];

// Office 2013+ default theme, used when a file carries none.
export const DEFAULT_THEME = {
  dk1: "#000000", lt1: "#ffffff", dk2: "#44546a", lt2: "#e7e6e6",
  accent1: "#4472c4", accent2: "#ed7d31", accent3: "#a5a5a5", accent4: "#ffc000",
  accent5: "#5b9bd5", accent6: "#70ad47", hlink: "#0563c1", folHlink: "#954f72",
  majorFont: "Calibri Light", minorFont: "Calibri",
};

// SpreadsheetML theme indices swap the first two pairs: 0 = lt1, 1 = dk1, 2 = lt2, 3 = dk2.
const THEME_SLOTS = ["lt1", "dk1", "lt2", "dk2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "hlink", "folHlink"];

const hex2 = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");

export function rgbToHex(r, g, b) {
  return "#" + hex2(r) + hex2(g) + hex2(b);
}

export function hexToRgb(hex) {
  const h = String(hex || "").replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function rgbToHls([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, l, 0];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, l, s];
}

function hlsToRgb([h, l, s]) {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}

/** Excel's tint: darken toward black (tint < 0) or lighten toward white (tint > 0), on HLS lightness. */
export function applyTint(hex, tint) {
  if (!tint) return hex;
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const [h, l, s] = rgbToHls(rgb);
  const nl = tint < 0 ? l * (1 + tint) : l * (1 - tint) + tint;
  const [r, g, b] = hlsToRgb([h, Math.max(0, Math.min(1, nl)), s]);
  return rgbToHex(r, g, b);
}

/** Mixes `a` toward `b` by k (0..1). */
export function mix(a, b, k) {
  const x = hexToRgb(a), y = hexToRgb(b);
  if (!x || !y) return a;
  return rgbToHex(x[0] + (y[0] - x[0]) * k, x[1] + (y[1] - x[1]) * k, x[2] + (y[2] - x[2]) * k);
}

/** A color element's attributes ({rgb, theme, tint, indexed, auto}) as "#rrggbb", or null. */
export function resolveColor(attrs, theme = DEFAULT_THEME, indexed = INDEXED) {
  if (!attrs) return null;
  let hex = null;
  if (attrs.rgb) {
    const v = attrs.rgb.length === 8 ? attrs.rgb.slice(2) : attrs.rgb;
    hex = /^[0-9a-fA-F]{6}$/.test(v) ? "#" + v.toLowerCase() : null;
  } else if (attrs.theme !== undefined) {
    hex = theme[THEME_SLOTS[Number(attrs.theme)]] ?? null;
  } else if (attrs.indexed !== undefined) {
    hex = indexed[Number(attrs.indexed)] ?? null;
  } else if (attrs.auto === "1" || attrs.auto === "true") {
    hex = null;
  }
  return hex && attrs.tint ? applyTint(hex, Number(attrs.tint)) : hex;
}
