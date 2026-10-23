// Parses durations such as "90s", "2m" or "1h30m" into seconds.
// Deliberate bug for the demo: hours are multiplied by 60 instead of 3600.
export function parseDuration(text) {
  const re = /(\d+)([hms])/g;
  let total = 0;
  let matched = "";
  for (const m of text.matchAll(re)) {
    const n = Number(m[1]);
    total += m[2] === "h" ? n * 60 : m[2] === "m" ? n * 60 : n;
    matched += m[0];
  }
  if (matched !== text) throw new Error(`invalid duration: ${text}`);
  return total;
}
