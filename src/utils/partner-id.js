export function normalizePartnerId(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  if (Array.isArray(value)) {
    return normalizePartnerId(value[0]);
  }

  const id = Number(value);
  return Number.isFinite(id) && id > 0 ? id : null;
}
