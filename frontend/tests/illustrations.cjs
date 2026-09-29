// Flat illustrations of drinks and pastries for the visual fixture and demo screenshots.
// They are drawings, not photos, and are labelled as such in the docs: never presented as real
// photos of a venue's dishes. 800×800 (cover: 1600×900).

const BG = {
  latte: ["#F6E7D4", "#EBC9A0"], cappuccino: ["#F3E2CE", "#DDB98F"], americano: ["#E6DDD3", "#BFA98F"],
  espresso: ["#EADFD2", "#C9AE8B"], flat: ["#F7E9D9", "#E6C7A0"], tea: ["#E4EBD9", "#BFD1A5"],
  cocoa: ["#F1DFD6", "#D9A98E"], croissant: ["#F8E8C8", "#EFC77E"], cinnabon: ["#F5E2D6", "#E0B59A"],
  syrniki: ["#F8ECD3", "#EBCB8C"], omelette: ["#FBF1CF", "#F1D67A"], eclair: ["#F3E4E4", "#DDB6B6"],
  cover: ["#2C4A3E", "#16241F"],
};

const wrap = (bg, body, w = 800, h = 800) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">` +
  `<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${bg[0]}"/><stop offset="1" stop-color="${bg[1]}"/></linearGradient>` +
  `<radialGradient id="shine" cx=".3" cy=".25" r=".8"><stop offset="0" stop-color="#fff" stop-opacity=".55"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient></defs>` +
  `<rect width="${w}" height="${h}" fill="url(#bg)"/><rect width="${w}" height="${h}" fill="url(#shine)"/>${body}</svg>`;

const shadow = (cx, cy, rx, ry) => `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="#3B2314" opacity=".16"/>`;
const steam = (x) => `<path d="M${x} 250 c-26 -34 26 -62 0 -98 M${x + 46} 262 c-24 -30 24 -56 0 -90" fill="none" stroke="#fff" stroke-opacity=".75" stroke-width="12" stroke-linecap="round"/>`;

function cup({ liquid, foam, art, size = 1, saucer = "#FFFFFF", cupColor = "#FFFFFF" }) {
  const w = 300 * size, h = 210 * size, x = 400 - w / 2, y = 470 - h / 2;
  return shadow(400, 640, 250 * size, 34) +
    `<ellipse cx="400" cy="606" rx="${230 * size}" ry="${46 * size}" fill="${saucer}"/><ellipse cx="400" cy="600" rx="${205 * size}" ry="${34 * size}" fill="#F0E6DC"/>` +
    `<path d="M${x + w - 6} ${y + 40} c${86 * size} -10 ${96 * size} ${110 * size} ${-4 * size} ${118 * size}" fill="none" stroke="${cupColor}" stroke-width="${30 * size}" stroke-linecap="round"/>` +
    `<path d="M${x} ${y} h${w} v${h * 0.35} c0 ${h * 0.7} ${-w * 0.16} ${h * 0.7} ${-w * 0.5} ${h * 0.7} s${-w * 0.5} 0 ${-w * 0.5} ${-h * 0.7} z" fill="${cupColor}"/>` +
    `<ellipse cx="400" cy="${y + 4}" rx="${w / 2}" ry="${32 * size}" fill="#EDE3D8"/>` +
    `<ellipse cx="400" cy="${y + 8}" rx="${w / 2 - 16}" ry="${24 * size}" fill="${liquid}"/>` +
    (foam ? `<ellipse cx="400" cy="${y + 8}" rx="${w / 2 - 34}" ry="${17 * size}" fill="${foam}"/>` : "") +
    (art === "heart" ? `<path d="M400 ${y + 22} c-30 -22 -40 -30 -22 -40 c12 -6 22 2 22 8 c0 -6 10 -14 22 -8 c18 10 8 18 -22 40z" fill="${liquid}" opacity=".9"/>` : "") +
    (art === "rings" ? `<ellipse cx="400" cy="${y + 8}" rx="${w / 4}" ry="${9 * size}" fill="${liquid}" opacity=".55"/>` : "") +
    `<path d="M${x + 24} ${y + 44} q-4 ${h * 0.6} ${w * 0.16} ${h * 0.74}" fill="none" stroke="#fff" stroke-opacity=".8" stroke-width="12" stroke-linecap="round"/>` + steam(340);
}

