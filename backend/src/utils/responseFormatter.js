function successResponse(res, data = {}, statusCode = 200) {
  return res.status(statusCode).json({
    success: true,
    data,
  });
}

function paginatedResponse(res, data, page, limit, total, statusCode = 200) {
  return res.status(statusCode).json({
    success: true,
    data,
    page: parseInt(page, 10),
    limit: parseInt(limit, 10),
    total: parseInt(total, 10),
  });
}

function errorResponse(res, error, statusCode = 500) {
  const code = error.code || 'INTERNAL_ERROR';
  const message = error.message || 'Internal Server Error';
  
  return res.status(error.statusCode || statusCode).json({
    success: false,
    code,
    message,
  });
}

module.exports = {
  successResponse,
  paginatedResponse,
  errorResponse,
};
