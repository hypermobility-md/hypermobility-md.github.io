/**
 * Google Apps Script — Form Submissions to Google Sheets
 * with reCAPTCHA v3 verification and Google Drive headshot uploads.
 *
 * SETUP INSTRUCTIONS:
 * 1. Open your Google Sheet (the one with 4 tabs)
 * 2. Go to Extensions > Apps Script
 * 3. Delete any existing code and paste this entire file
 * 4. Set RECAPTCHA_SECRET_KEY below (from https://www.google.com/recaptcha/admin)
 * 5. Set DRIVE_FOLDER_ID below (the Google Drive folder for headshot uploads)
 * 6. Click Deploy > New deployment
 * 7. Choose "Web app" as the type
 * 8. Set "Execute as" to "Me" (your Google account)
 * 9. Set "Who has access" to "Anyone"
 * 10. Click Deploy and copy the web app URL
 * 11. IMPORTANT: Name your 4 sheet tabs exactly:
 *     - "Contact"
 *     - "Podcast Questions"
 *     - "Appointments"
 *     - "Guest Info"
 *
 * RECAPTCHA SETUP:
 * The secret key goes HERE (server-side only, never in the website code).
 * The site key goes in the website's form-submit.js and base.njk.
 *
 * DRIVE FOLDER SETUP:
 * Create a folder in Google Drive for guest headshots. Open the folder
 * and copy the ID from the URL (the long string after /folders/).
 */

const RECAPTCHA_SECRET_KEY = 'YOUR_RECAPTCHA_SECRET_KEY_HERE';
const RECAPTCHA_SCORE_THRESHOLD = 0.5; // 0.0 = likely bot, 1.0 = likely human
const DRIVE_FOLDER_ID = 'YOUR_DRIVE_FOLDER_ID_HERE';

// Maximum field length to prevent abuse
const MAX_FIELD_LENGTH = 5000;
// Maximum headshot file size (10 MB in base64 ≈ 13.3 MB string)
const MAX_FILE_SIZE = 14000000;

/**
 * Verify a reCAPTCHA v3 token with Google's API.
 * Returns true if the token is valid and the score is above the threshold.
 */
function verifyRecaptcha(token) {
  if (!token) return false;
  if (RECAPTCHA_SECRET_KEY === 'YOUR_RECAPTCHA_SECRET_KEY_HERE') {
    // Secret key not configured yet — allow submissions during development
    return true;
  }

  try {
    const response = UrlFetchApp.fetch('https://www.google.com/recaptcha/api/siteverify', {
      method: 'post',
      payload: {
        secret: RECAPTCHA_SECRET_KEY,
        response: token
      }
    });
    const result = JSON.parse(response.getContentText());
    return result.success && result.score >= RECAPTCHA_SCORE_THRESHOLD;
  } catch (err) {
    // If verification fails (network issue, etc.), reject to be safe
    return false;
  }
}

/**
 * Sanitize a value to prevent formula injection.
 * Prefixes with a single quote if the value starts with =, +, -, @, or tab/newline.
 * This forces Google Sheets to treat it as plain text.
 */
function sanitize(val) {
  if (val === null || val === undefined) return '';
  let s = String(val).substring(0, MAX_FIELD_LENGTH);
  if (/^[=+\-@\t\r\n]/.test(s)) {
    s = "'" + s;
  }
  return s;
}

/**
 * Save a base64-encoded image to Google Drive and return the shareable link.
 */
function saveHeadshotToDrive(base64Data, fileName, mimeType) {
  if (!base64Data || base64Data.length > MAX_FILE_SIZE) return '';
  if (DRIVE_FOLDER_ID === 'YOUR_DRIVE_FOLDER_ID_HERE') return '(Drive folder not configured)';

  try {
    const folder = DriveApp.getFolderById(DRIVE_FOLDER_ID);
    const blob = Utilities.newBlob(
      Utilities.base64Decode(base64Data),
      mimeType || 'image/jpeg',
      fileName || 'headshot.jpg'
    );
    const file = folder.createFile(blob);
    // Make viewable by anyone with the link
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    return file.getUrl();
  } catch (err) {
    return '(Upload failed: ' + err.message + ')';
  }
}

/**
 * Handle POST requests from the website forms.
 */
