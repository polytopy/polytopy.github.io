// Polytopy contact form backend.
//
// doGet issues a challenge: a random nonce plus the code (or text question)
// that goes with it. The answer stays here, in the script cache, and never
// leaves. doPost only accepts a submission that quotes a nonce this script
// issued, that has not been used before, and that is old enough to have been
// read by a person. That is the part the browser cannot do for itself: a
// static page has nowhere to keep a secret, so anything it checks on its own
// it can also be talked out of.
//
// Everything written to the sheet or the notification mail goes through
// cleanText_ and cellSafe_ first, and the mail is sent as plain text.

const SHEET_NAME = 'Responses';
// Assembled rather than written out, so the public repository does not carry
// an address a crawler can lift. That is all it does: it beats a regex, not
// anyone who reads the line.
const NOTIFY_ADDRESS = ['info', 'polytopy.com'].join('@');

// What happens to a submission that fails the human check. Anything other
// than the two values below means 'reject', so a typo here closes the gate
// rather than opening it.
//
//   'reject'  Turned away. Nothing recorded, nothing emailed. Normal running.
//
//   'record'  Recorded and emailed anyway, with the outcome in the Captcha
//             column and '[check failed]' on the subject line, but the sender
//             is still told it did not pass. This is the one for watching what
//             the check actually catches. Do not leave it on: a spam run lands
//             in the inbox, marked but delivered.
//
//   'accept'  Treated as though it had passed. The gate is off. Use it to
//             prove the sheet and the mail work end to end, then put it back.
//
const ON_CHALLENGE_FAILURE = 'reject';

// Whether a submission carrying no nonce at all counts as a failure. Set this
// to false for a grace period if the site is still serving the old captcha.js,
// which sends no nonce. A wrong answer is a failure either way.
const REQUIRE_CHALLENGE = true;

const CHALLENGE_TTL_SECONDS = 3600;     // How long a challenge stays answerable.
const MIN_FILL_SECONDS = 3;             // Nobody reads a code and submits faster.
const MAX_SUBMISSIONS_PER_HOUR = 30;    // Backstop on the Gmail sending quota.
const MAX_PER_SENDER_PER_HOUR = 3;
const MAX_CHALLENGES_PER_HOUR = 500;
const SPAM_SCORE_LIMIT = 4;             // At or above this, flag but still deliver.
const MAX_FIELD_LENGTH = 5000;

// Must match ALPHABET and CODE_LENGTH in theme/scripts/captcha.js.
const CODE_ALPHABET = 'ACDEFHJKLMNPRTVWXY34';
const CODE_LENGTH = 4;

const scriptProp = PropertiesService.getScriptProperties();

function initialSetup () {
  const activeSpreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  scriptProp.setProperty('key', activeSpreadsheet.getId());
}

// --- Challenge issuing ---

function doGet (e) {
  const parameters = (e && e.parameter) || {};
  const cache = CacheService.getScriptCache();

  if (countInHour_(cache, 'issued', MAX_CHALLENGES_PER_HOUR) === null) {
    return jsonOutput_({ result: 'error', error: 'Too many requests, please try again later.' });
  }

  const nonce = Utilities.getUuid().replace(/-/g, '');
  const issued = { at: Date.now() };
  const payload = { result: 'challenge', nonce: nonce };

  if (parameters.mode === 'text') {
    const question = textQuestion_();
    issued.answers = question.answers;
    payload.prompt = question.prompt;
  }
  else {
    const code = randomCode_();
    issued.answers = [code];
    payload.code = code;
  }

  cache.put('challenge:' + nonce, JSON.stringify(issued), CHALLENGE_TTL_SECONDS);
  return jsonOutput_(payload);
}

function randomCode_ () {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET.charAt(Math.floor(Math.random() * CODE_ALPHABET.length));
  }
  return code;
}

