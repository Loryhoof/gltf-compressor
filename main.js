// Vite entry. Requires: npm i three upng-js
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import * as UPNG from "upng-js";

// ---- DOM ----
const fileInput = document.getElementById("file");
const runBtn = document.getElementById("run");
const dl = document.getElementById("download");
const logBox = document.getElementById("log");

const resizeFactorSel = document.getElementById("resizeFactor");
const pngColorsRange = document.getElementById("pngColors");
const pngColorsVal = document.getElementById("pngColorsVal");
const jpegQRange = document.getElementById("jpegQ");
const jpegQVal = document.getElementById("jpegQVal");

pngColorsRange.addEventListener(
  "input",
  () => (pngColorsVal.textContent = pngColorsRange.value)
);
jpegQRange.addEventListener(
  "input",
  () => (jpegQVal.textContent = Number(jpegQRange.value).toFixed(2))
);

const log = (...a) => {
  console.log(...a);
  logBox.textContent +=
    "\n" +
    a
      .map((x) => (typeof x === "string" ? x : JSON.stringify(x, null, 2)))
      .join(" ");
};

// ---- Loader setup (no renderer needed) ----
const loader = new GLTFLoader();
const draco = new DRACOLoader();
draco.setDecoderPath(
  "https://unpkg.com/three@0.158.0/examples/jsm/libs/draco/"
);
loader.setDRACOLoader(draco);

let arrayBuffer = null;

fileInput.addEventListener("change", async (e) => {
  dl.classList.add("hidden");
  dl.removeAttribute("href");
  dl.removeAttribute("download");
  logBox.textContent = "Loading file…";

  const file = e.target.files?.[0];
  if (!file) {
    runBtn.disabled = true;
    return;
  }
  try {
    arrayBuffer = await file.arrayBuffer();
    logBox.textContent = `Loaded: ${file.name} (${Math.round(
      file.size / 1024
    )} KB)`;
    runBtn.disabled = false;
  } catch (err) {
    logBox.textContent = `Failed to read file: ${err}`;
    arrayBuffer = null;
    runBtn.disabled = true;
  }
});

runBtn.addEventListener("click", async () => {
  if (!arrayBuffer) return;
  runBtn.disabled = true;
  try {
    const out = await processGLB(arrayBuffer, {
      resizeFactor: Number(resizeFactorSel.value), // 1, 0.5, 0.25, 0.125
      pngColors: parseInt(pngColorsRange.value, 10),
      jpegQuality: Number(jpegQRange.value),
    });

    const blob = new Blob([out], { type: "model/gltf-binary" });
    const url = URL.createObjectURL(blob);

    const inName = fileInput.files?.[0]?.name || "model.glb";
    const base = inName.replace(/\.glb$/i, "");
    const outName = `${base}.reencoded.glb`;

    dl.href = url;
    dl.download = outName;
    dl.textContent = `Download ${outName}`;
    dl.classList.remove("hidden");

    log("Done. Ready to download.");
  } catch (err) {
    log("Error:", err);
  } finally {
    runBtn.disabled = false;
  }
});

// ---- Core ----
function loadGLBFromArrayBuffer(buffer) {
  return new Promise((resolve, reject) => {
    loader.parse(
      buffer,
      "",
      (gltf) => resolve(gltf),
      (err) => reject(err)
    );
  });
}

function collectTextures(root) {
  const textureProps = [
    "map",
    "alphaMap",
    "aoMap",
    "bumpMap",
    "displacementMap",
    "emissiveMap",
    "envMap",
    "lightMap",
    "metalnessMap",
    "normalMap",
    "roughnessMap",
    "specularMap",
    "gradientMap",
  ];
  const set = new Set();
  root.traverse((o) => {
    if (o.isMesh && o.material) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        for (const p of textureProps) {
          const t = m[p];
          if (t && t.isTexture) set.add(t);
        }
      }
    }
  });
  return Array.from(set);
}

// Read original mime type from parser associations
function getOriginalMimeTypeForTexture(texture, gltf) {
  const assoc = gltf.parser.associations?.get(texture);
  if (!assoc || assoc.textures === undefined) return null;
  try {
    const texIndex = assoc.textures;
    const texDef = gltf.parser.json.textures?.[texIndex];
    if (!texDef) return null;
    const imgIndex = texDef.source;
    const imgDef = gltf.parser.json.images?.[imgIndex];
    return imgDef?.mimeType || null;
  } catch {
    return null;
  }
}

