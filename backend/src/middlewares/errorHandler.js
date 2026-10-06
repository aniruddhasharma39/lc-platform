const { errorResponse } = require('../utils/responseFormatter');

function errorHandler(err, req, res, next) {
  console.error(err.stack);
  return errorResponse(res, err);
}

module.exports = errorHandler;
