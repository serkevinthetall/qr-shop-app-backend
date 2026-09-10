/**
 * Never send raw Odoo / upstream messages to mobile clients.
 * Log server-side; return only a stable code to the client when needed.
 */
export function logServerError(label, err) {
  const detail =
    err?.response?.data?.message ||
    err?.response?.data?.error ||
    err?.response?.data ||
    err?.message ||
    err;
  console.error(label, detail);
}

export function clientErrorCode(code = "INTERNAL_ERROR") {
  return { code };
}