function imageToCanvas(image) {
  const w = image.width || image.videoWidth || 0;
  const h = image.height || image.videoHeight || 0;
  if (!w || !h) return null;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  ctx.drawImage(image, 0, 0, w, h);
  return c;
}

function resizeCanvas(srcCanvas, scale) {
  if (!srcCanvas || scale === 1) return srcCanvas;
  const w = Math.max(1, Math.round(srcCanvas.width * scale));
  const h = Math.max(1, Math.round(srcCanvas.height * scale));
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const ctx = out.getContext("2d");
  // Higher-quality downscale
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(srcCanvas, 0, 0, srcCanvas.width, srcCanvas.height, 0, 0, w, h);
  return out;
}

function canvasToJPEGBlob(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob ? resolve(blob) : reject(new Error("JPEG encode failed")),
      "image/jpeg",
      quality
    );
  });
}

// PNG quantization using UPNG.js (lossy; keeps alpha)
async function canvasToQuantizedPNGBlob(canvas, colors /* 16..256 */) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const { width: w, height: h } = canvas;
  const imgData = ctx.getImageData(0, 0, w, h);
  const rgbaAB = imgData.data.buffer; // ArrayBuffer of RGBA
  const pngAB = UPNG.encode([rgbaAB], w, h, colors);
  return new Blob([pngAB], { type: "image/png" });
}

async function reencodeTexture(texture, mime, opts) {
  const img = texture.image;
  if (!img) return false;

  let srcCanvas = null;
  if (
    img instanceof ImageBitmap ||
    img instanceof HTMLImageElement ||
    img instanceof HTMLCanvasElement ||
    img instanceof OffscreenCanvas
  ) {
    srcCanvas = imageToCanvas(img);
  } else if (img.data && img.width && img.height) {
    // DataTexture case
    srcCanvas = document.createElement("canvas");
    srcCanvas.width = img.width;
    srcCanvas.height = img.height;
    const ctx = srcCanvas.getContext("2d");
    const imageData = new ImageData(
      new Uint8ClampedArray(img.data.buffer),
      img.width,
      img.height
    );
    ctx.putImageData(imageData, 0, 0);
  }
  if (!srcCanvas) return false;

  const beforeW = srcCanvas.width,
    beforeH = srcCanvas.height;
  const resized = resizeCanvas(srcCanvas, opts.resizeFactor);
  const afterW = resized.width,
    afterH = resized.height;

  try {
    let blob;
    if (mime === "image/jpeg") {
      blob = await canvasToJPEGBlob(resized, opts.jpegQuality);
    } else {
      blob = await canvasToQuantizedPNGBlob(resized, opts.pngColors);
    }

    const bitmap = await createImageBitmap(blob);
    texture.image = bitmap;
    texture.needsUpdate = true;
    texture.userData = texture.userData || {};
    texture.userData.mimeType =
      mime === "image/jpeg" ? "image/jpeg" : "image/png";

    log(
      `Re-encoded ${texture.name || "(unnamed)"} as ${
        texture.userData.mimeType
      }  ${beforeW}×${beforeH} -> ${afterW}×${afterH}` +
        (mime === "image/jpeg"
          ? `  q=${opts.jpegQuality}`
          : `  colors=${opts.pngColors}`)
    );
    return true;
  } catch (e) {
    log("Texture re-encode failed:", e);
    return false;
  }
}

async function processGLB(buffer, opts) {
  log("Parsing GLB…");
  const gltf = await loadGLBFromArrayBuffer(buffer);

  const textures = collectTextures(gltf.scene);
  log(`Found ${textures.length} texture(s).`);

  let ok = 0;
  for (const tex of textures) {
    const mime = getOriginalMimeTypeForTexture(tex, gltf) || "image/png";
    if (await reencodeTexture(tex, mime, opts)) ok++;
  }
  log(`Re-encoded ${ok}/${textures.length} textures.`);

  log("Exporting GLB…");
  const exporter = new GLTFExporter();
  const options = {
    binary: true,
    embedImages: true,
    includeCustomExtensions: true,
  };

  return new Promise((resolve, reject) => {
    exporter.parse(gltf.scene, (ab) => resolve(ab), reject, options);
  });
}
