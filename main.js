// Requires: npm i three upng-js jszip
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import * as UPNG from "upng-js";
import JSZip from "jszip";

// ---- DOM ----
const fileInput = document.getElementById("file");
const runBtn = document.getElementById("run");
const dl = document.getElementById("download");
const exportZipBtn = document.getElementById("exportZip");
const zipLink = document.getElementById("zipLink");
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

// ---- Loader setup ----
const loader = new GLTFLoader();
const draco = new DRACOLoader();
draco.setDecoderPath(
  "https://unpkg.com/three@0.158.0/examples/jsm/libs/draco/"
);
loader.setDRACOLoader(draco);

// Selection state
let selectedFiles = null;

/**
 * Per-file processed result:
 * { baseName: string, processedGLB?: ArrayBuffer, textures?: Map<string,{blob:Blob,name:string}>, originalTextures?: Map<string,{blob:Blob,name:string}> }
 */
let results = [];

// ---- File handling ----
fileInput.addEventListener("change", async (e) => {
  resetOutputs();
  selectedFiles = e.target.files;
  if (!selectedFiles || selectedFiles.length === 0) {
    runBtn.disabled = true;
    exportZipBtn.disabled = true;
    return;
  }
  logBox.textContent = `Selected ${selectedFiles.length} file(s).`;
  runBtn.disabled = false;
  exportZipBtn.disabled = false;
  results = [];
});

// ---- Actions ----
runBtn.addEventListener("click", async () => {
  if (!selectedFiles || selectedFiles.length === 0) return;

  runBtn.disabled = true;
  exportZipBtn.disabled = true;
  dl.classList.add("hidden");
  zipLink.classList.add("hidden");

  try {
    const opts = {
      resizeFactor: Number(resizeFactorSel.value),
      pngColors: parseInt(pngColorsRange.value, 10),
      jpegQuality: Number(jpegQRange.value),
    };

    log(`Processing ${selectedFiles.length} file(s)…`);
    results = [];
    for (const file of selectedFiles) {
      const buffer = await file.arrayBuffer();
      const base = file.name.replace(/\.glb$/i, "");
      const processed = await processOneGLB(buffer, base, opts);
      results.push(processed);
    }

    if (results.length === 1) {
      // Single GLB → direct .glb download
      const item = results[0];
      const blob = new Blob([item.processedGLB], { type: "model/gltf-binary" });
      const url = URL.createObjectURL(blob);
      dl.href = url;
      dl.download = `${item.baseName}.glb`;
      dl.textContent = `Download ${item.baseName}.glb`;
      dl.classList.remove("hidden");
      log("Done. Ready to download GLB.");
    } else {
      // Multiple → ZIP of .glb files
      const zip = new JSZip();
      for (const r of results) {
        zip.file(
          `${r.baseName}.glb`,
          new Blob([r.processedGLB], { type: "model/gltf-binary" })
        );
      }
      const zipBlob = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(zipBlob);
      const commonName =
        inferCommonPrefix(results.map((r) => r.baseName)) || "models";
      dl.href = url;
      dl.download = `${commonName}.glbs.zip`;
      dl.textContent = `Download ${commonName}.glbs.zip`;
      dl.classList.remove("hidden");
      log(`Done. Zipped ${results.length} GLBs.`);
    }
  } catch (err) {
    log("Error:", err);
  } finally {
    runBtn.disabled = false;
    exportZipBtn.disabled = false;
  }
});

// Export processed (if available) or original textures per model
exportZipBtn.addEventListener("click", async () => {
  if (!selectedFiles || selectedFiles.length === 0) return;
  try {
    // If user hasn’t processed yet, gather originals now
    if (results.length === 0) {
      const opts = { resizeFactor: 1, pngColors: 256, jpegQuality: 0.95 };
      for (const file of selectedFiles) {
        const buffer = await file.arrayBuffer();
        const base = file.name.replace(/\.glb$/i, "");
        const { originalTextures } = await extractOriginalTextures(
          buffer,
          base,
          opts
        );
        results.push({ baseName: base, originalTextures });
      }
    }

    const zip = new JSZip();
    for (const r of results) {
      const folder = zip.folder(r.baseName) || zip;
      const texMap = r.textures || r.originalTextures; // prefer processed textures
      if (!texMap || texMap.size === 0) continue;
      for (const [relName, info] of texMap.entries()) {
        folder.file(relName, info.blob);
      }
    }

    const zipBlob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(zipBlob);

    const name =
      selectedFiles.length === 1
        ? `${results[0].baseName}.textures.zip`
        : `${
            inferCommonPrefix(results.map((r) => r.baseName)) || "models"
          }.textures.zip`;

    zipLink.href = url;
    zipLink.download = name;
    zipLink.textContent = `Download ${name}`;
    zipLink.classList.remove("hidden");
    log(`Prepared textures ZIP for ${results.length} model(s).`);
  } catch (e) {
    log("ZIP export failed:", e);
  }
});

// ---- Helpers ----
function resetOutputs() {
  dl.classList.add("hidden");
  zipLink.classList.add("hidden");
  dl.removeAttribute("href");
  dl.removeAttribute("download");
  zipLink.removeAttribute("href");
  zipLink.removeAttribute("download");
  logBox.textContent = "Load .glb file(s) to begin…";
  results = [];
}

function inferCommonPrefix(names) {
  if (!names || names.length === 0) return "";
  let pref = names[0];
  for (let i = 1; i < names.length; i++) {
    while (names[i].indexOf(pref) !== 0 && pref.length)
      pref = pref.slice(0, -1);
    if (!pref) break;
  }
  return pref.replace(/[-_.]+$/, "");
}

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
      for (const m of mats)
        for (const p of textureProps) {
          const t = m[p];
          if (t && t.isTexture) set.add(t);
        }
    }
  });
  return Array.from(set);
}

