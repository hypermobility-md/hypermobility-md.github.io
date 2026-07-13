/**
 * Shared form submission helper — sends data to a Google Apps Script,
 * which appends a row to a private Google Sheet.
 */

const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwyO98s8OgXIlYVp2-sclAiI-8m7abO3PexchGM5ib5oquF3TJuC-p80Pd5KTS8FSO6AQ/exec';

/**
 * Submit form data to Google Sheets via Apps Script.
 */
async function submitToSheet(formType, data) {
  const payload = Object.assign({}, data, { _form: formType });

  // Use no-cors fetch. Apps Script redirects on POST, so we follow it.
  try {
    await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      mode: 'no-cors',
      redirect: 'follow',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    // With no-cors, network errors surface here but the request
    // typically still reaches Apps Script. Log for debugging.
    console.warn('Form submission fetch error (may still succeed):', err);
  }

  return true;
}

/**
 * Add yellow highlight to invalid fields on submit attempt.
 * Forms get a 'submitted' class so CSS :invalid styles activate.
 */
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('form').forEach(form => {
    form.addEventListener('submit', () => {
      form.classList.add('submitted');
    });
    // Clear highlight once the user fixes a field
    form.addEventListener('input', (e) => {
      if (e.target.validity && e.target.validity.valid) {
        e.target.style.borderColor = '';
        e.target.style.background = '';
        e.target.style.boxShadow = '';
      }
    });
  });
});

/**
 * Downscale + recompress an image File in the browser before upload.
 *
 * Phone photos are routinely 5–12 MB. Sent as base64, a payload that big can
 * exceed Google Apps Script's memory limit while it parses the request —
 * killing the whole submission before it can even be logged. Shrinking the
 * image here caps the payload at a few hundred KB, so that failure can't
 * happen. Output is always JPEG (these are photos); any transparency is
 * flattened onto white rather than the canvas default of black.
 *
 * @param {File} file      The user-selected image.
 * @param {number} maxDim  Longest edge in pixels (default 1600).
 * @param {number} quality JPEG quality, 0–1 (default 0.85).
 * @returns {Promise<{base64: string, mime: string, ext: string}>}
 */
async function compressImage(file, maxDim = 1600, quality = 0.85) {
  // Decode with EXIF orientation applied where supported, so portrait phone
  // photos don't come out sideways. Fall back to a plain <img> decode.
  let source;
  try {
    source = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (e) {
    source = await loadImageElement(file);
  }

  const sw = source.naturalWidth || source.width;
  const sh = source.naturalHeight || source.height;
  const scale = Math.min(1, maxDim / Math.max(sw, sh)); // only ever shrink
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff'; // flatten any transparency onto white, not black
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(source, 0, 0, w, h);
  if (source.close) source.close();

  const dataUrl = canvas.toDataURL('image/jpeg', quality);
  return { base64: dataUrl.split(',')[1], mime: 'image/jpeg', ext: 'jpg' };
}

/** Fallback image decoder for browsers that reject createImageBitmap options. */
function loadImageElement(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image could not be decoded.')); };
    img.src = url;
  });
}
