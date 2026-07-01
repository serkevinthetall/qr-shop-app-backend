export function normalizePhone(phone) {
  let p = String(phone || "").trim();

  p = p.replace(/\s+/g, "");
  p = p.replace(/-/g, "");

  if (p.startsWith("+959")) p = "09" + p.slice(4);
  else if (p.startsWith("959")) p = "09" + p.slice(3);
  else if (p.startsWith("+9509")) p = "09" + p.slice(5);
  else if (p.startsWith("9509")) p = "09" + p.slice(4);

  return p;
}