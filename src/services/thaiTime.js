// Every DATETIME2 timestamp in the database is stored as THAI wall-clock time
// (Asia/Bangkok, a fixed UTC+07:00 — Thailand dropped DST in 1976), written by
// SQL as DATEADD(HOUR, 7, SYSUTCDATETIME()) so the host's timezone never
// matters. See database/patch_thai_time.sql.
//
// mssql reads DATETIME2 with useUTC, so such a value comes back as a Date whose
// UTC fields ARE the Thai clock. To compare one against "now" in JS, compare it
// with thaiWallNow(), which is shifted the same way — never with Date.now().

const THAI_OFFSET_MS = 7 * 60 * 60 * 1000;

function thaiWallNow(now = Date.now()) {
  return new Date(now + THAI_OFFSET_MS);
}

module.exports = { THAI_OFFSET_MS, thaiWallNow };
