/**
 * Shared form submission helper — sends data to a Google Apps Script,
 * which appends a row to a private Google Sheet.
 */

const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxXGMUHDiAGu3qz2jM-WLSLQl7-JwA_YUASYl1UJbzZfcpmGx7m81lgfqdh6zceYDR49A/exec';

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