const DRAW = {
  latte: () => cup({ liquid: "#B98352", foam: "#F1DFC6", art: "heart" }),
  cappuccino: () => cup({ liquid: "#9A6237", foam: "#F6EBDA", art: "rings", size: 1.05 }),
  americano: () => cup({ liquid: "#3B2314", foam: "#5A3A22", size: 1.05, cupColor: "#F7F2EC" }),
  espresso: () => cup({ liquid: "#2E1A0F", foam: "#8A5A34", size: 0.7 }),
  flat: () => cup({ liquid: "#A9744A", foam: "#EAD5B9", art: "heart", size: 0.9 }),
  cocoa: () => cup({ liquid: "#6E3B26", foam: "#8A5238", cupColor: "#E9825E", size: 1.05 }) +
    `<circle cx="352" cy="468" r="24" fill="#fff"/><circle cx="410" cy="458" r="22" fill="#FFF3E6"/><circle cx="446" cy="474" r="20" fill="#fff"/>`,
  tea: () => shadow(400, 640, 260, 32) +
    `<path d="M250 420 h300 v90 c0 90 -70 130 -150 130 s-150 -40 -150 -130z" fill="#F3F0E6"/><path d="M550 450 c90 -6 90 100 0 96" fill="none" stroke="#F3F0E6" stroke-width="26" stroke-linecap="round"/>` +
    `<path d="M300 420 c-10 -70 40 -120 100 -120 s110 50 100 120z" fill="#7BA05B"/><circle cx="400" cy="286" r="24" fill="#5E8143"/>` +
    `<path d="M230 430 l-70 -60 c-20 -16 -4 -36 16 -22 l70 44" fill="#7BA05B"/><path d="M290 560 q110 30 220 0" fill="none" stroke="#fff" stroke-opacity=".7" stroke-width="12" stroke-linecap="round"/>`,
  croissant: () => shadow(400, 600, 290, 40) +
    ["#D9962E:120:520:70", "#E3A93F:190:470:82", "#EAB852:270:440:92", "#EFC066:400:430:100", "#EAB852:530:440:92", "#E3A93F:610:470:82", "#D9962E:680:520:70"]
      .map((s) => { const [c, x, y, r] = s.split(":"); return `<ellipse cx="${x}" cy="${y}" rx="${r}" ry="${r * 0.72}" fill="${c}" transform="rotate(${(x - 400) / 14} ${x} ${y})"/>`; }).join("") +
    `<path d="M210 440 q190 -70 380 0" fill="none" stroke="#fff" stroke-opacity=".5" stroke-width="12" stroke-linecap="round"/>`,
  cinnabon: () => shadow(400, 610, 250, 36) + `<circle cx="400" cy="450" r="210" fill="#D9A26B"/><circle cx="400" cy="450" r="176" fill="#E9B980"/>` +
    `<path d="M400 450 m0 -130 a130 130 0 1 1 -90 40 a90 90 0 1 1 100 -20 a50 50 0 1 1 -40 60" fill="none" stroke="#9C5B2B" stroke-width="22" stroke-linecap="round"/>` +
    `<path d="M240 400 q160 -90 320 0 q20 50 -30 70 q-40 30 -80 0 q-40 40 -90 8 q-70 10 -120 -20z" fill="#fff" opacity=".92"/>`,
  syrniki: () => shadow(400, 620, 270, 36) + `<ellipse cx="400" cy="560" rx="280" ry="60" fill="#fff"/>` +
    [0, 1, 2].map((i) => `<ellipse cx="${400 + (i - 1) * 24}" cy="${520 - i * 62}" rx="150" ry="42" fill="${i === 2 ? "#E8B865" : "#D9A24E"}"/><ellipse cx="${400 + (i - 1) * 24}" cy="${508 - i * 62}" rx="150" ry="36" fill="#EBC272"/>`).join("") +
    `<path d="M300 356 q100 -30 200 0 q10 40 -20 60 q-20 -30 -50 0 q-30 -30 -60 6 q-40 -10 -70 -66z" fill="#B0263E"/><circle cx="380" cy="330" r="22" fill="#C22F49"/><circle cx="430" cy="322" r="20" fill="#B0263E"/>`,
  omelette: () => shadow(400, 620, 280, 36) + `<ellipse cx="400" cy="520" rx="290" ry="90" fill="#fff"/><ellipse cx="400" cy="512" rx="240" ry="66" fill="#F6F0E4"/>` +
    `<path d="M230 500 c20 -110 320 -110 340 0 c-40 40 -300 40 -340 0z" fill="#F3C94B"/><path d="M290 480 q110 -50 220 0" fill="none" stroke="#fff" stroke-opacity=".55" stroke-width="12" stroke-linecap="round"/><circle cx="340" cy="510" r="10" fill="#6FA35A"/><circle cx="470" cy="500" r="9" fill="#6FA35A"/>`,
  eclair: () => shadow(400, 600, 290, 36) + `<rect x="150" y="410" width="500" height="150" rx="75" fill="#E4B07A"/><rect x="150" y="380" width="500" height="120" rx="60" fill="#5B3324"/><path d="M190 430 q210 40 420 0" fill="none" stroke="#fff" stroke-opacity=".35" stroke-width="10" stroke-linecap="round"/>`,
  cover: () => {
    let beans = "";
    for (let i = 0; i < 28; i++) {
      const x = (i * 197) % 1600, y = (i * 131) % 900, r = 24 + (i % 4) * 8;
      beans += `<g transform="translate(${x} ${y}) rotate(${(i * 37) % 180})" opacity=".18"><ellipse rx="${r}" ry="${r * 0.68}" fill="#fff"/><path d="M${-r} 0 q${r} ${-r * 0.5} ${r * 2} 0" fill="none" stroke="#16241F" stroke-width="5"/></g>`;
    }
    return beans + `<circle cx="1260" cy="330" r="240" fill="#E0B25C" opacity=".16"/><circle cx="1260" cy="330" r="150" fill="#E0B25C" opacity=".14"/>`;
  },
};

function kind(name) {
  const n = String(name).toLowerCase();
  if (n.includes("обложк")) return "cover";
  if (n.includes("капуч")) return "cappuccino";
  if (n.includes("латте") && !n.includes("флэт")) return "latte";
  if (n.includes("флэт") || n.includes("флет")) return "flat";
  if (n.includes("американо")) return "americano";
  if (n.includes("эспрессо")) return "espresso";
  if (n.includes("какао")) return "cocoa";
  if (n.includes("чай")) return "tea";
  if (n.includes("круассан")) return "croissant";
  if (n.includes("синнабон")) return "cinnabon";
  if (n.includes("сырник")) return "syrniki";
  if (n.includes("омлет")) return "omelette";
  if (n.includes("эклер")) return "eclair";
  return "latte";
}

function illustration(name) {
  const k = kind(name);
  return k === "cover" ? wrap(BG.cover, DRAW.cover(), 1600, 900) : wrap(BG[k], DRAW[k]());
}

module.exports = { illustration, kind };
