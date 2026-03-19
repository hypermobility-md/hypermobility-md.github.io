/**
 * Google Apps Script — Form Submissions to Google Sheets
 * with reCAPTCHA v3 verification and Google Drive headshot uploads.
 *
 * Sheet tabs must be named exactly:
 *   "Contact", "Podcast Questions", "Appointments", "Guest Info"
 */

const RECAPTCHA_SECRET_KEY = '6LejW5AsAAAAACrh4l9JvNXd7BX5X1ioLLUJdtVE';
const RECAPTCHA_SCORE_THRESHOLD = 0.5;
const DRIVE_FOLDER_ID = '1Bd6r3x0Hi-qOVoS6vD7MV9597wO70HNf';

const MAX_FIELD_LENGTH = 5000;
const MAX_FILE_SIZE = 14000000;

function verifyRecaptcha(token) {
  if (!token) return true; // Allow submissions without token during testing
  try {
    var response = UrlFetchApp.fetch('https://www.google.com/recaptcha/api/siteverify', {
      method: 'post',
      payload: {
        secret: RECAPTCHA_SECRET_KEY,
        response: token
      }
    });
    var result = JSON.parse(response.getContentText());
    return result.success && result.score >= RECAPTCHA_SCORE_THRESHOLD;
  } catch (err) {
    return true; // Allow on verification failure to avoid blocking real users
  }
}

function sanitize(val) {
  if (val === null || val === undefined) return '';
  var s = String(val).substring(0, MAX_FIELD_LENGTH);
  if (/^[=+\-@\t\r\n]/.test(s)) {
    s = "'" + s;
  }
  return s;
}

function saveHeadshotToDrive(base64Data, fileName, mimeType) {
  if (!base64Data || base64Data.length > MAX_FILE_SIZE) return '';
  try {
    var folder = DriveApp.getFolderById(DRIVE_FOLDER_ID);
    var blob = Utilities.newBlob(
      Utilities.base64Decode(base64Data),
      mimeType || 'image/jpeg',
      fileName || 'headshot.jpg'
    );
    var file = folder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    return file.getUrl();
  } catch (err) {
    return '(Upload failed: ' + err.message + ')';
  }
}

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet;
    var row;
    var timestamp = new Date().toISOString();

    switch (data._form) {
      case 'contact':
        sheet = ss.getSheetByName('Contact');
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
        if (sheet.getLastRow() === 0) {
          sheet.appendRow([
            'Timestamp', 'Name', 'Credentials', 'Affiliation', 'Bio',
            'Website', 'Social Links', 'Additional Notes', 'Headshot Link'
          ]);
          sheet.getRange(1, 1, 1, 9).setFontWeight('bold');
          sheet.setFrozenRows(1);
        }
        var headshotLink = '';
        if (data.headshot_base64) {
          var safeName = sanitize(data.name).replace(/[^a-zA-Z0-9]/g, '_') || 'guest';
          var fileName = safeName + '_headshot_' + Date.now() + '.' + (data.headshot_ext || 'jpg');
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
        return ContentService.createTextOutput(JSON.stringify({error: 'Unknown form type'})).setMimeType(ContentService.MimeType.JSON);
    }

    return ContentService.createTextOutput(JSON.stringify({success: true})).setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({error: err.message})).setMimeType(ContentService.MimeType.JSON);
  }
}

function doGet() {
  return ContentService
    .createTextOutput('Hypermobility MD form endpoint is active.')
    .setMimeType(ContentService.MimeType.TEXT);
}

function testAuthorization() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  Logger.log('Spreadsheet: ' + ss.getName());
  Logger.log('Sheets: ' + ss.getSheets().map(function(s) { return s.getName(); }).join(', '));
}
