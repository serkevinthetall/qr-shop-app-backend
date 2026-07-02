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

export function getPhoneDigits(phone) {
  return normalizePhone(phone).replace(/\D/g, "");
}

export function phonesMatch(left, right) {
  const leftDigits = getPhoneDigits(left);
  const rightDigits = getPhoneDigits(right);

  if (!leftDigits || !rightDigits) {
    return false;
  }

  if (leftDigits === rightDigits) {
    return true;
  }

  const leftTail = leftDigits.slice(-9);
  const rightTail = rightDigits.slice(-9);

  return leftTail.length >= 7 && leftTail === rightTail;
}

export function getPhoneSearchTail(phone) {
  const digits = getPhoneDigits(phone);

  if (digits.length >= 9) {
    return digits.slice(-9);
  }

  return digits;
}