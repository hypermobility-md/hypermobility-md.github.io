/**
 * Shared form submission helper — sends data to Google Apps Script
 * with reCAPTCHA v3 verification.
 *
 * SETUP:
 * 1. Go to https://www.google.com/recaptcha/admin
 * 2. Register your site, choose reCAPTCHA v3
 * 3. Add your domain(s) (e.g. hypermobility-md.github.io, localhost)
 * 4. Copy the SITE KEY and replace YOUR_RECAPTCHA_SITE_KEY_HERE in:
 *    - This file (RECAPTCHA_SITE_KEY below)
 *    - src/_includes/base.njk (the script tag)
 * 5. Copy the SECRET KEY and put it in the Apps Script
 *    (RECAPTCHA_SECRET_KEY variable — NOT in this file!)
 */

const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxXGMUHDiAGu3qz2jM-WLSLQl7-JwA_YUASYl1UJbzZfcpmGx7m81lgfqdh6zceYDR49A/exec';
const RECAPTCHA_SITE_KEY = '6LeEm5ksAAAAAJL3lpiSAZ6621GqXH_Gw4AN8fkw';

/**
 * Submit form data to Google Sheets via Apps Script.
 * Automatically obtains a reCAPTCHA token before sending.
 */
async function submitToSheet(formType, data) {
  // Get reCAPTCHA token (invisible — no user interaction needed)
  let recaptchaToken = '';
  try {
    recaptchaToken = await grecaptcha.execute(RECAPTCHA_SITE_KEY, { action: formType });
  } catch (err) {
    console.warn('reCAPTCHA not available, submitting without token');
  }

  const payload = Object.assign({}, data, {
    _form: formType,
    _recaptcha: recaptchaToken
  });

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
 * Convert a File object to a base64 string.
 * Used for headshot uploads in the guest form.
 */
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