function textQuestion_ () {
  // Must reach the largest sum the operands below can make, or that answer
  // has no word form and only the digits are accepted.
  const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
                 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
                 'seventeen', 'eighteen', 'nineteen', 'twenty'];

  switch (Math.floor(Math.random() * 3)) {
    case 0: {
      const a = 2 + Math.floor(Math.random() * 6);
      const b = 2 + Math.floor(Math.random() * 5);
      return {
        prompt: 'What is ' + words[a] + ' plus ' + words[b] + '? Answer in digits or in words.',
        answers: [String(a + b), words[a + b]]
      };
    }
    case 1: {
      const pool = ['camera', 'sensor', 'mapping', 'robot', 'vision', 'lidar'];
      const chosen = [];
      while (chosen.length < 3) {
        const word = pool[Math.floor(Math.random() * pool.length)];
        if (chosen.indexOf(word) === -1) {
          chosen.push(word);
        }
      }
      const index = Math.floor(Math.random() * 3);
      return {
        prompt: 'Type the ' + ['first', 'second', 'third'][index] + ' word of this list: ' + chosen.join(', ') + '.',
        answers: [chosen[index]]
      };
    }
    default: {
      const colours = ['red', 'green', 'blue', 'yellow'];
      const missing = Math.floor(Math.random() * colours.length);
      const shown = colours.filter(function (ignored, i) { return i !== missing; });
      return {
        prompt: 'Three of our four colours are ' + shown.join(', ') +
                '. Type the missing one: red, green, blue or yellow.',
        answers: [colours[missing]]
      };
    }
  }
}

// --- Submission ---

function doPost (e) {
  const lock = LockService.getScriptLock();
  lock.tryLock(10000);

  try {
    const parameters = (e && e.parameter) || {};
    const cache = CacheService.getScriptCache();

    const onFailure = failureMode_();

    // The honeypot is a field no person can see, focus or tab to. Anything in
    // it came from a script filling in every input it found. It is answered
    // exactly as a success is, so the sender never learns which field gave it
    // away - that stays true whatever ON_CHALLENGE_FAILURE is set to.
    const gate = singleLine_(parameters.Fax || '') !== ''
      ? { ok: false, status: 'honeypot', message: '', silent: true }
      : { ok: true, status: 'passed', message: '', silent: false };

    if (!gate.ok && onFailure === 'reject') {
      return jsonOutput_({ result: 'success', row: 0 });
    }

    const name = cleanText_(parameters.Name, 200);
    const email = singleLine_(cleanText_(parameters.Email, 254));
    const company = cleanText_(parameters.Company, 200);
    const message = cleanText_(parameters.Message, MAX_FIELD_LENGTH);

    const missingFields = [];
    if (name === '') { missingFields.push('Name'); }
    if (email === '') { missingFields.push('Email'); }
    if (message === '') { missingFields.push('Message'); }
    if (missingFields.length > 0) {
      return jsonOutput_({ result: 'error', error: 'Missing required fields: ' + missingFields.join(', ') });
    }

    if (!isEmailAddress_(email)) {
      return jsonOutput_({ result: 'error', error: 'That email address does not look valid.' });
    }

    if (gate.ok) {
      const verdict = checkChallenge_(cache, parameters.captchaNonce, parameters.captchaResponse);
      if (verdict !== null) {
        gate.ok = false;
        gate.status = 'failed: ' + verdict.status;
        gate.message = verdict.message;
      }
      if (!gate.ok && onFailure === 'reject') {
        return jsonOutput_({ result: 'challenge', error: gate.message });
      }
    }

    // The same message from the same sender within the hour is a double
    // submit, not a second enquiry. Report success without storing it again.
    const fingerprint = 'seen:' + digest_(email.toLowerCase() + '\n' + message);
    if (cache.get(fingerprint) !== null) {
      return jsonOutput_({ result: 'success', row: 0 });
    }

    if (countInHour_(cache, 'sender:' + digest_(email.toLowerCase()), MAX_PER_SENDER_PER_HOUR) === null) {
      return jsonOutput_({
        result: 'error',
        error: 'You have already sent us a few messages, please give us a chance to reply.'
      });
    }
    if (countInHour_(cache, 'accepted', MAX_SUBMISSIONS_PER_HOUR) === null) {
      return jsonOutput_({
        result: 'error',
        error: 'We are getting an unusual number of messages, please try again later or email us directly.'
      });
    }

    const flags = [];
    const score = spamScore_(name, email, company, message, flags);
    const suspect = score >= SPAM_SCORE_LIMIT;

    const doc = SpreadsheetApp.openById(scriptProp.getProperty('key'));
    const sheet = doc.getSheetByName(SHEET_NAME);
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const nextRow = sheet.getLastRow() + 1;

    const known = {
      'Date': new Date(),
      'Name': name,
      'Email': email,
      'Company': company,
      'Message': message,
      'Spam Score': score,
      'Flags': flags.join(' '),
      'Captcha': gate.ok ? gate.status : gate.status + ' [delivered anyway]'
    };

    const newRow = headers.map(function (header) {
      if (Object.prototype.hasOwnProperty.call(known, header)) {
        const value = known[header];
        if (value instanceof Date || typeof value === 'number') {
          return value;
        }
        return cellSafe_(String(value));
      }
      // Any column added later still gets cleaned before it is written.
      return cellSafe_(cleanText_(parameters[header], MAX_FIELD_LENGTH));
    });

    sheet.getRange(nextRow, 1, 1, newRow.length).setValues([newRow]);
    if (gate.ok) {
      cache.put(fingerprint, '1', 3600);
    }

    notify_(name, email, company, message, nextRow, score, flags, suspect, gate);

    if (!gate.ok && onFailure === 'record') {
      return gate.silent
        ? jsonOutput_({ result: 'success', row: nextRow })
        : jsonOutput_({ result: 'challenge', error: gate.message });
    }

    return jsonOutput_({ result: 'success', row: nextRow });
  }

  catch (error) {
    return jsonOutput_({ result: 'error', error: error.message });
  }

  finally {
    lock.releaseLock();
  }
}

