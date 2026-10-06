const express = require('express');
const { successResponse } = require('../utils/responseFormatter');
const { authenticate, authorize } = require('../middlewares/auth');

function createCrudRouter(repository, resourceName) {
  const router = express.Router();
  
  // E.g., masterdata:view
  const viewPerm = 'masterdata:view';
  const createPerm = 'masterdata:create';
  const updatePerm = 'masterdata:update';
  const deletePerm = 'masterdata:delete';

  router.use(authenticate);

  router.get('/', authorize(viewPerm), async (req, res, next) => {
    try {
      const data = await repository.findAll();
      return successResponse(res, data);
    } catch (error) { next(error); }
  });

  router.get('/:id', authorize(viewPerm), async (req, res, next) => {
    try {
      const data = await repository.findById(req.params.id);
      return successResponse(res, data);
    } catch (error) { next(error); }
  });

  router.post('/', authorize(createPerm), async (req, res, next) => {
    try {
      const data = await repository.create(req.body);
      return successResponse(res, data, 201);
    } catch (error) { next(error); }
  });

  router.put('/:id', authorize(updatePerm), async (req, res, next) => {
    try {
      const data = await repository.update(req.params.id, req.body);
      return successResponse(res, data);
    } catch (error) { next(error); }
  });

  router.delete('/:id', authorize(deletePerm), async (req, res, next) => {
    try {
      await repository.delete(req.params.id);
      return successResponse(res, { message: 'Deleted successfully' });
    } catch (error) { next(error); }
  });

  return router;
}

module.exports = createCrudRouter;
