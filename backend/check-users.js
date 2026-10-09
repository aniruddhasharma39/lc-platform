const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
prisma.user.findMany().then(users => {
  console.log(users);
  prisma.$disconnect();
}).catch(e => {
  console.error(e);
  process.exit(1);
});