// Returns null when the challenge is good, otherwise { status, message }:
// status for the Captcha column, message for the sender. The nonce is spent
// either way, so a wrong answer cannot be retried against the same challenge
// and a captured submission cannot be replayed.
function checkChallenge_ (cache, nonce, response) {
  const key = 'challenge:' + singleLine_(String(nonce || ''));
  const raw = nonce ? cache.get(key) : null;

  if (raw === null) {
    if (!REQUIRE_CHALLENGE) {
      return null;
    }
    return {
      status: nonce ? 'expired or unknown nonce' : 'no nonce',
      message: 'The human check expired. Here is a new one.'
    };
  }

  cache.remove(key);

  const issued = JSON.parse(raw);
  if (Date.now() - issued.at < MIN_FILL_SECONDS * 1000) {
    return {
      status: 'answered too fast',
      message: 'That was answered faster than it can be read. Here is a new one.'
    };
  }

  const given = String(response === undefined || response === null ? '' : response)
    .replace(/\s+/g, '').toUpperCase();
  if (given === '') {
    return { status: 'no answer', message: 'Please answer the human check.' };
  }

  const matched = issued.answers.some(function (answer) {
    return String(answer).replace(/\s+/g, '').toUpperCase() === given;
  });

  return matched ? null : {
    status: 'wrong answer',
    message: 'That did not match. Here is a new one.'
  };
}

// Reads ON_CHALLENGE_FAILURE defensively: only the two values that loosen the
// gate are honoured, so a misspelling leaves it shut.
function failureMode_ () {
  return (ON_CHALLENGE_FAILURE === 'record' || ON_CHALLENGE_FAILURE === 'accept')
    ? ON_CHALLENGE_FAILURE
    : 'reject';
}

// --- Notification ---

function notify_ (name, email, company, message, row, score, flags, suspect, gate) {
  // Plain text, never htmlBody. A text/plain part has nothing that can run and
  // no way to reference a remote image, so there is no script to strip and no
  // tracking pixel to block: the format rules both out rather than filtering
  // for them, which is the only version of this that stays correct.
  const lines = [
    'New message from the Polytopy contact form.',
    '',
    'Name:    ' + singleLine_(name),
    'Email:   ' + email,
    'Company: ' + (singleLine_(company) || '-'),
    'Sheet:   row ' + row
  ];

  if (!gate.ok) {
    lines.push('Captcha: ' + gate.status + ', delivered because ON_CHALLENGE_FAILURE is set to ' + failureMode_());
  }
  if (suspect) {
    lines.push('Flags:   suspected spam, score ' + score + ' (' + flags.join(' ') + ')');
  }

  lines.push('', '--- message ---', suspect ? defang_(message) : message, '--- end ---');

  const subject = (gate.ok ? '' : '[check failed] ') + (suspect ? '[possible spam] ' : '') +
    'Contact form: ' + (singleLine_(name).slice(0, 60) || 'no name');

  // Reply-To only once the address has been validated, so a crafted value
  // cannot steer a reply somewhere else.
  const options = { name: 'Polytopy Contact Form' };
  if (isEmailAddress_(email)) {
    options.replyTo = email;
  }

  GmailApp.sendEmail(NOTIFY_ADDRESS, subject, lines.join('\n'), options);
}

