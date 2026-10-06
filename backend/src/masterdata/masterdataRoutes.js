const express = require('express');
const GenericRepository = require('../utils/GenericRepository');
const createCrudRouter = require('../utils/crudRouter');

const router = express.Router();

const tables = [
  'zones',
  'divisions',
  'sections',
  'stations',
  'level_crossings'
];

tables.forEach(table => {
  const repo = new GenericRepository(table);
  router.use(`/${table}`, createCrudRouter(repo, table));
});

module.exports = router;
