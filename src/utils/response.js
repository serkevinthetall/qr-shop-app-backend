export function success(res, data = {}, status = 200) {
  return res.status(status).json({
    success: true,
    ...data,
  });
}

export function error(res, message = "Something went wrong", status = 500, details = null) {
  return res.status(status).json({
    success: false,
    message,
    ...(details ? { details } : {}),
  });
}