// --- Cleaning ---

// Strips what could execute, hide itself, or disguise what it says once it
// lands in a cell or a mail body, and caps the length.
function cleanText_ (value, maxLength) {
  let text = String(value === undefined || value === null ? '' : value);

  if (text.normalize) {
    text = text.normalize('NFC');
  }

  text = text.replace(/\r\n?/g, '\n');
  // C0 and C1 control characters, keeping tab and newline.
  text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '');
  // Zero width characters, bidirectional overrides and the byte order mark:
  // all invisible, all usable to make a line read as something it is not.
  text = text.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g, '');
  text = text.replace(/[ \t]+\n/g, '\n');
  text = text.replace(/\n{4,}/g, '\n\n\n');

  if (text.length > maxLength) {
    text = text.slice(0, maxLength) + '\n[truncated]';
  }

  return text.trim();
}

function singleLine_ (value) {
  return String(value === undefined || value === null ? '' : value).replace(/\s+/g, ' ').trim();
}

// A cell whose text starts with =, +, - or @ is a live formula. =IMPORTXML or
// =IMAGE fetches a URL of the sender's choosing every time the sheet is
// opened, which is both a tracker and a way out for the data sitting beside
// it. A leading apostrophe tells Sheets to keep the value as text.
function cellSafe_ (text) {
  return /^[=+\-@\t\r]/.test(text) ? "'" + text : text;
}

// Breaks the links in a message already judged to be spam, so a stray click in
// the notification cannot reach them.
function defang_ (text) {
  return text
    .replace(/\bhttps?:\/\//gi, function (match) { return match.replace(/^http/i, 'hxxp'); })
    .replace(/\bwww\./gi, 'www[.]');
}

function isEmailAddress_ (value) {
  return value.length <= 254 &&
    /^[^\s@<>,;:"'()\[\]\\]+@[^\s@<>,;:"'()\[\]\\]+\.[A-Za-z]{2,}$/.test(value);
}

// --- Scoring and counting ---

// Fuzzy signals only, so they never reject on their own: they decide whether
// the subject line carries a warning and whether the links get broken.
function spamScore_ (name, email, company, message, flags) {
  let score = 0;
  const add = function (points, flag) {
    score += points;
    flags.push(flag);
  };

  const links = (message.match(/\b(?:https?:\/\/|www\.)\S+/gi) || []).length;
  if (links >= 2) {
    add(links - 1, 'links:' + links);
  }
  if (/\[url[=\]]|\[link[=\]]|<a\s|<script|href\s*=/i.test(message)) {
    add(3, 'markup');
  }
  if (/\b(seo|backlinks?|link building|guest post|casino|viagra|escort service|binary options)\b/i.test(message)) {
    add(2, 'phrases');
  }
  if (message.length < 25) {
    add(1, 'short');
  }
  if (!/[a-z]/.test(message)) {
    add(1, 'nolowercase');
  }
  if (/(.)\1{9,}/.test(message)) {
    add(1, 'repetition');
  }
  if (singleLine_(name).toLowerCase() === singleLine_(message).toLowerCase()) {
    add(2, 'nameismessage');
  }
  if (singleLine_(company).length > 120) {
    add(1, 'longcompany');
  }

  return score;
}

// Counts one event in the current hour. Returns the new count, or null when
// the limit has already been reached.
function countInHour_ (cache, bucket, limit) {
  const key = 'count:' + bucket + ':' + Math.floor(Date.now() / 3600000);
  const current = Number(cache.get(key) || 0);
  if (current >= limit) {
    return null;
  }
  cache.put(key, String(current + 1), 3600);
  return current + 1;
}

function digest_ (value) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value)
    .map(function (byte) {
      return ((byte & 0xFF) + 0x100).toString(16).slice(1);
    })
    .join('')
    .slice(0, 32);
}

function jsonOutput_ (payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
