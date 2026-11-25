// The participant page served when the app itself cannot be served (page load or
// restore failed). It carries the same neutral sentence as app.js STOPPED and never
// an error code; the cause stays in the server's own handling.
export const PARTICIPANT_STOP_TEXT = '進行を確認できません。実験担当者にお知らせください。';
export const PARTICIPANT_STOP_HTML = '<!doctype html><html lang="ja"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1"><title>6図形の共同命名</title></head>' +
  '<body><main><p role="alert">' + PARTICIPANT_STOP_TEXT + '</p></main></body></html>';
