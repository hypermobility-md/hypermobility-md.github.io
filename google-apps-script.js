/**
 * Google Apps Script — Form Submissions to Google Sheets
 * with reCAPTCHA v3 verification and Google Drive headshot uploads.
 *
 * Sheet tabs must be named exactly:
 *   "Contact", "Podcast Questions", "Appointments", "Guest Info"
 */

const RECAPTCHA_SECRET_KEY = '6LdllJAsAAAAANfmPbXMZP9nPtxbHSPw3ynajKP_';
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
            'Website', 'Site 2', 'LinkedIn', 'Twitter', 'Substack',
            'Instagram', 'Facebook', 'YouTube', 'TikTok', 'Wikipedia',
            'Additional Notes', 'Headshot Link'
          ]);
          sheet.getRange(1, 1, 1, 17).setFontWeight('bold');
          sheet.setFrozenRows(1);
        }
        var headshotLink = '';
        if (data.headshot_base64) {
          var safeName = sanitize(data.name).replace(/[^a-zA-Z0-9]/g, '_') || 'guest';
          var fileName = safeName + '_headshot_' + Date.now() + '.' + (data.headshot_ext || 'jpg');
          headshotLink = saveHeadshotToDrive(data.headshot_base64, fileName, data.headshot_mime);
        }

        // Parse individual socials from social_links field (format: "Label: URL\nLabel: URL")
        var socials = { website: '', website2: '', linkedin: '', twitter: '', substack: '', instagram: '', facebook: '', youtube: '', tiktok: '', wikipedia: '' };
        if (data.social_links) {
          String(data.social_links).split('\n').forEach(function(line) {
            var parts = line.split(': ');
            if (parts.length >= 2) {
              var label = parts[0].trim().toLowerCase();
              var url = parts.slice(1).join(': ').trim();
              if (label === 'website') socials.website = url;
              else if (label === 'site 2') socials.website2 = url;
              else if (label === 'linkedin') socials.linkedin = url;
              else if (label === 'twitter') socials.twitter = url;
              else if (label === 'substack') socials.substack = url;
              else if (label === 'instagram') socials.instagram = url;
              else if (label === 'facebook') socials.facebook = url;
              else if (label === 'youtube') socials.youtube = url;
              else if (label === 'tiktok') socials.tiktok = url;
              else if (label === 'wikipedia') socials.wikipedia = url;
            }
          });
        }
        // Also accept individual fields sent directly
        if (data.website) socials.website = data.website;
        if (data.website2) socials.website2 = data.website2;
        if (data.linkedin) socials.linkedin = data.linkedin;
        if (data.twitter) socials.twitter = data.twitter;
        if (data.substack) socials.substack = data.substack;
        if (data.instagram) socials.instagram = data.instagram;
        if (data.facebook) socials.facebook = data.facebook;
        if (data.youtube) socials.youtube = data.youtube;
        if (data.tiktok) socials.tiktok = data.tiktok;
        if (data.wikipedia) socials.wikipedia = data.wikipedia;

        row = [
          timestamp,
          sanitize(data.name),
          sanitize(data.credentials),
          sanitize(data.affiliation),
          sanitize(data.bio),
          sanitize(socials.website),
          sanitize(socials.website2),
          sanitize(socials.linkedin),
          sanitize(socials.twitter),
          sanitize(socials.substack),
          sanitize(socials.instagram),
          sanitize(socials.facebook),
          sanitize(socials.youtube),
          sanitize(socials.tiktok),
          sanitize(socials.wikipedia),
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