function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);

    // Verify reCAPTCHA
    if (!verifyRecaptcha(data._recaptcha)) {
      return ContentService
        .createTextOutput(JSON.stringify({ error: 'reCAPTCHA verification failed' }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    const formType = data._form;
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sheet;
    let row;
    const timestamp = new Date().toISOString();

    switch (formType) {
      case 'contact':
        sheet = ss.getSheetByName('Contact');
        if (!sheet) throw new Error('Sheet "Contact" not found');
        if (sheet.getLastRow() === 0) {
          sheet.appendRow(['Timestamp', 'First Name', 'Last Name', 'Email', 'Subject', 'Message']);
          sheet.getRange(1, 1, 1, 6).setFontWeight('bold');
          sheet.setFrozenRows(1);
        }
        row = [
          timestamp,
          sanitize(data.first_name),
          sanitize(data.last_name),
          sanitize(data.email),
          sanitize(data.subject),
          sanitize(data.message)
        ];
        sheet.appendRow(row);
        sheet.getRange(sheet.getLastRow(), 1, 1, row.length).setNumberFormat('@');
        break;

      case 'podcast_question':
        sheet = ss.getSheetByName('Podcast Questions');
        if (!sheet) throw new Error('Sheet "Podcast Questions" not found');
        if (sheet.getLastRow() === 0) {
          sheet.appendRow(['Timestamp', 'Topic', 'Question', 'Attribution Type', 'Display Name', 'Email']);
          sheet.getRange(1, 1, 1, 6).setFontWeight('bold');
          sheet.setFrozenRows(1);
        }
        row = [
          timestamp,
          sanitize(data.topic),
          sanitize(data.question),
          sanitize(data.attribution),
          sanitize(data.display_name),
          sanitize(data.email)
        ];
        sheet.appendRow(row);
        sheet.getRange(sheet.getLastRow(), 1, 1, row.length).setNumberFormat('@');
        break;

      case 'appointment':
        sheet = ss.getSheetByName('Appointments');
        if (!sheet) throw new Error('Sheet "Appointments" not found');
        if (sheet.getLastRow() === 0) {
          sheet.appendRow([
            'Timestamp', 'First Name', 'Last Name', 'Email', 'Phone',
            'Address', 'How Heard', 'Referred By', 'Top Issues', 'Goals',
            'Past Treatments', 'Additional Notes', 'Location', 'Package'
          ]);
          sheet.getRange(1, 1, 1, 14).setFontWeight('bold');
          sheet.setFrozenRows(1);
        }
        row = [
          timestamp,
          sanitize(data.first_name),
          sanitize(data.last_name),
          sanitize(data.email),
          sanitize(data.phone),
          sanitize(data.address),
          sanitize(data.how_heard),
          sanitize(data.referral),
          sanitize(data.top_issues),
          sanitize(data.goals),
          sanitize(data.past_treatments),
          sanitize(data.additional),
          sanitize(data.location),
          sanitize(data.package)
        ];
        sheet.appendRow(row);
        sheet.getRange(sheet.getLastRow(), 1, 1, row.length).setNumberFormat('@');
        break;

      case 'guest_info':
        sheet = ss.getSheetByName('Guest Info');
        if (!sheet) throw new Error('Sheet "Guest Info" not found');
        if (sheet.getLastRow() === 0) {
          sheet.appendRow([
            'Timestamp', 'Name', 'Credentials', 'Affiliation', 'Bio',
            'Website', 'Social Links', 'Additional Notes', 'Headshot Link'
          ]);
          sheet.getRange(1, 1, 1, 9).setFontWeight('bold');
          sheet.setFrozenRows(1);
        }
        // Upload headshot to Google Drive if provided
        let headshotLink = '';
        if (data.headshot_base64) {
          const safeName = sanitize(data.name).replace(/[^a-zA-Z0-9]/g, '_') || 'guest';
          const fileName = safeName + '_headshot_' + Date.now() + '.' + (data.headshot_ext || 'jpg');
          headshotLink = saveHeadshotToDrive(data.headshot_base64, fileName, data.headshot_mime);
        }
        row = [
          timestamp,
          sanitize(data.name),
          sanitize(data.credentials),
          sanitize(data.affiliation),
          sanitize(data.bio),
          sanitize(data.website),
          sanitize(data.social_links),
          sanitize(data.additional),
          headshotLink
        ];
        sheet.appendRow(row);
        sheet.getRange(sheet.getLastRow(), 1, 1, row.length).setNumberFormat('@');
        break;

      default:
        return ContentService
          .createTextOutput(JSON.stringify({ error: 'Unknown form type' }))
          .setMimeType(ContentService.MimeType.JSON);
    }

    return ContentService
      .createTextOutput(JSON.stringify({ success: true }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * Handle GET requests (for testing — visit the web app URL in a browser).
 */
function doGet() {
  return ContentService
    .createTextOutput('Hypermobility MD form endpoint is active.')
    .setMimeType(ContentService.MimeType.TEXT);
}
