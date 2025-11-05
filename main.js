import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import * as UPNG from "upng-js";
import JSZip from "jszip";

// DOM
const fileInput = document.getElementById("file");
const runBtn = document.getElementById("run");
const dl = document.getElementById("download");
const logBox = document.getElementById("log");
const resizeFactorSel = document.getElementById("resizeFactor");
const pngColorsRange = document.getElementById("pngColors");
const pngColorsVal = document.getElementById("pngColorsVal");
const jpegQRange = document.getElementById("jpegQ");
const jpegQVal = document.getElementById("jpegQVal");

pngColorsRange.oninput = () =>
  (pngColorsVal.textContent = pngColorsRange.value);
jpegQRange.oninput = () =>
  (jpegQVal.textContent = Number(jpegQRange.value).toFixed(2));

const log = (...a) => {
  console.log(...a);
  logBox.textContent +=
    "\n" +
    a
      .map((x) => (typeof x === "string" ? x : JSON.stringify(x, null, 2)))
      .join(" ");
};

// Three.js loaders
const loader = new GLTFLoader();
const draco = new DRACOLoader();
draco.setDecoderPath(
  "https://unpkg.com/three@0.158.0/examples/jsm/libs/draco/"
);
loader.setDRACOLoader(draco);

// ---- Multiple file handling ----
fileInput.addEventListener("change", (e) => {
  const files = e.target.files;
  if (!files?.length) {
    runBtn.disabled = true;
    logBox.textContent = "No files selected.";
    return;
  }
  runBtn.disabled = false;
  logBox.textContent =
    `Loaded ${files.length} file(s):\n` +
    Array.from(files)
      .map((f) => `- ${f.name} (${Math.round(f.size / 1024)} KB)`)
      .join("\n");
});

runBtn.addEventListener("click", async () => {
  const files = fileInput.files;
  if (!files?.length) return;
  runBtn.disabled = true;
  dl.classList.add("hidden");
  logBox.textContent = "Processing files…";

  const results = [];

  for (const file of files) {
    try {
      log(`\n==== ${file.name} ====`);
      const buffer = await file.arrayBuffer();

      const out = await processGLB(buffer, {
        resizeFactor: Number(resizeFactorSel.value),
        pngColors: parseInt(pngColorsRange.value, 10),
        jpegQuality: Number(jpegQRange.value),
      });

      const blob = new Blob([out], { type: "model/gltf-binary" });
      const url = URL.createObjectURL(blob);
      const outName = file.name.replace(/\.glb$/i, ".glb");
      results.push({ name: outName, url });
      log(`Done: ${outName}`);
    } catch (err) {
      log(`Error with ${file.name}:`, err);
    }
  }

  if (results.length > 1) {
    const zip = new JSZip();
    for (const r of results) {
      const res = await fetch(r.url);
      const blob = await res.blob();
      zip.file(r.name, blob);
    }
    const zipBlob = await zip.generateAsync({ type: "blob" });
    const zipUrl = URL.createObjectURL(zipBlob);
    dl.href = zipUrl;
    dl.download = "compressed_glbs.zip";
    dl.textContent = "Download compressed_glbs.zip";
  } else if (results.length === 1) {
    const r = results[0];
    dl.href = r.url;
    dl.download = r.name;
    dl.textContent = `Download ${r.name}`;
  }

  dl.classList.remove("hidden");
  log("\nAll done!");
  runBtn.disabled = false;
});

// ---- Helpers (same as before) ----
function loadGLBFromArrayBuffer(buffer) {
  return new Promise((res, rej) => loader.parse(buffer, "", res, rej));
}

function collectTextures(root) {
  const props = [
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
      for (const m of mats)
        for (const p of props) if (m[p]?.isTexture) set.add(m[p]);
    }
  });
  return Array.from(set);
}

function getOriginalMimeTypeForTexture(tex, gltf) {
  const assoc = gltf.parser.associations?.get(tex);
  if (!assoc || assoc.textures === undefined) return null;
  try {
    const texDef = gltf.parser.json.textures?.[assoc.textures];
    const imgDef = gltf.parser.json.images?.[texDef?.source];
    return imgDef?.mimeType || null;
  } catch {
    return null;
  }
}

function imageToCanvas(image) {
  const w = image.width || image.videoWidth || 0;
  const h = image.height || image.videoHeight || 0;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  ctx.drawImage(image, 0, 0, w, h);
  return c;
}

function resizeCanvas(src, scale) {
  if (scale === 1) return src;
  const w = Math.max(1, Math.round(src.width * scale));
  const h = Math.max(1, Math.round(src.height * scale));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, src.width, src.height, 0, 0, w, h);
  return c;
}

function canvasToJPEGBlob(c, q) {
  return new Promise((res, rej) =>
    c.toBlob(
      (b) => (b ? res(b) : rej(new Error("JPEG failed"))),
      "image/jpeg",
      q
    )
  );
}

async function canvasToQuantizedPNGBlob(c, colors) {
  const ctx = c.getContext("2d", { willReadFrequently: true });
  const { width, height } = c;
  const imgData = ctx.getImageData(0, 0, width, height);
  const pngAB = UPNG.encode([imgData.data.buffer], width, height, colors);
  return new Blob([pngAB], { type: "image/png" });
}

async function reencodeTexture(tex, mime, opts) {
  const img = tex.image;
  if (!img) return false;
  const src = imageToCanvas(img);
  const resized = resizeCanvas(src, opts.resizeFactor);
  let blob;
  if (mime === "image/jpeg")
    blob = await canvasToJPEGBlob(resized, opts.jpegQuality);
  else blob = await canvasToQuantizedPNGBlob(resized, opts.pngColors);
  const bitmap = await createImageBitmap(blob);
  tex.image = bitmap;
  tex.userData = { mimeType: mime };
  tex.needsUpdate = true;
  return true;
}

async function processGLB(buffer, opts) {
  const gltf = await loadGLBFromArrayBuffer(buffer);
  const textures = collectTextures(gltf.scene);
  let ok = 0;
  for (const t of textures) {
    const mime = getOriginalMimeTypeForTexture(t, gltf) || "image/png";
    if (await reencodeTexture(t, mime, opts)) ok++;
  }
  log(`Re-encoded ${ok}/${textures.length} textures`);
  const exporter = new GLTFExporter();
  return new Promise((res, rej) => {
    exporter.parse(gltf.scene, (ab) => res(ab), rej, {
      binary: true,
      embedImages: true,
    });
  });
}