function getImageDefForTexture(texture, gltf) {
  const assoc = gltf.parser.associations?.get(texture);
  if (!assoc || assoc.textures === undefined) return null;
  try {
    const texIndex = assoc.textures;
    const texDef = gltf.parser.json.textures?.[texIndex];
    if (!texDef) return null;
    const imgIndex = texDef.source;
    const imgDef = gltf.parser.json.images?.[imgIndex];
    if (imgIndex === undefined || !imgDef) return null;
    return { imgIndex, imgDef };
  } catch {
    return null;
  }
}

function filenameForImageDef(imgDef, imgIndex, targetMime) {
  const fromUri =
    imgDef.uri && !imgDef.uri.startsWith("data:")
      ? imgDef.uri.split("/").pop()
      : null;
  const baseName = imgDef.name || fromUri || `image_${imgIndex}`;
  const extFromName = baseName.includes(".")
    ? baseName.split(".").pop().toLowerCase()
    : null;
  const wantExt =
    targetMime === "image/jpeg"
      ? extFromName === "jpeg"
        ? "jpeg"
        : "jpg"
      : "png";
  if (!extFromName) return `${baseName}.${wantExt}`;
  const needJpeg = targetMime === "image/jpeg";
  const isPng = extFromName === "png";
  const isJpg = extFromName === "jpg" || extFromName === "jpeg";
  if ((needJpeg && !isJpg) || (!needJpeg && !isPng)) {
    const nameOnly = baseName.slice(0, baseName.lastIndexOf("."));
    return `${nameOnly}.${wantExt}`;
  }
  return baseName;
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

async function canvasToQuantizedPNGBlob(canvas, colors) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const { width: w, height: h } = canvas;
  const imgData = ctx.getImageData(0, 0, w, h);
  const rgbaAB = imgData.data.buffer;
  const pngAB = UPNG.encode([rgbaAB], w, h, colors);
  return new Blob([pngAB], { type: "image/png" });
}

async function reencodeTexture(
  texture,
  mime,
  opts,
  gltf,
  baseName,
  texturesMap
) {
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
    let blob, targetMime;
    if (mime === "image/jpeg") {
      targetMime = "image/jpeg";
      blob = await canvasToJPEGBlob(resized, opts.jpegQuality);
    } else {
      targetMime = "image/png";
      blob = await canvasToQuantizedPNGBlob(resized, opts.pngColors);
    }

    const bitmap = await createImageBitmap(blob);
    texture.image = bitmap;
    texture.needsUpdate = true;
    texture.userData = texture.userData || {};
    texture.userData.mimeType = targetMime;

    const info = getImageDefForTexture(texture, gltf);
    if (info) {
      const { imgIndex, imgDef } = info;
      const name = filenameForImageDef(imgDef, imgIndex, targetMime);
      texturesMap.set(name, { blob, name });
    }

    log(
      `[${baseName}] ${
        texture.name || "(unnamed)"
      } → ${targetMime}  ${beforeW}×${beforeH} -> ${afterW}×${afterH}` +
        (targetMime === "image/jpeg"
          ? `  q=${opts.jpegQuality}`
          : `  colors=${opts.pngColors}`)
    );
    return true;
  } catch (e) {
    log(`[${baseName}] Texture re-encode failed:`, e);
    return false;
  }
}

async function extractOriginalTextures(buffer, baseName) {
  const gltf = await loadGLBFromArrayBuffer(buffer);
  const textures = collectTextures(gltf.scene);
  const originals = new Map();

  for (const tex of textures) {
    const info = getImageDefForTexture(tex, gltf);
    if (!info) continue;
    const { imgIndex, imgDef } = info;
    const img = tex.image;

    let srcCanvas = null;
    if (
      img instanceof ImageBitmap ||
      img instanceof HTMLImageElement ||
      img instanceof HTMLCanvasElement ||
      img instanceof OffscreenCanvas
    ) {
      srcCanvas = imageToCanvas(img);
    } else if (img?.data && img.width && img.height) {
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
    if (!srcCanvas) continue;

    const origMime = imgDef.mimeType || "image/png";
    const blob =
      origMime === "image/jpeg"
        ? await canvasToJPEGBlob(srcCanvas, 0.95)
        : await canvasToQuantizedPNGBlob(srcCanvas, 256);

    const name = filenameForImageDef(imgDef, imgIndex, origMime);
    originals.set(name, { blob, name });
  }
  return { baseName, originalTextures: originals };
}

async function processOneGLB(buffer, baseName, opts) {
  const gltf = await loadGLBFromArrayBuffer(buffer);
  const textures = collectTextures(gltf.scene);
  const processedTextures = new Map();

  let ok = 0;
  for (const tex of textures) {
    const info = getImageDefForTexture(tex, gltf);
    const origMime = info?.imgDef?.mimeType || "image/png";
    if (
      await reencodeTexture(
        tex,
        origMime,
        opts,
        gltf,
        baseName,
        processedTextures
      )
    )
      ok++;
  }
  log(
    `[${baseName}] Re-encoded ${ok}/${textures.length} textures. Exporting GLB…`
  );

  const exporter = new GLTFExporter();
  const options = {
    binary: true,
    embedImages: true,
    includeCustomExtensions: true,
  };
  const processedGLB = await new Promise((resolve, reject) => {
    exporter.parse(gltf.scene, (ab) => resolve(ab), reject, options);
  });

  return { baseName, processedGLB, textures: processedTextures };
}
